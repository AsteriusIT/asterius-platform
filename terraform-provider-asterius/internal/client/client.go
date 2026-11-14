// Package client is a small HTTP client for the Asterius Platform REST API (/api/v1), the subset the provider uses.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OrgHeader selects the organization (tenant) of a request; without it the API uses the token's organization.
const OrgHeader = "X-Asterius-Org"

// Client calls the API with a bearer token.
type Client struct {
	Endpoint     string
	Token        string
	Organization string
	UserAgent    string
	HTTP         *http.Client
}

// New returns a client for `endpoint` (the server's base URL, with or without a trailing /api/v1).
func New(endpoint, token, organization, userAgent string) *Client {
	e := strings.TrimRight(endpoint, "/")
	e = strings.TrimSuffix(e, "/api/v1")
	return &Client{
		Endpoint:     e,
		Token:        token,
		Organization: organization,
		UserAgent:    userAgent,
		HTTP:         &http.Client{Timeout: 60 * time.Second},
	}
}

// Error is a non-2xx answer of the API ({ "error": "…" }).
type Error struct {
	Method  string
	Path    string
	Status  int
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s %s: %d %s", e.Method, e.Path, e.Status, e.Message)
}

// IsNotFound reports a 404.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

// IsManaged reports the 409 the API answers to writes of a resource declared in CONFIG_DIR (configuration as code).
func IsManaged(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusConflict && strings.Contains(e.Message, "managed by configuration")
}

// Path joins escaped segments under /api/v1: Path("blueprints", "svc") is /api/v1/blueprints/svc.
func Path(segments ...string) string {
	var b strings.Builder
	b.WriteString("/api/v1")
	for _, s := range segments {
		b.WriteByte('/')
		b.WriteString(url.PathEscape(s))
	}
	return b.String()
}

// Do sends `body` (JSON, when not nil) and decodes a 2xx answer into `out` (when not nil).
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding the request body: %w", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Endpoint+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.Organization != "" {
		req.Header.Set(OrgHeader, c.Organization)
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return &Error{Method: method, Path: path, Status: res.StatusCode, Message: errorMessage(data, res.Status)}
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decoding the answer of %s %s: %w", method, path, err)
	}
	return nil
}

func errorMessage(data []byte, status string) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &e) == nil {
		if e.Error != "" {
			return e.Error
		}
		if e.Message != "" {
			return e.Message
		}
	}
	if s := strings.TrimSpace(string(data)); s != "" && len(s) < 500 {
		return s
	}
	return status
}
