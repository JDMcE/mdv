// Package gitops runs git against the vault using the git CLI.
package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Git struct {
	root  string
	name  string
	email string
	mu    sync.Mutex // one git operation at a time

	autoMu sync.Mutex
	auto   AutoStatus
}

// AutoStatus describes the automatic commit schedule and its last run.
type AutoStatus struct {
	Enabled    bool   `json:"enabled"`
	Every      string `json:"every,omitempty"` // e.g. "10m0s"
	Push       bool   `json:"push"`
	LastRun    int64  `json:"lastRun,omitempty"` // unix seconds
	NextRun    int64  `json:"nextRun,omitempty"`
	LastResult string `json:"lastResult,omitempty"`
	LastError  string `json:"lastError,omitempty"`
}

func (g *Git) Auto() AutoStatus {
	g.autoMu.Lock()
	defer g.autoMu.Unlock()
	return g.auto
}

func New(root, name, email string) *Git {
	return &Git{root: root, name: name, email: email}
}

// ErrNotRepo is returned when the vault isn't a git repository.
var ErrNotRepo = errors.New("the vault is not a git repository")

// run executes git and returns trimmed stdout, or an error carrying stderr.
func (g *Git) run(ctx context.Context, args ...string) (string, error) {
	full := append([]string{
		"-c", "safe.directory=*", // the vault is often owned by another uid in Docker
		"-c", "core.quotepath=off",
		"-c", "user.name=" + g.name,
		"-c", "user.email=" + g.email,
	}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Dir = g.root
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
		"LC_ALL=C",
	)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return out.String(), errors.New(msg)
	}
	return strings.TrimRight(out.String(), "\n"), nil
}

func timeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// IsRepo reports whether the vault root is itself the top of a work tree
// (not merely nested inside some other repository).
func (g *Git) IsRepo() bool {
	ctx, cancel := timeout(10 * time.Second)
	defer cancel()
	top, err := g.run(ctx, "rev-parse", "--show-toplevel")
	if err != nil {
		return false
	}
	a, _ := filepath.EvalSymlinks(filepath.Clean(top))
	b, _ := filepath.EvalSymlinks(g.root)
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

const defaultIgnore = `# mdv defaults
.trash/
.obsidian/workspace*.json
.obsidian/cache
.DS_Store
`

// Init creates a repository with a sensible .gitignore.
func (g *Git) Init() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	ctx, cancel := timeout(30 * time.Second)
	defer cancel()
	if _, err := g.run(ctx, "init", "-b", "main"); err != nil {
		return err
	}
	ign := filepath.Join(g.root, ".gitignore")
	if _, err := os.Stat(ign); os.IsNotExist(err) {
		os.WriteFile(ign, []byte(defaultIgnore), 0o644)
	}
	return nil
}

type FileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "M", "A", "D", "R", "?", "U" (conflict)
}

type Status struct {
	Repo     bool         `json:"repo"`
	Branch   string       `json:"branch,omitempty"`
	Upstream string       `json:"upstream,omitempty"`
	Remote   string       `json:"remote,omitempty"` // origin URL, credentials masked
	Ahead    int          `json:"ahead"`
	Behind   int          `json:"behind"`
	Files    []FileStatus `json:"files"`
	Merging  bool         `json:"merging,omitempty"`
	Auto     AutoStatus   `json:"auto"`
}

