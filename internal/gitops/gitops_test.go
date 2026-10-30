package gitops

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFlow(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	g := New(dir, "tester", "t@example.com")
	if g.IsRepo() {
		t.Fatal("fresh dir reported as repo")
	}
	if err := g.Init(); err != nil {
		t.Fatal(err)
	}
	if !g.IsRepo() {
		t.Fatal("not a repo after init")
	}
	os.WriteFile(filepath.Join(dir, "a.md"), []byte("v1"), 0o644)
	st, err := g.Status()
	if err != nil || len(st.Files) != 2 { // a.md + .gitignore
		t.Fatalf("status %+v err %v", st, err)
	}
	if ok, err := g.Commit("first"); !ok || err != nil {
		t.Fatalf("commit: %v %v", ok, err)
	}
	if ok, _ := g.Commit("again"); ok {
		t.Error("empty commit reported as committed")
	}
	os.WriteFile(filepath.Join(dir, "a.md"), []byte("v2"), 0o644)
	g.Commit("")
	log, err := g.Log("a.md", 10)
	if err != nil || len(log) != 2 || log[1].Subject != "first" {
		t.Fatalf("log %+v %v", log, err)
	}
	if !strings.HasPrefix(log[0].Subject, "vault backup:") {
		t.Errorf("default message %q", log[0].Subject)
	}
	old, err := g.Show(log[1].Hash, "a.md")
	if err != nil || old != "v1" {
		t.Errorf("show = %q %v", old, err)
	}

	// Rename, then view the old version under the new name.
	os.Rename(filepath.Join(dir, "a.md"), filepath.Join(dir, "b.md"))
	g.Commit("rename")
	if old, err := g.Show(log[1].Hash, "b.md"); err != nil || old != "v1" {
		t.Errorf("show after rename = %q %v", old, err)
	}

	// Push/pull against a local bare remote.
	remote := t.TempDir()
	exec.Command("git", "init", "--bare", "-b", "main", remote).Run()
	if err := g.SetRemote(remote); err != nil {
		t.Fatal(err)
	}
	if res, err := g.Sync(""); err != nil || !strings.Contains(res, "pushed") {
		t.Fatalf("sync: %q %v", res, err)
	}
	st, _ = g.Status()
	if st.Upstream == "" || st.Ahead != 0 {
		t.Errorf("after push: %+v", st)
	}
}

func TestMaskURL(t *testing.T) {
	if got := MaskURL("https://user:tok@github.com/a/b.git"); got != "https://***@github.com/a/b.git" {
		t.Error(got)
	}
	if got := MaskURL("git@github.com:a/b.git"); got != "git@github.com:a/b.git" {
		t.Error(got)
	}
}

func TestAutoCommitStatus(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	g := New(dir, "tester", "t@example.com")
	if g.Auto().Enabled {
		t.Fatal("auto enabled before AutoCommit")
	}
	g.Init()
	os.WriteFile(filepath.Join(dir, "a.md"), []byte("x"), 0o644)
	g.AutoCommit(100*time.Millisecond, false)
	if a := g.Auto(); !a.Enabled || a.Push || a.NextRun == 0 {
		t.Fatalf("status before first run: %+v", a)
	}
	deadline := time.Now().Add(5 * time.Second)
	for g.Auto().LastRun == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if a := g.Auto(); a.LastResult != "committed" || a.LastError != "" {
		t.Errorf("after run: %+v", a)
	}
	if st, _ := g.Status(); !st.Auto.Enabled || len(st.Files) != 0 {
		t.Errorf("status: %+v", st)
	}
}
