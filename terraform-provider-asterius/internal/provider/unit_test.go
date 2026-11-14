package provider

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"testing"

	fwdatasource "github.com/hashicorp/terraform-plugin-framework/datasource"
	fwprovider "github.com/hashicorp/terraform-plugin-framework/provider"
	fwresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// Unit tests: no server. The schema checks run in process; the lifecycle tests run Terraform (the CLI must be in PATH)
// against fakeAPI.

func TestSchemas(t *testing.T) {
	ctx := context.Background()
	p := New("test")()
	names := map[string]bool{}
	for _, newResource := range p.Resources(ctx) {
		r := newResource()
		var meta fwresource.MetadataResponse
		r.Metadata(ctx, fwresource.MetadataRequest{ProviderTypeName: "asterius"}, &meta)
		var resp fwresource.SchemaResponse
		r.Schema(ctx, fwresource.SchemaRequest{}, &resp)
		if resp.Diagnostics.HasError() {
			t.Fatalf("%s: %v", meta.TypeName, resp.Diagnostics)
		}
		if diags := resp.Schema.ValidateImplementation(ctx); diags.HasError() {
			t.Fatalf("%s: %v", meta.TypeName, diags)
		}
		if _, ok := resp.Schema.Attributes["id"]; !ok {
			t.Errorf("%s has no id", meta.TypeName)
		}
		names[meta.TypeName] = true
	}
	for _, want := range []string{"asterius_blueprint", "asterius_action", "asterius_integration", "asterius_webhook", "asterius_team",
		"asterius_secret", "asterius_entity", "asterius_scorecard", "asterius_policy", "asterius_dashboard", "asterius_connector", "asterius_connection"} {
		if !names[want] {
			t.Errorf("resource %s is missing", want)
		}
	}
	for _, newDataSource := range p.DataSources(ctx) {
		d := newDataSource()
		var meta fwdatasource.MetadataResponse
		d.Metadata(ctx, fwdatasource.MetadataRequest{ProviderTypeName: "asterius"}, &meta)
		var resp fwdatasource.SchemaResponse
		d.Schema(ctx, fwdatasource.SchemaRequest{}, &resp)
		if diags := resp.Schema.ValidateImplementation(ctx); diags.HasError() {
			t.Fatalf("%s: %v", meta.TypeName, diags)
		}
	}
	var resp fwprovider.SchemaResponse
	p.Schema(ctx, fwprovider.SchemaRequest{}, &resp)
	if diags := resp.Schema.ValidateImplementation(ctx); diags.HasError() {
		t.Fatal(diags)
	}
}

func TestSpecsAreConsistent(t *testing.T) {
	for _, s := range specs {
		seen := map[string]bool{}
		for _, f := range s.Fields {
			if seen[f.Name] {
				t.Errorf("%s: duplicate attribute %s", s.Name, f.Name)
			}
			seen[f.Name] = true
			if f.Required && (f.Computed || f.Nullable) {
				t.Errorf("%s.%s: required and computed/nullable", s.Name, f.Name)
			}
			if f.Volatile && !f.Computed {
				t.Errorf("%s.%s: volatile but not computed", s.Name, f.Name)
			}
			if f.Name != strings.ToLower(f.Name) || f.Description == "" {
				t.Errorf("%s.%s: snake_case name and a description", s.Name, f.Name)
			}
		}
		if !seen["identifier"] || (s.Parent != "" && !seen[s.Parent]) {
			t.Errorf("%s: identifier (and parent) attributes", s.Name)
		}
	}
}

