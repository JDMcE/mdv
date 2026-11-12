package index

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"mdv/internal/vault"
)

func TestOrphans(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"a.md":                     "![[used.png]] and ![x](attachments/md%20link.png)",
		"sub/b.md":                 "<img src=\"../attachments/html.png\">",
		"c.md":                     "```\n![[in code.png]]\n```",
		"attachments/used.png":     "",
		"attachments/md link.png":  "",
		"attachments/html.png":     "",
		"attachments/in code.png":  "",
		"attachments/orphan.png":   "",
		"attachments/Pasted 1.jpg": "",
		"docs/old.pdf":             "",
		".hidden":                  "",
		"board.canvas":             "{}",
	}
	for p, c := range files {
		abs := filepath.Join(dir, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(abs), 0o755)
		os.WriteFile(abs, []byte(c), 0o644)
	}
	v, _ := vault.New(dir)
	ix := New(v)
	var got []string
	for _, o := range ix.Orphans() {
		got = append(got, o.Path)
	}
	want := []string{"attachments/Pasted 1.jpg", "attachments/orphan.png", "docs/old.pdf"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
}
