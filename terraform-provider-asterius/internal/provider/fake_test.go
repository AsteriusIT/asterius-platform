package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI is an in-memory Asterius API for the unit tests: PUT / GET / DELETE of the documents of every spec, the team
// and secret lists, and the 409 of resources managed by configuration (identifiers starting with "managed-"). Like the
// real server it fills defaults: top-level (empty values, `managed`, `version`, timestamps) and nested (a
// "filledByServer" key in every object of a JSON attribute), so semantic equality is exercised.
type fakeAPI struct {
	mu      sync.Mutex
	docs    map[string]map[string]any // by API path
	secrets map[string]map[string]string
	puts    []string // "PUT <path> <body>"
	srv     *httptest.Server
}

func newFakeAPI(t *testing.T) *fakeAPI {
	t.Helper()
	f := &fakeAPI{docs: map[string]map[string]any{}, secrets: map[string]map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) providerBlock() string {
	return fmt.Sprintf("provider \"asterius\" {\n  endpoint = %q\n  token = \"test-token\"\n  organization = \"acme\"\n}\n", f.srv.URL)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func notFound(w http.ResponseWriter, what string) {
	writeJSON(w, 404, map[string]string{"error": what + " not found"})
}

// specOf finds the spec of an API path: /api/v1/<collection>/<id> or /api/v1/blueprints/<bp>/entities/<id>.
func specOf(segments []string) (*resourceSpec, string, string) {
	if len(segments) == 4 && segments[0] == "blueprints" && segments[2] == "entities" {
		return specByName("entity"), segments[1], segments[3]
	}
	if len(segments) == 2 {
		for _, s := range specs {
			if s.Collection == segments[0] {
				return s, "", segments[1]
			}
		}
	}
	return nil, "", ""
}

func fillNested(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			t[k] = fillNested(e)
		}
		if len(t) > 0 {
			t["filledByServer"] = true
		}
		return t
	case []any:
		for i := range t {
			t[i] = fillNested(t[i])
		}
	}
	return v
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("X-Asterius-Org") != "acme" {
		writeJSON(w, 401, map[string]string{"error": "Unauthorized"})
		return
	}
	segments := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/"), "/")
	switch {
	case r.URL.Path == "/api/v1/teams" && r.Method == "GET":
		teams := []map[string]any{}
		keys := []string{}
		for p := range f.docs {
			if strings.HasPrefix(p, "/api/v1/teams/") {
				keys = append(keys, p)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			teams = append(teams, f.docs[k])
		}
		writeJSON(w, 200, teams)
		return
	case segments[0] == "secrets":
		f.serveSecrets(w, r, segments)
		return
	}
	spec, parent, id := specOf(segments)
	if spec == nil {
		notFound(w, r.URL.Path)
		return
	}
	if strings.HasPrefix(id, "managed-") {
		if r.Method == "GET" {
			writeJSON(w, 200, map[string]any{"identifier": id, "title": "Managed", "managed": true})
			return
		}
		writeJSON(w, 409, map[string]string{"error": fmt.Sprintf("%s %q is managed by configuration (CONFIG_DIR); change it in the configuration repository", spec.Title, id)})
		return
	}
	switch r.Method {
	case "GET":
		doc, ok := f.docs[r.URL.Path]
		if !ok || spec.Name == "team" { // no GET by identifier for teams
			notFound(w, spec.Title+" "+id)
			return
		}
		writeJSON(w, 200, doc)
	case "DELETE":
		if _, ok := f.docs[r.URL.Path]; !ok {
			notFound(w, spec.Title+" "+id)
			return
		}
		delete(f.docs, r.URL.Path)
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "PUT":
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		raw, _ := json.Marshal(body)
		f.puts = append(f.puts, fmt.Sprintf("PUT %s %s", r.URL.Path, raw))
		prev := f.docs[r.URL.Path]
		doc := map[string]any{"identifier": id, "managed": false}
		if parent != "" {
			doc["blueprint"] = parent
		}
		for _, fl := range spec.Fields {
			v, present := body[fl.Key]
			switch {
			case fl.Computed || fl.NotInBody:
			case present && fl.Kind == kJSON:
				doc[fl.Key] = fillNested(v)
			case present:
				doc[fl.Key] = v
			case fl.Nullable:
			case fl.Name == "title":
				doc[fl.Key] = id
			default:
				doc[fl.Key] = map[kind]any{kString: "", kBool: false, kInt: 0, kStringList: []any{}, kStringMap: map[string]any{}, kJSON: map[string]any{}}[fl.Kind]
			}
		}
		version := 1.0
		created := time.Now().UTC().Format(time.RFC3339Nano)
		if prev != nil {
			version = prev["version"].(float64) + 1
			created = prev["createdAt"].(string)
		}
		doc["version"], doc["createdAt"], doc["updatedAt"] = version, created, time.Now().UTC().Format(time.RFC3339Nano)
		if spec.Name == "webhook" {
			doc["hasSecret"] = body["secret"] != nil
		}
		if spec.Name == "integration" {
			doc["webhookUrl"] = f.srv.URL + "/api/v1/ingest/acme/" + id
		}
		// Normalise numbers like a JSON round trip does.
		raw, _ = json.Marshal(doc)
		var stored map[string]any
		_ = json.Unmarshal(raw, &stored)
		f.docs[r.URL.Path] = stored
		writeJSON(w, 200, stored)
	default:
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
	}
}

func (f *fakeAPI) serveSecrets(w http.ResponseWriter, r *http.Request, segments []string) {
	if len(segments) == 1 && r.Method == "GET" {
		list := []map[string]string{}
		names := []string{}
		for n := range f.secrets {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			list = append(list, map[string]string{"name": n, "description": f.secrets[n]["description"], "updatedAt": f.secrets[n]["updatedAt"]})
		}
		writeJSON(w, 200, list)
		return
	}
	name := segments[len(segments)-1]
	switch r.Method {
	case "PUT":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.secrets[name] = map[string]string{"value": body["value"], "description": body["description"], "updatedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "DELETE":
		if _, ok := f.secrets[name]; !ok {
			notFound(w, "Secret "+name)
			return
		}
		delete(f.secrets, name)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

func (f *fakeAPI) secretValue(name string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.secrets[name]["value"]
}

func (f *fakeAPI) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.docs) + len(f.secrets)
}
