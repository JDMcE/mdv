// Package server exposes the vault over HTTP and serves the embedded web UI.
package server

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"mdv/internal/gitops"
	"mdv/internal/index"
	"mdv/internal/vault"
)

//go:embed all:dist
var dist embed.FS

type Config struct {
	Attachments string // fallback attachment folder (see vault.AttachmentDir)
	Auth        bool   // whether login is enabled (for the UI's logout button)
}

type Server struct {
	v   *vault.Vault
	ix  *index.Index
	git *gitops.Git
	cfg Config
	mux *http.ServeMux
}

func New(v *vault.Vault, ix *index.Index, git *gitops.Git, cfg Config) *Server {
	s := &Server{v: v, ix: ix, git: git, cfg: cfg, mux: http.NewServeMux()}
	m := s.mux
	m.HandleFunc("GET /api/config", s.config)
	m.HandleFunc("GET /api/settings", s.getSettings)
	m.HandleFunc("PUT /api/settings", s.putSettings)
	m.HandleFunc("GET /api/tree", s.tree)
	m.HandleFunc("GET /api/file", s.readFile)
	m.HandleFunc("PUT /api/file", s.writeFile)
	m.HandleFunc("POST /api/file", s.createFile)
	m.HandleFunc("DELETE /api/file", s.deleteFile)
	m.HandleFunc("POST /api/folder", s.createFolder)
	m.HandleFunc("POST /api/move", s.move)
	m.HandleFunc("GET /api/raw", s.raw)
	m.HandleFunc("POST /api/upload", s.upload)
	m.HandleFunc("GET /api/search", s.search)
	m.HandleFunc("GET /api/links", s.links)
	m.HandleFunc("GET /api/events", s.events)

	m.HandleFunc("GET /api/git/status", s.gitStatus)
	m.HandleFunc("POST /api/git/init", s.gitInit)
	m.HandleFunc("POST /api/git/commit", s.gitCommit)
	m.HandleFunc("POST /api/git/pull", s.gitPull)
	m.HandleFunc("POST /api/git/push", s.gitPush)
	m.HandleFunc("POST /api/git/sync", s.gitSync)
	m.HandleFunc("POST /api/git/remote", s.gitRemote)
	m.HandleFunc("GET /api/git/log", s.gitLog)
	m.HandleFunc("GET /api/git/show", s.gitShow)

	static, _ := fs.Sub(dist, "dist")
	files := http.FileServerFS(static)
	m.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			// Vite fingerprints these, so they never change.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	}))
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	// Reject cross-site writes (CSRF, DNS rebinding from another page).
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if o := r.Header.Get("Origin"); o != "" {
			if u, err := url.Parse(o); err != nil || u.Host != r.Host {
				http.Error(w, "cross-origin request refused", http.StatusForbidden)
				return
			}
		}
	}
	s.mux.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	switch {
	case errors.Is(err, vault.ErrOutside):
		code = http.StatusForbidden
	case errors.Is(err, vault.ErrConflict), errors.Is(err, vault.ErrExists):
		code = http.StatusConflict
	case errors.Is(err, os.ErrNotExist):
		code = http.StatusNotFound
	default:
		log.Printf("error: %v", err)
	}
	http.Error(w, err.Error(), code)
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"auth": s.cfg.Auth})
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	b, err := s.v.ReadSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.v.WriteSettings(b); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	t, err := s.v.Tree()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, t)
}

func (s *Server) readFile(w http.ResponseWriter, r *http.Request) {
	f, err := s.v.Read(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, f)
}

// writeFile saves the request body. The X-Mtime header carries the mtime the
// client last saw; a mismatch yields 409 so edits made elsewhere aren't lost.
func (s *Server) writeFile(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	expect, _ := strconv.ParseInt(r.Header.Get("X-Mtime"), 10, 64)
	p := r.URL.Query().Get("path")
	mtime, err := s.v.Write(p, string(body), expect)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.ix.Refresh(p)
	writeJSON(w, map[string]int64{"mtime": mtime})
}

func (s *Server) createFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if err := s.v.Create(p); err != nil {
		writeErr(w, err)
		return
	}
	s.ix.Refresh(p)
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if err := s.v.Delete(p); err != nil {
		writeErr(w, err)
		return
	}
	s.ix.Refresh(p)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	if err := s.v.Mkdir(r.URL.Query().Get("path")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

// move renames a file or folder and rewrites links that pointed at it.
func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From, To    string
		UpdateLinks *bool
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	update := req.UpdateLinks == nil || *req.UpdateLinks

	// Work out link edits before moving, while links still resolve.
	var edits map[string][]index.Edit
	moves := map[string]string{}
	if update {
		for _, p := range s.ix.Under(req.From) {
			moves[p] = req.To + strings.TrimPrefix(p, req.From)
		}
		edits = s.ix.RenameEdits(moves)
	}
	// Snapshot the content the edits were computed against.
	before := map[string]string{}
	for file := range edits {
		before[file], _ = s.ix.Content(file)
	}
	if err := s.v.Move(req.From, req.To); err != nil {
		writeErr(w, err)
		return
	}
	s.ix.Refresh(req.From)
	s.ix.Refresh(req.To)

	updated := 0
	for file, ed := range edits {
		now := file
		if m, ok := moves[file]; ok {
			now = m
		}
		f, err := s.v.Read(now)
		if err != nil || f.Content != before[file] {
			continue // changed underneath us; don't risk mangling it
		}
		if _, err := s.v.Write(now, index.ApplyEdits(f.Content, ed), f.Mtime); err != nil {
			log.Printf("update links in %s: %v", now, err)
			continue
		}
		s.ix.Refresh(now)
		updated++
	}
	writeJSON(w, map[string]int{"updated": updated})
}

