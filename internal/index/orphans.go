package index

import (
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
)

// Orphan is a non-note file that no note links to or embeds.
type Orphan struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // unix ms
}

// Orphans lists attachments (any non-note file) that no note references.
//
// A file counts as referenced if any link in any note resolves to it, or —
// erring on the side of keeping files — if its name appears anywhere in a
// note's text. That catches references the link parser doesn't understand,
// such as HTML <img src>, links inside code, or front-matter fields.
func (ix *Index) Orphans() []Orphan {
	ix.mu.RLock()
	v := ix.view()
	used := map[string]bool{}
	for from, e := range ix.files {
		for _, l := range e.links {
			if to := Resolve(l, from, v.exists, v.names); to != "" {
				used[to] = true
			}
		}
	}
	var cands []string
	for p := range ix.other {
		if !used[p] && orphanCandidate(p) && !ix.mentioned(p) {
			cands = append(cands, p)
		}
	}
	ix.mu.RUnlock()

	out := make([]Orphan, 0, len(cands))
	for _, p := range cands {
		abs, err := ix.v.Abs(p)
		if err != nil {
			continue
		}
		st, err := os.Stat(abs)
		if err != nil || st.IsDir() {
			continue
		}
		out = append(out, Orphan{Path: p, Size: st.Size(), Mtime: st.ModTime().UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// orphanCandidate excludes files that are documents or config in their own
// right rather than attachments: dotfiles and Obsidian canvases/bases.
func orphanCandidate(p string) bool {
	if strings.HasPrefix(path.Base(p), ".") {
		return false
	}
	switch strings.ToLower(path.Ext(p)) {
	case ".canvas", ".base":
		return false
	}
	return true
}

// mentioned reports whether any note's text contains p's file name, as
// written or URL-escaped. Caller must hold ix.mu.
func (ix *Index) mentioned(p string) bool {
	name := strings.ToLower(path.Base(p))
	forms := []string{name}
	if esc := strings.ToLower(url.PathEscape(name)); esc != name {
		forms = append(forms, esc)
	}
	if sp := strings.ReplaceAll(name, " ", "%20"); sp != name && sp != forms[len(forms)-1] {
		forms = append(forms, sp)
	}
	for _, e := range ix.files {
		for _, f := range forms {
			if strings.Contains(e.lower, f) {
				return true
			}
		}
	}
	return false
}
