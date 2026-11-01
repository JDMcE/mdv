package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"mdv/internal/auth"
	"mdv/internal/gitops"
	"mdv/internal/index"
	"mdv/internal/server"
	"mdv/internal/vault"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// setupRemote points an existing repo at remote, or clones remote into an
// empty vault so a fresh install starts with the notes already on GitHub.
func setupRemote(git *gitops.Git, remote string) {
	masked := gitops.MaskURL(remote)
	if git.IsRepo() {
		if err := git.SetRemote(remote); err != nil {
			log.Printf("git remote: %v", err)
		}
		return
	}
	switch err := git.Clone(remote); {
	case err == nil:
		log.Printf("cloned %s into the empty vault", masked)
	case errors.Is(err, gitops.ErrNotEmpty):
		log.Printf("MDV_GIT_REMOTE ignored: the vault has files but isn't a git repo. " +
			"Initialize it in the Git panel and restart, or start from an empty vault to clone.")
	default:
		log.Printf("git clone %s failed: %v", masked, err)
	}
}

func main() {
	root := env("MDV_VAULT", "/vault")
	addr := env("MDV_ADDR", ":8080")

	v, err := vault.New(root)
	if err != nil {
		log.Fatalf("open vault: %v", err)
	}
	// Set up git before indexing so a first-run clone is picked up by the index.
	git := gitops.New(v.Root, env("MDV_GIT_NAME", "mdv"), env("MDV_GIT_EMAIL", "mdv@localhost"))
	if remote := os.Getenv("MDV_GIT_REMOTE"); remote != "" {
		setupRemote(git, remote)
	}

	ix := index.New(v)
	if err := ix.Watch(); err != nil {
		log.Printf("file watching disabled: %v", err)
	}
	if every := os.Getenv("MDV_AUTO_COMMIT"); every != "" {
		d, err := time.ParseDuration(every)
		if err != nil || d < time.Minute {
			log.Fatalf("MDV_AUTO_COMMIT must be a duration of at least 1m, e.g. 10m")
		}
		push := strings.EqualFold(os.Getenv("MDV_AUTO_PUSH"), "true")
		git.AutoCommit(d, push)
		log.Printf("auto-commit every %v (push: %v)", d, push)
	}

	a := auth.New(os.Getenv("MDV_PASSWORD"))
	var h http.Handler = server.New(v, ix, git, server.Config{
		Attachments: env("MDV_ATTACHMENTS", "attachments"),
		Auth:        a != nil,
	})
	if a != nil {
		h = a.Middleware(h)
	} else {
		log.Printf("no MDV_PASSWORD set: anyone who can reach %s can use this vault", addr)
	}

	log.Printf("mdv serving %s on %s", v.Root, addr)
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
