package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/client"
)

// secretResource: PUT /secrets/{name} with the value; the API never returns values (GET /secrets lists names).
type secretResource struct{ client *client.Client }

var (
	_ resource.ResourceWithConfigure      = &secretResource{}
	_ resource.ResourceWithImportState    = &secretResource{}
	_ resource.ResourceWithValidateConfig = &secretResource{}
)

func newSecretResource() resource.Resource { return &secretResource{} }

type secretModel struct {
	ID             types.String `tfsdk:"id"`
	Name           types.String `tfsdk:"name"`
	Value          types.String `tfsdk:"value"`
	ValueWO        types.String `tfsdk:"value_wo"`
	ValueWOVersion types.Int64  `tfsdk:"value_wo_version"`
	Description    types.String `tfsdk:"description"`
	UpdatedAt      types.String `tfsdk:"updated_at"`
}

type secretInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	UpdatedAt   string `json:"updatedAt"`
}

func (r *secretResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_secret"
}

func (r *secretResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An encrypted secret, referenced as `${secret:NAME}` in the other resources. The value is write " +
			"only: the API never returns it, so changes made outside Terraform are not detected. Set either `value` (kept, " +
			"sensitive, in the Terraform state) or `value_wo` (Terraform 1.11+: never stored; bump `value_wo_version` to " +
			"send a new value).",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, Description: "Same as `name`.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"name": schema.StringAttribute{Required: true, MarkdownDescription: "Name (`${secret:NAME}`). Changing it replaces the secret.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"value": schema.StringAttribute{Optional: true, Sensitive: true,
				MarkdownDescription: "Value. Stored in the Terraform state; never read back from the API."},
			"value_wo": schema.StringAttribute{Optional: true, Sensitive: true, WriteOnly: true,
				MarkdownDescription: "Write-only value (Terraform 1.11+): sent on create and when `value_wo_version` changes, never stored."},
			"value_wo_version": schema.Int64Attribute{Optional: true,
				MarkdownDescription: "Change it to send `value_wo` again."},
			"description": schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Description (default: empty).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"updated_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Last change of the value (ISO 8601)."},
		},
	}
}

func (r *secretResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m secretModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() || m.Value.IsUnknown() || m.ValueWO.IsUnknown() {
		return
	}
	if m.Value.IsNull() == m.ValueWO.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("value"), "Invalid secret", "Set exactly one of `value` and `value_wo`.")
	}
}

func (r *secretResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *secretResource) find(ctx context.Context, name string) (*secretInfo, error) {
	var list []secretInfo
	if err := r.client.Do(ctx, "GET", client.Path("secrets"), nil, &list); err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].Name == name {
			return &list[i], nil
		}
	}
	return nil, nil
}

// put sends the value (from the plan, or the write-only one from the configuration).
func (r *secretResource) put(ctx context.Context, plan, config secretModel) (*secretInfo, error) {
	value := plan.Value.ValueString()
	if plan.Value.IsNull() {
		value = config.ValueWO.ValueString()
	}
	body := map[string]any{"value": value}
	if !plan.Description.IsUnknown() && !plan.Description.IsNull() {
		body["description"] = plan.Description.ValueString()
	}
	name := plan.Name.ValueString()
	if err := r.client.Do(ctx, "PUT", client.Path("secrets", name), body, nil); err != nil {
		return nil, err
	}
	info, err := r.find(ctx, name)
	if err == nil && info == nil {
		err = fmt.Errorf("secret %s not listed after it was written", name)
	}
	return info, err
}

func (r *secretResource) apply(ctx context.Context, plan, config secretModel, state *secretModel) error {
	info, err := r.put(ctx, plan, config)
	if err != nil {
		return err
	}
	*state = plan
	state.ID = plan.Name
	state.ValueWO = types.StringNull()
	state.Description = types.StringValue(info.Description)
	state.UpdatedAt = types.StringValue(info.UpdatedAt)
	return nil
}

func (r *secretResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan, config secretModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	name := plan.Name.ValueString()
	existing, err := r.find(ctx, name)
	if err != nil {
		addAPIError(&resp.Diagnostics, "read", "Secret "+name, err)
		return
	}
	if existing != nil {
		resp.Diagnostics.AddError("Secret "+name+" already exists",
			"Import it to manage it with Terraform: terraform import asterius_secret.<name> "+name)
		return
	}
	var state secretModel
	if err := r.apply(ctx, plan, config, &state); err != nil {
		addAPIError(&resp.Diagnostics, "write", "Secret "+name, err)
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *secretResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, config secretModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state secretModel
	if err := r.apply(ctx, plan, config, &state); err != nil {
		addAPIError(&resp.Diagnostics, "write", "Secret "+plan.Name.ValueString(), err)
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *secretResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state secretModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	info, err := r.find(ctx, state.Name.ValueString())
	if err != nil {
		addAPIError(&resp.Diagnostics, "read", "Secret "+state.Name.ValueString(), err)
		return
	}
	if info == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	state.ID = state.Name
	state.Description = types.StringValue(info.Description)
	state.UpdatedAt = types.StringValue(info.UpdatedAt)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *secretResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state secretModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Do(ctx, "DELETE", client.Path("secrets", state.Name.ValueString()), nil, nil)
	if err != nil && !client.IsNotFound(err) {
		addAPIError(&resp.Diagnostics, "delete", "Secret "+state.Name.ValueString(), err)
	}
}

func (r *secretResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
