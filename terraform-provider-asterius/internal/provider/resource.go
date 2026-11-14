package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/client"
)

// docResource is a resource built from a resourceSpec: PUT (create, update), GET (read), DELETE by identifier.
type docResource struct {
	spec   *resourceSpec
	client *client.Client
}

var (
	_ resource.ResourceWithConfigure   = &docResource{}
	_ resource.ResourceWithImportState = &docResource{}
)

func newDocResource(s *resourceSpec) func() resource.Resource {
	return func() resource.Resource { return &docResource{spec: s} }
}

func (r *docResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + r.spec.Name
}

func (r *docResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	idDesc := "Same as `identifier`."
	if r.spec.Parent != "" {
		idDesc = fmt.Sprintf("`<%s>/<identifier>`.", r.spec.Parent)
	}
	attrs := map[string]schema.Attribute{
		"id": schema.StringAttribute{
			Computed: true, Description: idDesc,
			PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
		},
	}
	for _, f := range r.spec.Fields {
		attrs[f.Name] = resourceAttribute(f)
	}
	resp.Schema = schema.Schema{Description: r.spec.Description, Attributes: attrs}
}

// resourceAttribute: Required, Optional (Nullable), Optional+Computed (server default) or Computed (output only).
func resourceAttribute(f field) schema.Attribute {
	required := f.Required
	optional := !f.Required && !f.Computed
	computed := f.Computed || (optional && !f.Nullable)
	// Stable values are kept from the state in plans; volatile ones are unknown after an update.
	keep := computed && !f.Volatile
	switch f.Kind {
	case kBool:
		a := schema.BoolAttribute{Required: required, Optional: optional, Computed: computed, Sensitive: f.Sensitive, MarkdownDescription: f.Description}
		if keep {
			a.PlanModifiers = append(a.PlanModifiers, boolplanmodifier.UseStateForUnknown())
		}
		if f.ForceNew {
			a.PlanModifiers = append(a.PlanModifiers, boolplanmodifier.RequiresReplace())
		}
		return a
	case kInt:
		a := schema.Int64Attribute{Required: required, Optional: optional, Computed: computed, Sensitive: f.Sensitive, MarkdownDescription: f.Description}
		if keep {
			a.PlanModifiers = append(a.PlanModifiers, int64planmodifier.UseStateForUnknown())
		}
		if f.ForceNew {
			a.PlanModifiers = append(a.PlanModifiers, int64planmodifier.RequiresReplace())
		}
		return a
	case kStringList:
		a := schema.ListAttribute{ElementType: types.StringType, Required: required, Optional: optional, Computed: computed, Sensitive: f.Sensitive, MarkdownDescription: f.Description}
		if keep {
			a.PlanModifiers = append(a.PlanModifiers, listplanmodifier.UseStateForUnknown())
		}
		if f.ForceNew {
			a.PlanModifiers = append(a.PlanModifiers, listplanmodifier.RequiresReplace())
		}
		return a
	case kStringMap:
		a := schema.MapAttribute{ElementType: types.StringType, Required: required, Optional: optional, Computed: computed, Sensitive: f.Sensitive, MarkdownDescription: f.Description}
		if keep {
			a.PlanModifiers = append(a.PlanModifiers, mapplanmodifier.UseStateForUnknown())
		}
		if f.ForceNew {
			a.PlanModifiers = append(a.PlanModifiers, mapplanmodifier.RequiresReplace())
		}
		return a
	default:
		a := schema.StringAttribute{Required: required, Optional: optional, Computed: computed, Sensitive: f.Sensitive, MarkdownDescription: f.Description}
		if f.Kind == kJSON {
			a.CustomType = JSONType{}
		}
		if keep {
			a.PlanModifiers = append(a.PlanModifiers, stringplanmodifier.UseStateForUnknown())
		}
		if f.ForceNew {
			a.PlanModifiers = append(a.PlanModifiers, stringplanmodifier.RequiresReplace())
		}
		return a
	}
}

func (r *docResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", req.ProviderData))
		return
	}
	r.client = c
}

// keys reads the parent and identifier attributes.
func (r *docResource) keys(ctx context.Context, g getter) (parent, id string, diags diag.Diagnostics) {
	var v types.String
	diags.Append(g.GetAttribute(ctx, path.Root("identifier"), &v)...)
	id = v.ValueString()
	if r.spec.Parent != "" {
		var p types.String
		diags.Append(g.GetAttribute(ctx, path.Root(r.spec.Parent), &p)...)
		parent = p.ValueString()
	}
	return parent, id, diags
}

func (r *docResource) label(parent, id string) string {
	if parent != "" {
		return fmt.Sprintf("%s %s/%s", r.spec.Title, parent, id)
	}
	return fmt.Sprintf("%s %s", r.spec.Title, id)
}

