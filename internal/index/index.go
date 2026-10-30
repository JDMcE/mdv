// Package index keeps every note in memory for fast search, and watches the
// vault so the index and connected clients stay in sync with the disk.
package index

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"mdv/internal/vault"
)

type entry struct {
	content string
	lower   string // lowercased content, for cheap case-insensitive prefiltering
	mtime   int64
	links   []Link
}

// Event is broadcast to clients when the vault changes on disk.
type Event struct {
	Type  string `json:"type"` // "change" | "remove" | "tree"
	Path  string `json:"path,omitempty"`
	Mtime int64  `json:"mtime,omitempty"`
}

type Index struct {
	v *vault.Vault

	mu    sync.RWMutex
	files map[string]*entry   // notes
	other map[string]struct{} // every other file (images, PDFs…), for link resolution

	subMu sync.Mutex
	subs  map[chan Event]struct{}
}

func IsNote(p string) bool {
	return strings.EqualFold(filepath.Ext(p), ".md")
}

func New(v *vault.Vault) *Index {
	ix := &Index{v: v, files: map[string]*entry{}, other: map[string]struct{}{}, subs: map[chan Event]struct{}{}}
	start := time.Now()
	// Reading is I/O-bound (and slowed further by AV scanners on Windows),
	// so load files concurrently.
	jobs := make(chan string, 256)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				ix.load(p)
			}
		}()
	}
	filepath.WalkDir(v.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != v.Root && vault.Ignored(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if IsNote(p) {
			jobs <- p
		} else {
			ix.add(p)
		}
		return nil
	})
	close(jobs)
	wg.Wait()
	log.Printf("indexed %d notes in %v", len(ix.files), time.Since(start).Round(time.Millisecond))
	return ix
}

// load (re)reads a note from disk. Returns false if it's unchanged or gone.
func (ix *Index) load(abs string) bool {
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		return false
	}
	rel := ix.v.Rel(abs)
	mtime := st.ModTime().UnixMilli()
	ix.mu.RLock()
	old := ix.files[rel]
	ix.mu.RUnlock()
	if old != nil && old.mtime == mtime {
		return false
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return false
	}
	s := string(b)
	ix.mu.Lock()
	ix.files[rel] = &entry{content: s, lower: strings.ToLower(s), mtime: mtime, links: ParseLinks(s)}
	ix.mu.Unlock()
	return true
}

// add indexes any file: notes are loaded, others just recorded.
func (ix *Index) add(abs string) {
	if IsNote(abs) {
		ix.load(abs)
		return
	}
	if strings.HasPrefix(filepath.Base(abs), ".mdv-") {
		return
	}
	ix.mu.Lock()
	ix.other[ix.v.Rel(abs)] = struct{}{}
	ix.mu.Unlock()
}

func (ix *Index) drop(rel string) {
	ix.mu.Lock()
	for p := range ix.files {
		if p == rel || strings.HasPrefix(p, rel+"/") {
			delete(ix.files, p)
		}
	}
	for p := range ix.other {
		if p == rel || strings.HasPrefix(p, rel+"/") {
			delete(ix.other, p)
		}
	}
	ix.mu.Unlock()
}

// Paths returns all indexed note paths.
func (ix *Index) Paths() []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]string, 0, len(ix.files))
	for p := range ix.files {
		out = append(out, p)
	}
	return out
}

// Subscribe returns a channel of vault events; call the cancel func when done.
func (ix *Index) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	ix.subMu.Lock()
	ix.subs[ch] = struct{}{}
	ix.subMu.Unlock()
	return ch, func() {
		ix.subMu.Lock()
		delete(ix.subs, ch)
		ix.subMu.Unlock()
	}
}

func (ix *Index) publish(e Event) {
	ix.subMu.Lock()
	defer ix.subMu.Unlock()
	for ch := range ix.subs {
		select {
		case ch <- e:
		default: // slow client; it will resync on reconnect
		}
	}
}

// Watch follows filesystem changes until the process exits.
func (ix *Index) Watch() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	addTree := func(root string) {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || !d.IsDir() {
				return nil
			}
			if p != ix.v.Root && vault.Ignored(d.Name()) {
				return filepath.SkipDir
			}
			if err := w.Add(p); err != nil {
				log.Printf("watch %s: %v", p, err)
			}
			return nil
		})
	}
	addTree(ix.v.Root)

	go func() {
		// Structural changes are coalesced into a single "tree" event.
		var treeTimer *time.Timer
		treeChanged := func() {
			if treeTimer != nil {
				treeTimer.Stop()
			}
			treeTimer = time.AfterFunc(150*time.Millisecond, func() { ix.publish(Event{Type: "tree"}) })
		}
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				ix.handle(ev, addTree, treeChanged)
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				log.Printf("watch error: %v", err)
			}
		}
	}()
	return nil
}

func (ix *Index) handle(ev fsnotify.Event, addTree func(string), treeChanged func()) {
	rel := ix.v.Rel(ev.Name)
	for _, part := range strings.Split(rel, "/") {
		if vault.Ignored(part) {
			return
		}
	}
	base := filepath.Base(ev.Name)
	if strings.HasPrefix(base, ".mdv-") { // our own temp files
		return
	}
	switch {
	case ev.Has(fsnotify.Create):
		if st, err := os.Stat(ev.Name); err == nil && st.IsDir() {
			addTree(ev.Name)
			// Files may have landed before the watch was added.
			filepath.WalkDir(ev.Name, func(p string, d fs.DirEntry, err error) error {
				if err == nil && !d.IsDir() {
					ix.add(p)
				}
				return nil
			})
			treeChanged()
		} else if IsNote(ev.Name) && ix.mtime(rel) != 0 {
			// Existing note replaced via rename (atomic save): a content change.
			if ix.load(ev.Name) {
				ix.publish(Event{Type: "change", Path: rel, Mtime: ix.mtime(rel)})
			}
		} else {
			ix.add(ev.Name)
			treeChanged()
		}
	case ev.Has(fsnotify.Write):
		if IsNote(ev.Name) && ix.load(ev.Name) {
			ix.publish(Event{Type: "change", Path: rel, Mtime: ix.mtime(rel)})
		}
	case ev.Has(fsnotify.Remove), ev.Has(fsnotify.Rename):
		ix.drop(rel)
		ix.publish(Event{Type: "remove", Path: rel})
		treeChanged()
	}
}

func (ix *Index) mtime(rel string) int64 {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if e := ix.files[rel]; e != nil {
		return e.mtime
	}
	return 0
}

// Refresh re-reads a single path after the server itself changed it, so
// searches see the new content without waiting for the watcher.
func (ix *Index) Refresh(rel string) {
	abs, err := ix.v.Abs(rel)
	if err != nil {
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		ix.drop(rel)
		return
	}
	if !st.IsDir() {
		ix.add(abs)
		return
	}
	filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && IsNote(p) {
			ix.load(p)
		}
		return nil
	})
}

// Under lists every indexed file (notes and others) at or below rel.
func (ix *Index) Under(rel string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	var out []string
	match := func(p string) bool { return p == rel || strings.HasPrefix(p, rel+"/") }
	for p := range ix.files {
		if match(p) {
			out = append(out, p)
		}
	}
	for p := range ix.other {
		if match(p) {
			out = append(out, p)
		}
	}
	return out
}

// Content returns a note's indexed content.
func (ix *Index) Content(rel string) (string, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	e, ok := ix.files[rel]
	if !ok {
		return "", false
	}
	return e.content, true
}
