// Package auth provides optional single-password login with signed cookies.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cookieName = "mdv_session"
	sessionTTL = 30 * 24 * time.Hour
)

type Auth struct {
	password string
	key      []byte

	mu       sync.Mutex
	failures map[string][]time.Time // per-IP failed logins, for throttling
}

// New returns nil when no password is configured (auth disabled). The signing
// key derives from the password, so sessions survive restarts and are all
// invalidated when the password changes.
func New(password string) *Auth {
	if password == "" {
		return nil
	}
	k := sha256.Sum256([]byte("mdv-session-v1\x00" + password))
	return &Auth{password: password, key: k[:], failures: map[string][]time.Time{}}
}

func (a *Auth) sign(exp int64) string {
	m := hmac.New(sha256.New, a.key)
	m.Write([]byte(strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(exp, 10) + "." + hex.EncodeToString(m.Sum(nil))
}

func (a *Auth) valid(v string) bool {
	expStr, _, ok := strings.Cut(v, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	return hmac.Equal([]byte(v), []byte(a.sign(exp)))
}

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	return host
}

// throttled reports whether this IP has failed too often recently.
func (a *Auth) throttled(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	cutoff := time.Now().Add(-15 * time.Minute)
	recent := a.failures[ip][:0]
	for _, t := range a.failures[ip] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	a.failures[ip] = recent
	return len(recent) >= 10
}

func (a *Auth) fail(ip string) {
	a.mu.Lock()
	a.failures[ip] = append(a.failures[ip], time.Now())
	a.mu.Unlock()
	time.Sleep(time.Second) // slow down guessing
}

func secure(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// Middleware requires a valid session for everything except the login page
// and the static assets it needs.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			a.login(w, r)
			return
		case "/logout":
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		case "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png":
			next.ServeHTTP(w, r)
			return
		}
		if c, err := r.Cookie(cookieName); err == nil && a.valid(c.Value) {
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "login required", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusSeeOther)
	})
}

var page = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>mdv · sign in</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1e1e;color:#dcddde;font:15px system-ui,sans-serif}
form{width:min(320px,calc(100vw - 32px));display:flex;flex-direction:column;gap:12px;padding:28px;background:#181818;border:1px solid #2e2e2e;border-radius:10px}
h1{margin:0 0 4px;font-size:20px}
input{font:inherit;color:inherit;background:#1e1e1e;border:1px solid #2e2e2e;border-radius:6px;padding:9px 11px;outline:none}
input:focus{border-color:#8b6cef}
button{font:inherit;color:#fff;background:#8b6cef;border:0;border-radius:6px;padding:9px;cursor:pointer}
.err{color:#e5534b;font-size:13px;margin:0}
</style></head><body>
<form method="post" action="/login">
<h1>mdv</h1>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<input type="hidden" name="next" value="{{.Next}}">
<button type="submit">Sign in</button>
</form></body></html>`))

func (a *Auth) login(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	next := r.FormValue("next")
	// Only allow local redirects.
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") {
		next = "/"
	}
	if r.Method != http.MethodPost {
		page.Execute(w, map[string]string{"Next": next})
		return
	}
	ip := clientIP(r)
	if a.throttled(ip) {
		w.WriteHeader(http.StatusTooManyRequests)
		page.Execute(w, map[string]string{"Next": next, "Error": "Too many attempts. Try again in a few minutes."})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.FormValue("password")), []byte(a.password)) != 1 {
		a.fail(ip)
		w.WriteHeader(http.StatusUnauthorized)
		page.Execute(w, map[string]string{"Next": next, "Error": "Wrong password."})
		return
	}
	exp := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    a.sign(exp.Unix()),
		Path:     "/",
		Expires:  exp,
		HttpOnly: true,
		Secure:   secure(r),
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, next, http.StatusSeeOther)
}
