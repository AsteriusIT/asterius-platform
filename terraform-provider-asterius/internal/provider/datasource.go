package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/client"
)

// docDataSource reads one document of a resourceSpec by identifier.
type docDataSource struct {
	spec   *resourceSpec
	client *client.Client
}

var _ datasource.DataSourceWithConfigure = &docDataSource{}

func newDocDataSource(s *resourceSpec) func() datasource.DataSource {
	return func() datasource.DataSource { return &docDataSource{spec: s} }
}

func (d *docDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + d.spec.Name
}

func (d *docDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	attrs := map[string]schema.Attribute{
		"id": schema.StringAttribute{Computed: true, Description: "Same as the resource's `id`."},
	}
	for _, f := range d.spec.Fields {
		key := f.Name == "identifier" || (d.spec.Parent != "" && f.Name == d.spec.Parent)
		desc := f.Description
		switch f.Kind {
		case kBool:
			attrs[f.Name] = schema.BoolAttribute{Computed: true, MarkdownDescription: desc}
		case kInt:
			attrs[f.Name] = schema.Int64Attribute{Computed: true, MarkdownDescription: desc}
		case kStringList:
			attrs[f.Name] = schema.ListAttribute{ElementType: types.StringType, Computed: true, MarkdownDescription: desc}
		case kStringMap:
			attrs[f.Name] = schema.MapAttribute{ElementType: types.StringType, Computed: true, MarkdownDescription: desc}
		case kJSON:
			attrs[f.Name] = schema.StringAttribute{CustomType: JSONType{}, Computed: true, MarkdownDescription: desc + " Decode it with jsondecode()."}
		default:
			if key {
				attrs[f.Name] = schema.StringAttribute{Required: true, MarkdownDescription: keyDescription(f)}
			} else {
				attrs[f.Name] = schema.StringAttribute{Computed: true, MarkdownDescription: desc}
			}
		}
	}
	resp.Schema = schema.Schema{Description: fmt.Sprintf("Reads a %s. %s", d.spec.Title, d.spec.Description), Attributes: attrs}
}

func keyDescription(f field) string {
	if f.Name == "identifier" {
		return "Identifier."
	}
	return "Identifier of the " + f.Name + "."
}

func (d *docDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", req.ProviderData))
		return
	}
	d.client = c
}

func (d *docDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	r := &docResource{spec: d.spec, client: d.client}
	parent, id, diags := r.keys(ctx, req.Config)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	doc, err := d.spec.get(ctx, d.client, parent, id)
	if err != nil {
		addAPIError(&resp.Diagnostics, "read", r.label(parent, id), err)
		return
	}
	resp.Diagnostics.Append(r.store(ctx, nil, &resp.State, parent, id, doc)...)
}
