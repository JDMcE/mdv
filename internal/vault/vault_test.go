package vault

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAbsSandbox(t *testing.T) {
	v, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ok := map[string]string{
		"a.md":             "a.md",
		"dir/b.md":         "dir/b.md",
		"../../etc/passwd": "etc/passwd", // clamped inside the vault
		"/abs/c.md":        "abs/c.md",
		`dir\win.md`:       "dir/win.md",
	}
	for in, want := range ok {
		abs, err := v.Abs(in)
		if err != nil {
			t.Errorf("Abs(%q): %v", in, err)
			continue
		}
		if got := v.Rel(abs); got != want {
			t.Errorf("Abs(%q) -> %q, want %q", in, got, want)
		}
	}
	for _, in := range []string{".git/config", "x/.obsidian/app.json", ".trash/a.md"} {
		if _, err := v.Abs(in); !errors.Is(err, ErrOutside) {
			t.Errorf("Abs(%q) should be rejected, got %v", in, err)
		}
	}
}

func TestWriteConflict(t *testing.T) {
	v, _ := New(t.TempDir())
	m1, err := v.Write("n.md", "one", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write("n.md", "two", m1+1); !errors.Is(err, ErrConflict) {
		t.Errorf("stale write: got %v, want ErrConflict", err)
	}
	if _, err := v.Write("n.md", "two", m1); err != nil {
		t.Errorf("fresh write: %v", err)
	}
	f, _ := v.Read("n.md")
	if f.Content != "two" {
		t.Errorf("content = %q", f.Content)
	}
}

func TestDeleteRootRefused(t *testing.T) {
	v, _ := New(t.TempDir())
	for _, p := range []string{"", "/", "..", "."} {
		if err := v.Delete(p); !errors.Is(err, ErrOutside) {
			t.Errorf("Delete(%q) = %v, want ErrOutside", p, err)
		}
	}
}

func TestAttachmentDir(t *testing.T) {
	v, _ := New(t.TempDir())
	if got := v.AttachmentDir("notes/a.md", "attachments"); got != "attachments" {
		t.Errorf("fallback: %q", got)
	}
	os.MkdirAll(filepath.Join(v.Root, ".obsidian"), 0o755)
	for setting, want := range map[string]string{"/": "", "./": "notes", "./img": "notes/img", "Assets/": "Assets"} {
		os.WriteFile(filepath.Join(v.Root, ".obsidian", "app.json"), []byte(`{"attachmentFolderPath":"`+setting+`"}`), 0o644)
		if got := v.AttachmentDir("notes/a.md", "attachments"); got != want {
			t.Errorf("setting %q: got %q want %q", setting, got, want)
		}
	}
}

func TestUniqueName(t *testing.T) {
	v, _ := New(t.TempDir())
	if got := v.UniqueName("img", "a.png"); got != "img/a.png" {
		t.Errorf("free name: %q", got)
	}
	v.WriteNew("img/a.png", strings.NewReader("x"))
	v.WriteNew("img/a 1.png", strings.NewReader("x"))
	if got := v.UniqueName("img", "a.png"); got != "img/a 2.png" {
		t.Errorf("taken name: %q", got)
	}
	if got := v.UniqueName("", "b.png"); got != "b.png" {
		t.Errorf("root: %q", got)
	}
	if err := v.WriteNew("img/a.png", strings.NewReader("y")); !errors.Is(err, ErrExists) {
		t.Errorf("overwrite allowed: %v", err)
	}
}
