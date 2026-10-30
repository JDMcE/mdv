// Package vault provides sandboxed access to a folder of markdown notes.
package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

var (
	ErrOutside  = errors.New("path escapes vault")
	ErrConflict = errors.New("file changed on disk")
	ErrExists   = errors.New("already exists")
)

// Ignored directory names, never shown or indexed.
var ignored = map[string]bool{
	".git": true, ".obsidian": true, ".trash": true, "node_modules": true,
	".mdv": true, // mdv's own per-vault data (settings)
}

// Ignored reports whether a file or directory name is hidden from the app.
func Ignored(name string) bool { return ignored[name] }

type Vault struct {
	Root string
}

func New(root string) (*Vault, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	return &Vault{Root: abs}, nil
}

// Abs maps a vault-relative slash path to an absolute OS path, rejecting
// anything that would land outside the vault or inside an ignored dir.
func (v *Vault) Abs(rel string) (string, error) {
	clean := path.Clean("/" + strings.ReplaceAll(rel, "\\", "/"))
	for _, part := range strings.Split(clean, "/") {
		if ignored[part] {
			return "", ErrOutside
		}
	}
	abs := filepath.Join(v.Root, filepath.FromSlash(clean))
	if abs != v.Root && !strings.HasPrefix(abs, v.Root+string(filepath.Separator)) {
		return "", ErrOutside
	}
	return abs, nil
}

// Rel converts an absolute OS path back to a vault-relative slash path.
func (v *Vault) Rel(abs string) string {
	r, _ := filepath.Rel(v.Root, abs)
	return filepath.ToSlash(r)
}

type Node struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Dir      bool    `json:"dir,omitempty"`
	Mtime    int64   `json:"mtime,omitempty"` // unix ms, files only
	Children []*Node `json:"children,omitempty"`
}

// Tree returns the vault hierarchy: folders first, then files, alphabetical.
func (v *Vault) Tree() (*Node, error) {
	root := &Node{Name: filepath.Base(v.Root), Path: "", Dir: true}
	dirs := map[string]*Node{".": root}
	err := filepath.WalkDir(v.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == v.Root {
			return nil
		}
		if ignored[d.Name()] || strings.HasPrefix(d.Name(), ".mdv-") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel := v.Rel(p)
		n := &Node{Name: d.Name(), Path: rel, Dir: d.IsDir()}
		if !n.Dir {
			if info, err := d.Info(); err == nil {
				n.Mtime = info.ModTime().UnixMilli()
			}
		}
		if n.Dir {
			n.Children = []*Node{}
			dirs[rel] = n
		}
		if parent := dirs[path.Dir(rel)]; parent != nil {
			parent.Children = append(parent.Children, n)
		}
		return nil
	})
	sortTree(root)
	return root, err
}

