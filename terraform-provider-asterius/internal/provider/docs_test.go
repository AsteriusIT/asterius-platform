package provider

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The checked-in docs/ matches the schema and the examples (`make docs` regenerates it).
func TestDocsUpToDate(t *testing.T) {
	files, err := RenderDocs(context.Background(), filepath.Join("..", "..", "examples"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1+len(specs)+1+len(specs) {
		t.Errorf("%d pages, want the index, %d resources and %d data sources", len(files), len(specs)+1, len(specs))
	}
	for name, want := range files {
		got, err := os.ReadFile(filepath.Join("..", "..", "docs", name))
		if err != nil || string(got) != want {
			t.Errorf("docs/%s is stale: run `make docs`", name)
		}
	}
}
