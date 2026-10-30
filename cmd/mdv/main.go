package main

import (
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

func main() {
	root := env("MDV_VAULT", "/vault")
	addr := env("MDV_ADDR", ":8080")

	v, err := vault.New(root)
	if err != nil {
		log.Fatalf("open vault: %v", err)
	}
	ix := index.New(v)
	if err := ix.Watch(); err != nil {
		log.Printf("file watching disabled: %v", err)
	}

	git := gitops.New(v.Root, env("MDV_GIT_NAME", "mdv"), env("MDV_GIT_EMAIL", "mdv@localhost"))
	if remote := os.Getenv("MDV_GIT_REMOTE"); remote != "" && git.IsRepo() {
		if err := git.SetRemote(remote); err != nil {
			log.Printf("git remote: %v", err)
		}
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
