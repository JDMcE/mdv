package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mdv/internal/gitops"
	"mdv/internal/index"
	"mdv/internal/vault"
)

func setup(t *testing.T, files map[string]string) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	for p, c := range files {
		abs := filepath.Join(dir, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(abs), 0o755)
		os.WriteFile(abs, []byte(c), 0o644)
	}
	v, _ := vault.New(dir)
	ix := index.New(v)
	srv := httptest.NewServer(New(v, ix, gitops.New(dir, "t", "t@t"), Config{Attachments: "attachments"}))
	t.Cleanup(srv.Close)
	return srv, dir
}

func read(t *testing.T, dir, p string) string {
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(p)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMoveUpdatesLinks(t *testing.T) {
	srv, dir := setup(t, map[string]string{
		"notes/old.md": "# Old\n[sib](sib.md)",
		"notes/sib.md": "",
		"index.md":     "see [[old]] and [link](notes/old.md)",
	})
	res, err := http.Post(srv.URL+"/api/move", "application/json",
		strings.NewReader(`{"from":"notes","to":"archive/notes"}`))
	if err != nil {
		t.Fatal(err)
	}
	var out struct{ Updated int }
	json.NewDecoder(res.Body).Decode(&out)
	if got := read(t, dir, "index.md"); got != "see [[old]] and [link](archive/notes/old.md)" {
		t.Errorf("index.md = %q", got)
	}
	// The moved note's sibling link still works (both moved together).
	if got := read(t, dir, "archive/notes/old.md"); got != "# Old\n[sib](sib.md)" {
		t.Errorf("moved note = %q", got)
	}
	if out.Updated != 1 {
		t.Errorf("updated = %d", out.Updated)
	}
}

func TestUploadAndRaw(t *testing.T) {
	srv, dir := setup(t, map[string]string{"n/a.md": ""})
	up := func(name string) string {
		res, err := http.Post(srv.URL+"/api/upload?note=n/a.md&name="+name, "image/png", strings.NewReader("PNGDATA"))
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("upload: %v %v", err, res.Status)
		}
		var out struct{ Path string }
		json.NewDecoder(res.Body).Decode(&out)
		return out.Path
	}
	if p := up("shot.png"); p != "attachments/shot.png" {
		t.Errorf("first upload at %q", p)
	}
	if p := up("shot.png"); p != "attachments/shot 1.png" {
		t.Errorf("second upload at %q", p)
	}
	if p := up("..%2F..%2Fescape.png"); strings.Contains(p, "..") || !strings.HasPrefix(p, "attachments/") {
		t.Errorf("traversal in name: %q", p)
	}
	if read(t, dir, "attachments/shot.png") != "PNGDATA" {
		t.Error("content mismatch")
	}

	res, _ := http.Get(srv.URL + "/api/raw?path=attachments/shot.png")
	body, _ := io.ReadAll(res.Body)
	if string(body) != "PNGDATA" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("raw: %q csp=%q", body, res.Header.Get("Content-Security-Policy"))
	}
	if res, _ := http.Get(srv.URL + "/api/raw?path=.git/config"); res.StatusCode != 403 {
		t.Errorf(".git readable: %d", res.StatusCode)
	}
}

func TestCrossOriginWritesRefused(t *testing.T) {
	srv, _ := setup(t, nil)
	req, _ := http.NewRequest("POST", srv.URL+"/api/file?path=x.md", nil)
	req.Header.Set("Origin", "https://evil.example")
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 403 {
		t.Errorf("cross-origin POST: %d", res.StatusCode)
	}
	req, _ = http.NewRequest("POST", srv.URL+"/api/file?path=x.md", nil)
	req.Header.Set("Origin", srv.URL)
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != 201 {
		t.Errorf("same-origin POST: %d", res.StatusCode)
	}
}

func TestSettings(t *testing.T) {
	srv, dir := setup(t, nil)
	get := func() string {
		res, err := http.Get(srv.URL + "/api/settings")
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		return strings.TrimSpace(string(b))
	}
	if got := get(); got != "{}" {
		t.Errorf("empty settings = %q", got)
	}
	put := func(body string) int {
		req, _ := http.NewRequest("PUT", srv.URL+"/api/settings", strings.NewReader(body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode
	}
	if code := put(`{"theme":"nord","lineNumbers":false}`); code != 204 {
		t.Fatalf("put: %d", code)
	}
	if got := get(); !strings.Contains(got, `"theme": "nord"`) {
		t.Errorf("round trip = %q", got)
	}
	if code := put(`[1,2]`); code != 400 {
		t.Errorf("non-object accepted: %d", code)
	}
	if code := put(`{bad`); code != 400 {
		t.Errorf("invalid JSON accepted: %d", code)
	}
	if _, err := os.Stat(filepath.Join(dir, ".mdv", "settings.json")); err != nil {
		t.Errorf("settings file: %v", err)
	}
	// .mdv is hidden from the file API and the tree.
	if res, _ := http.Get(srv.URL + "/api/file?path=.mdv/settings.json"); res.StatusCode != 403 {
		t.Errorf(".mdv readable via file API: %d", res.StatusCode)
	}
	res, _ := http.Get(srv.URL + "/api/tree")
	if b, _ := io.ReadAll(res.Body); strings.Contains(string(b), ".mdv") {
		t.Errorf(".mdv listed in tree: %s", b)
	}
}