// raw serves any vault file (images, PDFs…). Responses are sandboxed so an
// SVG or HTML file can't run script on the app's origin.
func (s *Server) raw(w http.ResponseWriter, r *http.Request) {
	abs, err := s.v.Abs(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, err)
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	// Chrome's PDF viewer won't run in a sandboxed document; it isolates PDF
	// scripts itself, so PDFs get a CSP without "sandbox".
	csp := "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
	if !strings.EqualFold(path.Ext(st.Name()), ".pdf") {
		csp += "; sandbox"
	}
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

// upload stores a pasted/dropped file next to the note it belongs to.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name := path.Base(strings.ReplaceAll(q.Get("name"), "\\", "/"))
	if name == "" || name == "." || name == "/" || strings.HasPrefix(name, ".") {
		name = "Pasted file " + time.Now().Format("20060102150405")
	}
	dir := s.v.AttachmentDir(q.Get("note"), s.cfg.Attachments)
	rel := s.v.UniqueName(dir, name)
	if err := s.v.WriteNew(rel, http.MaxBytesReader(w, r.Body, 100<<20)); err != nil {
		writeErr(w, err)
		return
	}
	s.ix.Refresh(rel)
	writeJSON(w, map[string]string{"path": rel})
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	writeJSON(w, s.ix.Search(index.Query{
		Text:  q.Get("q"),
		Case:  q.Get("case") == "1",
		Regex: q.Get("regex") == "1",
		Word:  q.Get("word") == "1",
	}))
}

func (s *Server) links(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.ix.Links(r.URL.Query().Get("path")))
}

// events streams vault changes to the browser as server-sent events.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, cancel := s.ix.Subscribe()
	defer cancel()
	fmt.Fprint(w, ": hello\n\n")
	flusher.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
		case e := <-ch:
			b, _ := json.Marshal(e)
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
		flusher.Flush()
	}
}

// ---------- git ----------

// gitResult reports a git operation's outcome; failures are 200 with an
// error message so the UI can show git's own explanation.
func gitResult(w http.ResponseWriter, msg string, err error) {
	res := map[string]string{"message": strings.TrimSpace(msg)}
	if err != nil {
		res["error"] = err.Error()
	}
	writeJSON(w, res)
}

func readMessage(r *http.Request) string {
	var body struct{ Message string }
	json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body)
	return body.Message
}

func (s *Server) gitStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.git.Status()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, st)
}

func (s *Server) gitInit(w http.ResponseWriter, r *http.Request) {
	gitResult(w, "initialized", s.git.Init())
}

func (s *Server) gitCommit(w http.ResponseWriter, r *http.Request) {
	ok, err := s.git.Commit(readMessage(r))
	msg := "nothing to commit"
	if ok {
		msg = "committed"
	}
	gitResult(w, msg, err)
}

func (s *Server) gitPull(w http.ResponseWriter, r *http.Request) {
	out, err := s.git.Pull()
	s.ix.Refresh("") // pulled files are picked up by the watcher too; this is belt and braces
	gitResult(w, out, err)
}

func (s *Server) gitPush(w http.ResponseWriter, r *http.Request) {
	out, err := s.git.Push()
	gitResult(w, out, err)
}

func (s *Server) gitSync(w http.ResponseWriter, r *http.Request) {
	out, err := s.git.Sync(readMessage(r))
	s.ix.Refresh("")
	gitResult(w, out, err)
}

func (s *Server) gitRemote(w http.ResponseWriter, r *http.Request) {
	var body struct{ URL string }
	json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body)
	u := strings.TrimSpace(body.URL)
	if u == "" || strings.HasPrefix(u, "-") {
		http.Error(w, "invalid remote URL", http.StatusBadRequest)
		return
	}
	gitResult(w, "remote set", s.git.SetRemote(u))
}

func (s *Server) gitLog(w http.ResponseWriter, r *http.Request) {
	commits, err := s.git.Log(r.URL.Query().Get("path"), 200)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, commits)
}

func (s *Server) gitShow(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	content, err := s.git.Show(q.Get("rev"), q.Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, content)
}
