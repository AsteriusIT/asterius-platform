package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoSendsHeadersAndDecodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/api/v1/blueprints/svc/entities/a%2Fb" {
			t.Errorf("path %s", r.URL.EscapedPath())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("authorization %q", got)
		}
		if got := r.Header.Get(OrgHeader); got != "acme" {
			t.Errorf("organization %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("content type %q", got)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"echo": body["title"]})
	}))
	defer srv.Close()

	// A trailing /api/v1 in the endpoint is accepted.
	c := New(srv.URL+"/api/v1/", "tok", "acme", "test")
	var out struct{ Echo string }
	if err := c.Do(context.Background(), "PUT", Path("blueprints", "svc", "entities", "a/b"), map[string]any{"title": "T"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.Echo != "T" {
		t.Fatalf("decoded %+v", out)
	}
}

func TestDoWithoutOrganization(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.Header[http.CanonicalHeaderKey(OrgHeader)]; ok {
			t.Error("no organization header without an organization")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := New(srv.URL, "tok", "", "test").Do(context.Background(), "DELETE", Path("teams", "x"), nil, &struct{}{}); err != nil {
		t.Fatal(err)
	}
}

func TestErrors(t *testing.T) {
	answers := map[string]struct {
		status int
		body   string
	}{
		"/api/v1/managed":   {409, `{"error":"Blueprint \"x\" is managed by configuration (CONFIG_DIR); change it in the configuration repository"}`},
		"/api/v1/conflict":  {409, `{"error":"Team x is used by 3 entities","usedBy":[]}`},
		"/api/v1/missing":   {404, `{"error":"Blueprint x not found"}`},
		"/api/v1/plain":     {502, `bad gateway`},
		"/api/v1/empty":     {500, ``},
		"/api/v1/invalidjs": {400, `{"message":"invalid"}`},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := answers[r.URL.Path]
		w.WriteHeader(a.status)
		_, _ = w.Write([]byte(a.body))
	}))
	defer srv.Close()
	c := New(srv.URL, "tok", "", "test")
	get := func(p string) error { return c.Do(context.Background(), "GET", p, nil, nil) }

	if err := get("/api/v1/managed"); !IsManaged(err) || IsNotFound(err) {
		t.Errorf("managed: %v", err)
	}
	if err := get("/api/v1/conflict"); IsManaged(err) || err == nil {
		t.Errorf("a conflict that is not about configuration: %v", err)
	}
	err := get("/api/v1/missing")
	if !IsNotFound(err) {
		t.Errorf("missing: %v", err)
	}
	if want := "GET /api/v1/missing: 404 Blueprint x not found"; err.Error() != want {
		t.Errorf("message %q, want %q", err.Error(), want)
	}
	if err := get("/api/v1/plain"); err == nil || err.(*Error).Message != "bad gateway" {
		t.Errorf("plain: %v", err)
	}
	if err := get("/api/v1/empty"); err == nil || err.(*Error).Message != "500 Internal Server Error" {
		t.Errorf("empty: %v", err)
	}
	if err := get("/api/v1/invalidjs"); err == nil || err.(*Error).Message != "invalid" {
		t.Errorf("message field: %v", err)
	}
}