func sortTree(n *Node) {
	sort.Slice(n.Children, func(i, j int) bool {
		a, b := n.Children[i], n.Children[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	for _, c := range n.Children {
		if c.Dir {
			sortTree(c)
		}
	}
}

type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mtime   int64  `json:"mtime"` // unix milliseconds
}

func (v *Vault) Read(rel string) (*File, error) {
	abs, err := v.Abs(rel)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	return &File{Path: v.Rel(abs), Content: string(b), Mtime: st.ModTime().UnixMilli()}, nil
}

// Write saves content atomically. If expectMtime is non-zero and the file on
// disk has a different mtime, ErrConflict is returned and nothing is written.
func (v *Vault) Write(rel, content string, expectMtime int64) (int64, error) {
	abs, err := v.Abs(rel)
	if err != nil {
		return 0, err
	}
	if expectMtime != 0 {
		if st, err := os.Stat(abs); err == nil && st.ModTime().UnixMilli() != expectMtime {
			return 0, ErrConflict
		}
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".mdv-*.tmp")
	if err != nil {
		return 0, err
	}
	_, werr := tmp.WriteString(content)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return 0, errors.Join(werr, cerr)
	}
	if err := os.Rename(tmp.Name(), abs); err != nil {
		os.Remove(tmp.Name())
		return 0, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return 0, err
	}
	return st.ModTime().UnixMilli(), nil
}

// Create makes a new empty file, failing if it already exists.
func (v *Vault) Create(rel string) error {
	abs, err := v.Abs(rel)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err == nil {
		return ErrExists
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	return os.WriteFile(abs, nil, 0o644)
}

func (v *Vault) Mkdir(rel string) error {
	abs, err := v.Abs(rel)
	if err != nil {
		return err
	}
	return os.MkdirAll(abs, 0o755)
}

func (v *Vault) Delete(rel string) error {
	abs, err := v.Abs(rel)
	if err != nil {
		return err
	}
	if abs == v.Root {
		return ErrOutside
	}
	return os.RemoveAll(abs)
}

func (v *Vault) Move(from, to string) error {
	a, err := v.Abs(from)
	if err != nil {
		return err
	}
	b, err := v.Abs(to)
	if err != nil {
		return err
	}
	if a == v.Root || b == v.Root {
		return ErrOutside
	}
	if _, err := os.Stat(b); err == nil {
		return ErrExists
	}
	if err := os.MkdirAll(filepath.Dir(b), 0o755); err != nil {
		return err
	}
	return os.Rename(a, b)
}

// AttachmentDir decides where a pasted/dropped file for a note goes. It honours
// Obsidian's "attachmentFolderPath" setting when the vault has one:
// "/" is the vault root, "./" the note's folder, "./x" a subfolder of it, and
// anything else a vault-relative folder. Otherwise fallback is used the same way.
func (v *Vault) AttachmentDir(note, fallback string) string {
	setting := fallback
	if b, err := os.ReadFile(filepath.Join(v.Root, ".obsidian", "app.json")); err == nil {
		var cfg struct {
			AttachmentFolderPath *string `json:"attachmentFolderPath"`
		}
		if json.Unmarshal(b, &cfg) == nil && cfg.AttachmentFolderPath != nil {
			setting = *cfg.AttachmentFolderPath
		}
	}
	noteDir := path.Dir(note)
	if noteDir == "." {
		noteDir = ""
	}
	switch {
	case setting == "" || setting == "/":
		return ""
	case setting == "." || setting == "./":
		return noteDir
	case strings.HasPrefix(setting, "./"):
		return strings.TrimPrefix(path.Join(noteDir, setting[2:]), "/")
	default:
		return strings.Trim(setting, "/")
	}
}

// UniqueName returns name, or "name 1.ext", "name 2.ext"… if it's taken in dir.
func (v *Vault) UniqueName(dir, name string) string {
	ext := path.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; ; i++ {
		n := name
		if i > 0 {
			n = fmt.Sprintf("%s %d%s", stem, i, ext)
		}
		rel := path.Join(dir, n)
		abs, err := v.Abs(rel)
		if err != nil {
			return rel
		}
		if _, err := os.Stat(abs); os.IsNotExist(err) {
			return strings.TrimPrefix(rel, "/")
		}
	}
}

// WriteNew writes data to a new file, failing if it exists.
func (v *Vault) WriteNew(rel string, data io.Reader) error {
	abs, err := v.Abs(rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return ErrExists
		}
		return err
	}
	_, werr := io.Copy(f, data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		os.Remove(abs)
		return errors.Join(werr, cerr)
	}
	return nil
}

// SettingsFile is where per-vault app settings are kept (committed with the vault).
func (v *Vault) SettingsFile() string {
	return filepath.Join(v.Root, ".mdv", "settings.json")
}

// ReadSettings returns the stored settings JSON, or "{}" if there are none.
func (v *Vault) ReadSettings() ([]byte, error) {
	b, err := os.ReadFile(v.SettingsFile())
	if errors.Is(err, os.ErrNotExist) {
		return []byte("{}"), nil
	}
	return b, err
}

// WriteSettings stores settings JSON (which must be a JSON object) atomically.
func (v *Vault) WriteSettings(b []byte) error {
	var obj map[string]any
	if err := json.Unmarshal(b, &obj); err != nil {
		return fmt.Errorf("settings must be a JSON object: %w", err)
	}
	pretty, _ := json.MarshalIndent(obj, "", "  ")
	pretty = append(pretty, '\n')
	path := v.SettingsFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-*.tmp")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(pretty)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return errors.Join(werr, cerr)
	}
	return os.Rename(tmp.Name(), path)
}
