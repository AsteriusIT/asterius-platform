package provider

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	fwdatasource "github.com/hashicorp/terraform-plugin-framework/datasource"
	fwprovider "github.com/hashicorp/terraform-plugin-framework/provider"
	fwresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Documentation in the layout of the Terraform Registry (docs/index.md, docs/resources/<name>.md,
// docs/data-sources/<name>.md), rendered from the provider schema and the examples. tools/gendocs writes it.

// docAttribute is the part of a schema attribute the documentation shows.
type docAttribute interface {
	IsRequired() bool
	IsOptional() bool
	IsComputed() bool
	IsSensitive() bool
	GetMarkdownDescription() string
	GetDescription() string
	GetType() attr.Type
}

type writeOnly interface{ IsWriteOnly() bool }

func typeName(t attr.Type) string {
	switch tt := t.(type) {
	case JSONType:
		return "String, JSON"
	case types.ListType:
		return "List of " + typeName(tt.ElemType)
	case types.MapType:
		return "Map of " + typeName(tt.ElemType)
	}
	switch {
	case t.Equal(types.StringType):
		return "String"
	case t.Equal(types.BoolType):
		return "Boolean"
	case t.Equal(types.Int64Type):
		return "Number"
	}
	return t.String()
}

func attributeSections[A docAttribute](attrs map[string]A) string {
	groups := map[string][]string{}
	names := make([]string, 0, len(attrs))
	for n := range attrs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		a := attrs[n]
		group := "Read-Only"
		switch {
		case a.IsRequired():
			group = "Required"
		case a.IsOptional():
			group = "Optional"
		}
		flags := typeName(a.GetType())
		if a.IsSensitive() {
			flags += ", Sensitive"
		}
		if wo, ok := any(a).(writeOnly); ok && wo.IsWriteOnly() {
			flags += ", Write-only"
		}
		desc := a.GetMarkdownDescription()
		if desc == "" {
			desc = a.GetDescription()
		}
		groups[group] = append(groups[group], fmt.Sprintf("- `%s` (%s) %s", n, flags, desc))
	}
	var b strings.Builder
	b.WriteString("## Schema\n")
	for _, g := range []string{"Required", "Optional", "Read-Only"} {
		if len(groups[g]) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n### %s\n\n%s\n", g, strings.Join(groups[g], "\n"))
	}
	return b.String()
}

func readExample(root string, parts ...string) string {
	raw, err := os.ReadFile(filepath.Join(append([]string{root}, parts...)...))
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(raw), "\n")
}

func frontMatter(kind, name, description string) string {
	first := strings.SplitN(description, ". ", 2)[0]
	first = strings.TrimSuffix(first, ".") + "."
	return fmt.Sprintf("---\npage_title: \"%s %s - asterius\"\nsubcategory: \"\"\ndescription: |-\n  %s\n---\n\n# %s (%s)\n\n%s\n",
		name, kind, strings.ReplaceAll(first, "\n", " "), name, kind, description)
}

const jsonAttributesNote = `
-> **JSON attributes.** Nested documents (marked *String, JSON*) are written with ` + "`jsonencode()`" + ` and read with
` + "`jsondecode()`" + `. A document read from the API is equal to the configured one when it contains it: the defaults the
API fills in (nested keys the configuration does not set) are not a difference, nor are formatting and key order.
Changes made outside Terraform to keys the configuration sets are detected; keys it does not set are not.
`

// RenderDocs returns the documentation files (relative path → content), from the examples under `examples`.
func RenderDocs(ctx context.Context, examples string) (map[string]string, error) {
	p := New("docs")()
	out := map[string]string{}

	var ps fwprovider.SchemaResponse
	p.Schema(ctx, fwprovider.SchemaRequest{}, &ps)
	var idx strings.Builder
	idx.WriteString("---\npage_title: \"asterius Provider\"\ndescription: |-\n  Manages the configuration of an Asterius Platform organization.\n---\n\n# asterius Provider\n\n")
	idx.WriteString(ps.Schema.MarkdownDescription + "\n\n")
	idx.WriteString("Authenticate with a personal API token or a service account token (Admin → Tokens). Resources declared in the " +
		"server's configuration directory (`CONFIG_DIR`) are read-only through the API (409 Conflict): import them to read them, " +
		"manage them in the configuration files.\n\nWorks with Terraform and OpenTofu (`asterius_secret.value_wo` needs 1.11 or later).\n")
	if ex := readExample(examples, "provider", "provider.tf"); ex != "" {
		idx.WriteString("\n## Example Usage\n\n```terraform\n" + ex + "\n```\n")
	}
	idx.WriteString("\n" + attributeSections(ps.Schema.Attributes))
	out["index.md"] = idx.String()

	for _, newResource := range p.Resources(ctx) {
		r := newResource()
		var meta fwresource.MetadataResponse
		r.Metadata(ctx, fwresource.MetadataRequest{ProviderTypeName: "asterius"}, &meta)
		var s fwresource.SchemaResponse
		r.Schema(ctx, fwresource.SchemaRequest{}, &s)
		desc := s.Schema.MarkdownDescription
		if desc == "" {
			desc = s.Schema.Description
		}
		var b strings.Builder
		b.WriteString(frontMatter("Resource", meta.TypeName, desc))
		if ex := readExample(examples, "resources", meta.TypeName, "resource.tf"); ex != "" {
			b.WriteString("\n## Example Usage\n\n```terraform\n" + ex + "\n```\n")
		}
		b.WriteString("\n" + attributeSections(s.Schema.Attributes))
		if strings.Contains(b.String(), "String, JSON") {
			b.WriteString(jsonAttributesNote)
		}
		if ex := readExample(examples, "resources", meta.TypeName, "import.sh"); ex != "" {
			b.WriteString("\n## Import\n\nImport is supported using the following syntax:\n\n```shell\n" + ex + "\n```\n")
		}
		out[filepath.Join("resources", strings.TrimPrefix(meta.TypeName, "asterius_")+".md")] = b.String()
	}

	for _, newDataSource := range p.DataSources(ctx) {
		d := newDataSource()
		var meta fwdatasource.MetadataResponse
		d.Metadata(ctx, fwdatasource.MetadataRequest{ProviderTypeName: "asterius"}, &meta)
		var s fwdatasource.SchemaResponse
		d.Schema(ctx, fwdatasource.SchemaRequest{}, &s)
		var b strings.Builder
		b.WriteString(frontMatter("Data Source", meta.TypeName, s.Schema.Description))
		ex := readExample(examples, "data-sources", meta.TypeName, "data-source.tf")
		if ex == "" {
			keys := ""
			if _, ok := s.Schema.Attributes["blueprint"]; ok && s.Schema.Attributes["blueprint"].IsRequired() {
				keys = "  blueprint  = \"service\"\n"
			}
			ex = fmt.Sprintf("data %q \"example\" {\n%s  identifier = \"example\"\n}", meta.TypeName, keys)
		}
		b.WriteString("\n## Example Usage\n\n```terraform\n" + ex + "\n```\n")
		b.WriteString("\n" + attributeSections(s.Schema.Attributes))
		out[filepath.Join("data-sources", strings.TrimPrefix(meta.TypeName, "asterius_")+".md")] = b.String()
	}
	return out, nil
}