func (g *Git) Status() (*Status, error) {
	if !g.IsRepo() {
		return &Status{Repo: false, Files: []FileStatus{}, Auto: g.Auto()}, nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	ctx, cancel := timeout(30 * time.Second)
	defer cancel()
	out, err := g.run(ctx, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	st := &Status{Repo: true, Files: []FileStatus{}, Auto: g.Auto()}
	parts := strings.Split(out, "\x00")
	for i := 0; i < len(parts); i++ {
		e := parts[i]
		if e == "" {
			continue
		}
		if strings.HasPrefix(e, "## ") {
			parseBranch(st, e[3:])
			continue
		}
		if len(e) < 4 {
			continue
		}
		xy, p := e[:2], e[3:]
		if xy[0] == 'R' || xy[0] == 'C' {
			i++ // the original path follows; skip it
		}
		st.Files = append(st.Files, FileStatus{Path: p, Status: statusCode(xy)})
	}
	if _, err := os.Stat(filepath.Join(g.root, ".git", "MERGE_HEAD")); err == nil {
		st.Merging = true
	}
	if url, err := g.run(ctx, "remote", "get-url", "origin"); err == nil {
		st.Remote = MaskURL(url)
	}
	return st, nil
}

func parseBranch(st *Status, s string) {
	// "main...origin/main [ahead 1, behind 2]" or "No commits yet on main"
	if rest, ok := strings.CutPrefix(s, "No commits yet on "); ok {
		st.Branch = rest
		return
	}
	info := ""
	if i := strings.Index(s, " ["); i >= 0 {
		info = s[i+2 : len(s)-1]
		s = s[:i]
	}
	st.Branch, st.Upstream, _ = strings.Cut(s, "...")
	for _, f := range strings.Split(info, ", ") {
		if n, ok := strings.CutPrefix(f, "ahead "); ok {
			st.Ahead, _ = strconv.Atoi(n)
		} else if n, ok := strings.CutPrefix(f, "behind "); ok {
			st.Behind, _ = strconv.Atoi(n)
		}
	}
}

func statusCode(xy string) string {
	switch {
	case xy == "??":
		return "?"
	case xy[0] == 'U' || xy[1] == 'U' || xy == "AA" || xy == "DD":
		return "U"
	case xy[0] == 'R' || xy[1] == 'R':
		return "R"
	case xy[0] == 'A' || xy[1] == 'A':
		return "A"
	case xy[0] == 'D' || xy[1] == 'D':
		return "D"
	default:
		return "M"
	}
}

// MaskURL hides credentials embedded in a remote URL.
func MaskURL(u string) string {
	if i := strings.Index(u, "://"); i >= 0 {
		if at := strings.Index(u[i+3:], "@"); at >= 0 {
			return u[:i+3] + "***@" + u[i+3+at+1:]
		}
	}
	return u
}

// Commit stages everything and commits. Returns false if there was nothing to commit.
func (g *Git) Commit(msg string) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.commitLocked(msg)
}

func (g *Git) commitLocked(msg string) (bool, error) {
	ctx, cancel := timeout(60 * time.Second)
	defer cancel()
	if _, err := g.run(ctx, "add", "-A"); err != nil {
		return false, err
	}
	if out, _ := g.run(ctx, "status", "--porcelain"); out == "" {
		return false, nil
	}
	if strings.TrimSpace(msg) == "" {
		msg = "vault backup: " + time.Now().Format("2006-01-02 15:04:05")
	}
	if _, err := g.run(ctx, "commit", "-m", msg); err != nil {
		return false, err
	}
	return true, nil
}

// Pull merges remote changes. Conflicts are left in the files (with markers)
// so they can be fixed in the editor and committed.
func (g *Git) Pull() (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.pullLocked()
}

func (g *Git) pullLocked() (string, error) {
	ctx, cancel := timeout(2 * time.Minute)
	defer cancel()
	out, err := g.run(ctx, "pull", "--no-rebase", "--no-edit")
	if err != nil && strings.Contains(err.Error()+out, "CONFLICT") {
		return out, fmt.Errorf("merge conflict: fix the files marked with <<<<<<< and commit")
	}
	if err != nil && strings.Contains(err.Error(), "no tracking information") {
		// No upstream yet: pull the same-named branch from origin if there is one.
		br, _ := g.run(ctx, "rev-parse", "--abbrev-ref", "HEAD")
		if _, lerr := g.run(ctx, "ls-remote", "--exit-code", "--heads", "origin", br); lerr != nil {
			return "nothing to pull: the remote has no branch " + br, nil
		}
		out, err = g.run(ctx, "pull", "--no-rebase", "--no-edit", "origin", br)
	}
	return out, err
}

func (g *Git) Push() (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.pushLocked()
}

func (g *Git) pushLocked() (string, error) {
	ctx, cancel := timeout(2 * time.Minute)
	defer cancel()
	out, err := g.run(ctx, "push")
	if err != nil && (strings.Contains(err.Error(), "no upstream") || strings.Contains(err.Error(), "has no upstream")) {
		out, err = g.run(ctx, "push", "-u", "origin", "HEAD")
	}
	return out, err
}

// Sync commits local changes, pulls, then pushes.
func (g *Git) Sync(msg string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	var log []string
	if ok, err := g.commitLocked(msg); err != nil {
		return "", err
	} else if ok {
		log = append(log, "committed")
	}
	if !g.hasRemote() {
		return strings.Join(append(log, "no remote configured"), "; "), nil
	}
	if _, err := g.pullLocked(); err != nil {
		return strings.Join(log, "; "), err
	}
	log = append(log, "pulled")
	if _, err := g.pushLocked(); err != nil {
		return strings.Join(log, "; "), err
	}
	return strings.Join(append(log, "pushed"), "; "), nil
}

func (g *Git) hasRemote() bool {
	ctx, cancel := timeout(10 * time.Second)
	defer cancel()
	out, err := g.run(ctx, "remote")
	return err == nil && strings.TrimSpace(out) != ""
}

// SetRemote points origin at url (adding it if needed).
func (g *Git) SetRemote(url string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	ctx, cancel := timeout(10 * time.Second)
	defer cancel()
	if _, err := g.run(ctx, "remote", "get-url", "origin"); err == nil {
		_, err = g.run(ctx, "remote", "set-url", "origin", url)
		return err
	}
	_, err := g.run(ctx, "remote", "add", "origin", url)
	return err
}

// ErrNotEmpty is returned by Clone when the vault already has files in it.
var ErrNotEmpty = errors.New("the vault folder is not empty")

// Clone fills an empty vault with a clone of url. An empty remote gives an
// empty repository on branch main, ready for the first push.
func (g *Git) Clone(url string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	entries, err := os.ReadDir(g.root)
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return ErrNotEmpty
	}
	ctx, cancel := timeout(10 * time.Minute)
	defer cancel()
	if _, err := g.run(ctx, "clone", "--", url, "."); err != nil {
		// git doesn't always strip credentials from its messages.
		return errors.New(strings.ReplaceAll(err.Error(), url, MaskURL(url)))
	}
	if _, err := g.run(ctx, "rev-parse", "--verify", "HEAD"); err != nil {
		// Nothing on the remote yet: use the same branch name as Init.
		g.run(ctx, "symbolic-ref", "HEAD", "refs/heads/main")
	}
	return nil
}

