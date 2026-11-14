// Package provider implements the Terraform / OpenTofu provider of the Asterius Platform.
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/client"
)

// Environment variables read when the provider block leaves the attribute out.
const (
	EnvEndpoint     = "ASTERIUS_ENDPOINT"
	EnvToken        = "ASTERIUS_TOKEN"
	EnvOrganization = "ASTERIUS_ORG"
)

type asteriusProvider struct{ version string }

var _ provider.Provider = &asteriusProvider{}

// New returns the provider factory (version: set by the release build).
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &asteriusProvider{version: version} }
}

type providerModel struct {
	Endpoint     types.String `tfsdk:"endpoint"`
	Token        types.String `tfsdk:"token"`
	Organization types.String `tfsdk:"organization"`
}

func (p *asteriusProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "asterius"
	resp.Version = p.version
}

func (p *asteriusProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages the configuration of an [Asterius Platform](https://github.com/AsteriusIT/asterius-platform) " +
			"organization (catalog blueprints and entities, self-service actions, integrations, webhooks, teams, secrets, " +
			"scorecards, policies, dashboards, connectors and connections) through its REST API.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{Optional: true,
				MarkdownDescription: "Base URL of the platform, e.g. `https://portal.example.com`. Default: `ASTERIUS_ENDPOINT`."},
			"token": schema.StringAttribute{Optional: true, Sensitive: true,
				MarkdownDescription: "Personal API token or service account token (Admin → Tokens). Default: `ASTERIUS_TOKEN`."},
			"organization": schema.StringAttribute{Optional: true,
				MarkdownDescription: "Organization (slug) the resources belong to, sent as `X-Asterius-Org`. Default: " +
					"`ASTERIUS_ORG`, else the organization of the token."},
		},
	}
}

func (p *asteriusProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	for name, v := range map[string]types.String{"endpoint": cfg.Endpoint, "token": cfg.Token, "organization": cfg.Organization} {
		if v.IsUnknown() {
			resp.Diagnostics.AddAttributeError(path.Root(name), "Unknown provider configuration",
				"The provider's `"+name+"` must be known when planning (not computed from another resource).")
		}
	}
	if resp.Diagnostics.HasError() {
		return
	}
	endpoint := valueOrEnv(cfg.Endpoint, EnvEndpoint)
	token := valueOrEnv(cfg.Token, EnvToken)
	org := valueOrEnv(cfg.Organization, EnvOrganization)
	if endpoint == "" {
		resp.Diagnostics.AddAttributeError(path.Root("endpoint"), "Missing endpoint",
			"Set the provider's `endpoint` or the "+EnvEndpoint+" environment variable.")
	}
	if token == "" {
		resp.Diagnostics.AddAttributeError(path.Root("token"), "Missing API token",
			"Set the provider's `token` or the "+EnvToken+" environment variable (create one under Admin → Tokens).")
	}
	if resp.Diagnostics.HasError() {
		return
	}
	c := client.New(endpoint, token, org, "terraform-provider-asterius/"+p.version)
	resp.DataSourceData = c
	resp.ResourceData = c
}

func valueOrEnv(v types.String, env string) string {
	if !v.IsNull() && v.ValueString() != "" {
		return v.ValueString()
	}
	return os.Getenv(env)
}

func (p *asteriusProvider) Resources(context.Context) []func() resource.Resource {
	out := []func() resource.Resource{newSecretResource}
	for _, s := range specs {
		out = append(out, newDocResource(s))
	}
	return out
}

func (p *asteriusProvider) DataSources(context.Context) []func() datasource.DataSource {
	out := []func() datasource.DataSource{}
	for _, s := range specs {
		out = append(out, newDocDataSource(s))
	}
	return out
}
