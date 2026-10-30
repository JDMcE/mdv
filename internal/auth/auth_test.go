package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDisabledWithoutPassword(t *testing.T) {
	if New("") != nil {
		t.Fatal("auth should be disabled without a password")
	}
}

func TestLoginFlow(t *testing.T) {
	a := New("secret")
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("app")) })
	h := a.Middleware(ok)

	// Unauthenticated: API → 401, pages → redirect to login.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/tree", nil))
	if rec.Code != 401 {
		t.Errorf("api: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusSeeOther || !strings.HasPrefix(rec.Header().Get("Location"), "/login") {
		t.Errorf("page: %d %s", rec.Code, rec.Header().Get("Location"))
	}

	post := func(pw, next string) *httptest.ResponseRecorder {
		form := url.Values{"password": {pw}, "next": {next}}
		req := httptest.NewRequest("POST", "/login", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := post("wrong", "/"); rec.Code != 401 {
		t.Errorf("wrong password: %d", rec.Code)
	}
	rec = post("secret", "//evil.example")
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/" {
		t.Errorf("open redirect not blocked: %s", rec.Header().Get("Location"))
	}
	cookie := rec.Result().Cookies()[0]

	req := httptest.NewRequest("GET", "/api/tree", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Body.String() != "app" {
		t.Errorf("with cookie: %d", rec.Code)
	}

	// A tampered or other-password cookie is rejected.
	other := New("different")
	if other.valid(cookie.Value) {
		t.Error("cookie valid under a different password")
	}
	if a.valid(cookie.Value + "0") {
		t.Error("tampered cookie accepted")
	}
}