type Commit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Time    int64  `json:"time"` // unix seconds
	Subject string `json:"subject"`
}

// Log lists commits, optionally only those touching path (following renames).
func (g *Git) Log(path string, limit int) ([]Commit, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	ctx, cancel := timeout(30 * time.Second)
	defer cancel()
	args := []string{"log", "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s", "-n", strconv.Itoa(limit)}
	if path != "" {
		args = append(args, "--follow", "--", path)
	}
	out, err := g.run(ctx, args...)
	if err != nil {
		if strings.Contains(err.Error(), "does not have any commits") {
			return []Commit{}, nil
		}
		return nil, err
	}
	commits := []Commit{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\x1f")
		if len(f) != 5 {
			continue
		}
		t, _ := strconv.ParseInt(f[3], 10, 64)
		commits = append(commits, Commit{Hash: f[0], Short: f[1], Author: f[2], Time: t, Subject: f[4]})
	}
	return commits, nil
}

// Show returns a file's content at a revision. For files that were renamed
// since, the path at that revision is looked up via --follow.
func (g *Git) Show(rev, path string) (string, error) {
	if strings.HasPrefix(rev, "-") {
		return "", errors.New("bad revision")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	ctx, cancel := timeout(30 * time.Second)
	defer cancel()
	out, err := g.run(ctx, "show", rev+":"+path)
	if err == nil {
		return out, nil
	}
	// Find the name the file had in that commit.
	names, lerr := g.run(ctx, "log", "--follow", "--name-only", "--format=%H", "--", path)
	if lerr != nil {
		return "", err
	}
	lines := strings.Split(names, "\n")
	for i, l := range lines {
		if len(l) >= 7 && (strings.HasPrefix(rev, l) || strings.HasPrefix(l, rev)) {
			for _, n := range lines[i+1:] {
				if n = strings.TrimSpace(n); n != "" {
					return g.run(ctx, "show", rev+":"+n)
				}
			}
		}
	}
	return "", err
}

// AutoCommit commits (and optionally syncs) on an interval until the process exits.
func (g *Git) AutoCommit(every time.Duration, push bool) {
	g.autoMu.Lock()
	g.auto = AutoStatus{Enabled: true, Every: every.String(), Push: push, NextRun: time.Now().Add(every).Unix()}
	g.autoMu.Unlock()
	go func() {
		for range time.Tick(every) {
			var err error
			res := "skipped: not a git repository"
			if g.IsRepo() {
				res = "nothing to commit"
				if push {
					var out string
					out, err = g.Sync("")
					if out != "" {
						res = out
					}
				} else {
					var ok bool
					ok, err = g.Commit("")
					if ok {
						res = "committed"
					}
				}
			}
			g.autoMu.Lock()
			g.auto.LastRun = time.Now().Unix()
			g.auto.NextRun = time.Now().Add(every).Unix()
			g.auto.LastResult = res
			g.auto.LastError = ""
			if err != nil {
				g.auto.LastError = err.Error()
			}
			g.autoMu.Unlock()
			if err != nil {
				log.Printf("auto-commit: %v", err)
			} else {
				log.Printf("auto-commit: %s", res)
			}
		}
	}()
}