// body builds the request document from the plan: known, non-null attributes that are not output only.
func (r *docResource) body(ctx context.Context, plan getter) (map[string]any, diag.Diagnostics) {
	var diags diag.Diagnostics
	doc := map[string]any{}
	for _, f := range r.spec.Fields {
		if f.Computed || f.NotInBody {
			continue
		}
		v, d := getValue(ctx, plan, f)
		diags.Append(d...)
		out, ok, d := toAPI(ctx, v)
		diags.Append(d...)
		if ok {
			doc[f.Key] = out
		}
	}
	return doc, diags
}

// store writes the API document into the state; `ref` (the plan, or the prior state) keeps the identifiers and the
// empty values as written.
func (r *docResource) store(ctx context.Context, ref getter, state setter, parent, id string, doc map[string]json.RawMessage) diag.Diagnostics {
	var diags diag.Diagnostics
	tfID := id
	if r.spec.Parent != "" {
		tfID = parent + "/" + id
	}
	diags.Append(state.SetAttribute(ctx, path.Root("id"), types.StringValue(tfID))...)
	for _, f := range r.spec.Fields {
		var value attr.Value
		switch {
		case f.Name == "identifier":
			value = types.StringValue(id)
		case f.Name == r.spec.Parent && r.spec.Parent != "":
			value = types.StringValue(parent)
		default:
			got, d := fromAPI(ctx, f.Kind, doc[f.Key])
			diags.Append(d...)
			var prior attr.Value
			if ref != nil {
				prior, d = getValue(ctx, ref, f)
				diags.Append(d...)
			}
			value = reconcile(f, prior, got)
		}
		diags.Append(state.SetAttribute(ctx, path.Root(f.Name), value)...)
	}
	return diags
}

func (r *docResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	parent, id, diags := r.keys(ctx, req.Plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	// PUT is an upsert: refuse to silently take over a resource that exists already.
	existing, err := r.spec.get(ctx, r.client, parent, id)
	switch {
	case err == nil:
		var managed bool
		_ = json.Unmarshal(existing["managed"], &managed)
		if managed {
			resp.Diagnostics.AddError(managedSummary(r.label(parent, id)), managedDetail)
		} else {
			resp.Diagnostics.AddError(r.label(parent, id)+" already exists",
				fmt.Sprintf("Import it to manage it with Terraform: terraform import asterius_%s.<name> %s", r.spec.Name, importID(parent, id)))
		}
		return
	case !client.IsNotFound(err):
		addAPIError(&resp.Diagnostics, "read", r.label(parent, id), err)
		return
	}
	r.write(ctx, req.Plan, &resp.State, parent, id, &resp.Diagnostics)
}

func (r *docResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	parent, id, diags := r.keys(ctx, req.Plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, req.Plan, &resp.State, parent, id, &resp.Diagnostics)
}

func (r *docResource) write(ctx context.Context, plan getter, state setter, parent, id string, diags *diag.Diagnostics) {
	body, d := r.body(ctx, plan)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	if err := r.client.Do(ctx, "PUT", r.spec.path(parent, id), body, nil); err != nil {
		addAPIError(diags, "write", r.label(parent, id), err)
		return
	}
	// Read back (some PUT answers leave out fields, e.g. webhook secret references).
	doc, err := r.spec.get(ctx, r.client, parent, id)
	if err != nil {
		addAPIError(diags, "read", r.label(parent, id), err)
		return
	}
	diags.Append(r.store(ctx, plan, state, parent, id, doc)...)
}

func (r *docResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	parent, id, diags := r.keys(ctx, req.State)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	doc, err := r.spec.get(ctx, r.client, parent, id)
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "read", r.label(parent, id), err)
		return
	}
	resp.Diagnostics.Append(r.store(ctx, req.State, &resp.State, parent, id, doc)...)
}

func (r *docResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	parent, id, diags := r.keys(ctx, req.State)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Do(ctx, "DELETE", r.spec.path(parent, id), nil, nil)
	if err != nil && !client.IsNotFound(err) {
		addAPIError(&resp.Diagnostics, "delete", r.label(parent, id), err)
	}
}

func (r *docResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parent, id := "", req.ID
	if r.spec.Parent != "" {
		var ok bool
		parent, id, ok = strings.Cut(req.ID, "/")
		if !ok || parent == "" || id == "" {
			resp.Diagnostics.AddError("Invalid import identifier", fmt.Sprintf("Expected <%s>/<identifier>, got %q.", r.spec.Parent, req.ID))
			return
		}
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root(r.spec.Parent), parent)...)
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("identifier"), id)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

func importID(parent, id string) string {
	if parent != "" {
		return parent + "/" + id
	}
	return id
}
