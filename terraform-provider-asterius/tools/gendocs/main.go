// Command gendocs writes docs/ (Terraform Registry layout) from the provider schema and examples/.
//
//	go run ./tools/gendocs          # write
//	go run ./tools/gendocs -check   # fail when docs/ is stale
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/provider"
)

func main() {
	check := flag.Bool("check", false, "fail when docs/ differs from the generated documentation")
	dir := flag.String("dir", ".", "provider directory (holds docs/ and examples/)")
	flag.Parse()

	files, err := provider.RenderDocs(context.Background(), filepath.Join(*dir, "examples"))
	if err != nil {
		fail(err)
	}
	docs := filepath.Join(*dir, "docs")
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)

	stale := []string{}
	for _, n := range names {
		p := filepath.Join(docs, n)
		current, _ := os.ReadFile(p)
		if string(current) == files[n] {
			continue
		}
		stale = append(stale, p)
		if !*check {
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				fail(err)
			}
			if err := os.WriteFile(p, []byte(files[n]), 0o644); err != nil {
				fail(err)
			}
		}
	}
	// Pages of resources that no longer exist.
	_ = filepath.WalkDir(docs, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(p) != ".md" {
			return nil
		}
		rel, _ := filepath.Rel(docs, p)
		if _, ok := files[rel]; !ok {
			stale = append(stale, p)
			if !*check {
				_ = os.Remove(p)
			}
		}
		return nil
	})
	if *check && len(stale) > 0 {
		fmt.Fprintln(os.Stderr, "docs/ is stale, run `make docs`:")
		for _, p := range stale {
			fmt.Fprintln(os.Stderr, "  "+p)
		}
		os.Exit(1)
	}
	if !*check {
		fmt.Printf("docs: %d files, %d updated\n", len(files), len(stale))
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