func TestUnitLifecycle(t *testing.T) {
	api := newFakeAPI(t)
	config := func(title, tier string) string {
		return api.providerBlock() + fmt.Sprintf(`
resource "asterius_team" "platform" {
  identifier = "platform"
  title      = %[1]q
}

resource "asterius_blueprint" "service" {
  identifier = "service"
  title      = %[1]q
  schema     = jsonencode({ properties = { tier = { type = "string" } } })
}

resource "asterius_entity" "api" {
  blueprint  = asterius_blueprint.service.identifier
  identifier = "payments-api"
  team       = asterius_team.platform.identifier
  properties = jsonencode({ tier = %[2]q })
}

resource "asterius_action" "deploy" {
  identifier = "deploy"
  title      = %[1]q
  steps      = jsonencode([{ id = "run", type = "invoke", invoker = { type = "webhook", url = "https://ci.example.com" } }])
}

resource "asterius_webhook" "events" {
  identifier = "events"
  title      = %[1]q
  url        = "https://hooks.example.com"
  events     = ["entity.created"]
  secret     = "$${secret:HOOK}"
}

data "asterius_entity" "api" {
  blueprint  = asterius_entity.api.blueprint
  identifier = asterius_entity.api.identifier
}
`, title, tier)
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy: func(*terraform.State) error {
			if n := api.count(); n != 0 {
				return fmt.Errorf("%d documents left after destroy", n)
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config:           config("One", "gold"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					// As written, although the server added nested defaults.
					resource.TestCheckResourceAttr("asterius_blueprint.service", "schema", `{"properties":{"tier":{"type":"string"}}}`),
					resource.TestCheckResourceAttr("asterius_blueprint.service", "description", ""),
					resource.TestCheckNoResourceAttr("asterius_blueprint.service", "icon"),
					resource.TestCheckResourceAttr("asterius_entity.api", "id", "service/payments-api"),
					resource.TestCheckResourceAttr("asterius_entity.api", "title", "payments-api"),
					resource.TestCheckResourceAttr("asterius_entity.api", "version", "1"),
					resource.TestCheckResourceAttr("asterius_webhook.events", "has_secret", "true"),
					resource.TestCheckResourceAttr("asterius_webhook.events", "blueprints.#", "0"),
					resource.TestCheckResourceAttr("data.asterius_entity.api", "properties", `{"filledByServer":true,"tier":"gold"}`),
				),
			},
			{
				Config:           config("Two", "silver"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("asterius_action.deploy", "title", "Two"),
					resource.TestCheckResourceAttr("asterius_action.deploy", "version", "2"),
					resource.TestCheckResourceAttr("asterius_entity.api", "version", "2"),
				),
			},
			{ResourceName: "asterius_team.platform", ImportState: true, ImportStateVerify: true},
			{ResourceName: "asterius_webhook.events", ImportState: true, ImportStateVerify: true},
			{ResourceName: "asterius_entity.api", ImportState: true, ImportStateVerify: true, ImportStateVerifyIgnore: []string{"properties"}},
			{ResourceName: "asterius_blueprint.service", ImportState: true, ImportStateVerify: true, ImportStateVerifyIgnore: []string{"schema"}},
			{
				ResourceName:  "asterius_entity.api",
				ImportState:   true,
				ImportStateId: "payments-api",
				ExpectError:   regexp.MustCompile(`Expected <blueprint>/<identifier>`),
			},
		},
	})
}

func TestUnitManaged(t *testing.T) {
	api := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:      api.providerBlock() + `resource "asterius_team" "t" {` + "\n" + `identifier = "managed-ops"` + "\n" + `title = "Ops"` + "\n}",
			ExpectError: regexp.MustCompile(`(?s)Team managed-ops is managed by configuration.*CONFIG_DIR`),
		}},
	})
}

func TestUnitSecretWriteOnly(t *testing.T) {
	api := newFakeAPI(t)
	config := func(value string, version int) string {
		return api.providerBlock() + fmt.Sprintf(`
resource "asterius_secret" "plain" {
  name  = "PLAIN"
  value = "plain-%[1]s"
}

resource "asterius_secret" "wo" {
  name             = "WO"
  value_wo         = "wo-%[1]s"
  value_wo_version = %[2]d
  description      = "write-only"
}
`, value, version)
	}
	check := func(plain, wo string) resource.TestCheckFunc {
		return func(*terraform.State) error {
			if got := api.secretValue("PLAIN"); got != plain {
				return fmt.Errorf("PLAIN = %q, want %q", got, plain)
			}
			if got := api.secretValue("WO"); got != wo {
				return fmt.Errorf("WO = %q, want %q", got, wo)
			}
			return nil
		}
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config:           config("1", 1),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(check("plain-1", "wo-1"),
					resource.TestCheckNoResourceAttr("asterius_secret.wo", "value_wo"),
					resource.TestCheckResourceAttr("asterius_secret.wo", "description", "write-only"),
					resource.TestCheckResourceAttr("asterius_secret.plain", "description", "")),
			},
			// A new write-only value without a new version is not sent (Terraform cannot see it).
			{Config: config("2", 1), ConfigPlanChecks: noChanges(), Check: check("plain-2", "wo-1")},
			{Config: config("3", 2), ConfigPlanChecks: noChanges(), Check: check("plain-3", "wo-3")},
			{ResourceName: "asterius_secret.plain", ImportState: true, ImportStateVerify: true, ImportStateVerifyIgnore: []string{"value"}},
		},
	})
}

func TestUnitSecretNeedsOneValue(t *testing.T) {
	api := newFakeAPI(t)
	for _, values := range []string{`value = "a"` + "\n" + `value_wo = "b"`, ``} {
		resource.UnitTest(t, resource.TestCase{
			ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
			Steps: []resource.TestStep{{
				Config:      api.providerBlock() + `resource "asterius_secret" "x" {` + "\n" + `name = "X"` + "\n" + values + "\n}",
				PlanOnly:    true,
				ExpectError: regexp.MustCompile(`exactly one of`),
			}},
		})
	}
}

func TestUnitProviderConfiguration(t *testing.T) {
	t.Setenv(EnvEndpoint, "")
	t.Setenv(EnvToken, "")
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:      `resource "asterius_team" "t" {` + "\n" + `identifier = "x"` + "\n" + `title = "X"` + "\n}",
			ExpectError: regexp.MustCompile(`Missing endpoint`),
		}},
	})
}
