package provider

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/acctest"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/client"
)

// Acceptance tests: real API calls against ASTERIUS_ENDPOINT (TF_ACC=1). scripts/local-server.sh starts a throwaway
// server whose configuration directory declares the blueprint `tf-managed`.

func randID(prefix string) string {
	return prefix + "-" + acctest.RandStringFromCharSet(8, "abcdefghijklmnopqrstuvwxyz0123456789")
}

func accClient() *client.Client {
	return client.New(os.Getenv(EnvEndpoint), os.Getenv(EnvToken), os.Getenv(EnvOrganization), "acc-test")
}

// checkDestroyed: every resource of the type is gone from the API after destroy.
func checkDestroyed(spec *resourceSpec) resource.TestCheckFunc {
	return func(s *terraform.State) error {
		for _, rs := range s.RootModule().Resources {
			if rs.Type != "asterius_"+spec.Name {
				continue
			}
			parent := rs.Primary.Attributes[spec.Parent]
			_, err := spec.get(context.Background(), accClient(), parent, rs.Primary.Attributes["identifier"])
			if err == nil {
				return fmt.Errorf("%s %s still exists", spec.Title, rs.Primary.ID)
			}
			if !client.IsNotFound(err) {
				return err
			}
		}
		return nil
	}
}

func specByName(name string) *resourceSpec {
	for _, s := range specs {
		if s.Name == name {
			return s
		}
	}
	panic(name)
}

func noChanges() resource.ConfigPlanChecks {
	return resource.ConfigPlanChecks{PostApplyPostRefresh: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}
}

func TestAccBlueprintAndEntity(t *testing.T) {
	bp := randID("svc")
	resources := func(title, tier string) string {
		return fmt.Sprintf(`
resource "asterius_team" "owners" {
  identifier = "%[1]s-team"
  title      = "Owners"
}

resource "asterius_blueprint" "service" {
  identifier  = %[1]q
  title       = %[2]q
  description = "Deployable services"
  icon        = "server"
  schema = jsonencode({
    properties = {
      tier     = { type = "string", title = "Tier", enum = ["gold", "silver"] }
      language = { type = "string", title = "Language" }
    }
    required = ["tier"]
  })
}

resource "asterius_entity" "payments" {
  blueprint  = asterius_blueprint.service.identifier
  identifier = "payments-api"
  title      = "Payments API"
  team       = asterius_team.owners.identifier
  properties = jsonencode({ tier = %[3]q, language = "go" })
}
`, bp, title, tier)
	}
	config := func(title, tier string) string {
		return resources(title, tier) + `
data "asterius_blueprint" "service" {
  identifier = asterius_blueprint.service.identifier
}

data "asterius_entity" "payments" {
  blueprint  = asterius_entity.payments.blueprint
  identifier = asterius_entity.payments.identifier
}
`
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy: resource.ComposeTestCheckFunc(
			checkDestroyed(specByName("entity")), checkDestroyed(specByName("blueprint")), checkDestroyed(specByName("team"))),
		Steps: []resource.TestStep{
			{
				Config:           config("Service", "gold"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("asterius_blueprint.service", "id", bp),
					resource.TestCheckResourceAttr("asterius_blueprint.service", "managed", "false"),
					resource.TestCheckResourceAttrSet("asterius_blueprint.service", "created_at"),
					resource.TestCheckResourceAttr("asterius_blueprint.service", "relations", "{}"),
					resource.TestCheckResourceAttr("asterius_entity.payments", "id", bp+"/payments-api"),
					resource.TestCheckResourceAttr("asterius_entity.payments", "version", "1"),
					resource.TestCheckResourceAttr("data.asterius_blueprint.service", "title", "Service"),
					resource.TestCheckResourceAttr("data.asterius_blueprint.service", "icon", "server"),
					resource.TestCheckResourceAttr("data.asterius_entity.payments", "properties", `{"language":"go","tier":"gold"}`),
					resource.TestCheckResourceAttr("data.asterius_entity.payments", "team", bp+"-team"),
				),
			},
			{
				Config:           config("Services", "silver"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("asterius_blueprint.service", "title", "Services"),
					resource.TestCheckResourceAttr("asterius_entity.payments", "version", "2"),
					resource.TestCheckResourceAttr("data.asterius_entity.payments", "properties", `{"language":"go","tier":"silver"}`),
				),
			},
			{ResourceName: "asterius_blueprint.service", ImportState: true, ImportStateVerify: true},
			{ResourceName: "asterius_entity.payments", ImportState: true, ImportStateVerify: true},
			{ResourceName: "asterius_team.owners", ImportState: true, ImportStateVerify: true},
			{
				// The entity is deleted outside Terraform: the next plan creates it again (without the data sources,
				// which would read the missing entity while planning).
				PreConfig: func() {
					if err := accClient().Do(context.Background(), "DELETE", client.Path("blueprints", bp, "entities", "payments-api"), nil, nil); err != nil {
						t.Fatal(err)
					}
				},
				Config: resources("Services", "silver"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("asterius_entity.payments", plancheck.ResourceActionCreate),
				}},
			},
			{Config: config("Services", "silver"), ConfigPlanChecks: noChanges()},
		},
	})
}

func TestAccEntityImportBadID(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:        `resource "asterius_entity" "x" {` + "\n" + `blueprint = "a"` + "\n" + `identifier = "b"` + "\n}",
			ResourceName:  "asterius_entity.x",
			ImportState:   true,
			ImportStateId: "no-slash",
			ExpectError:   regexp.MustCompile(`Expected <blueprint>/<identifier>`),
		}},
	})
}

func TestAccManagedBlueprint(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				// Declared in CONFIG_DIR by scripts/local-server.sh.
				Config:      `resource "asterius_blueprint" "m" {` + "\n" + `identifier = "tf-managed"` + "\n" + `title = "Mine"` + "\n}",
				ExpectError: regexp.MustCompile(`managed by configuration`),
			},
			{
				// Imported, it can be read (and planned) but not changed.
				Config:        `resource "asterius_blueprint" "m" {` + "\n" + `identifier = "tf-managed"` + "\n" + `title = "Managed by configuration"` + "\n}",
				ResourceName:  "asterius_blueprint.m",
				ImportState:   true,
				ImportStateId: "tf-managed",
				ImportStateCheck: func(states []*terraform.InstanceState) error {
					if len(states) != 1 || states[0].Attributes["managed"] != "true" {
						return fmt.Errorf("expected one managed blueprint, got %v", states)
					}
					return nil
				},
			},
		},
	})
}

func TestAccExistingResourceIsNotTakenOver(t *testing.T) {
	id := randID("existing")
	resource.Test(t, resource.TestCase{
		PreCheck: func() {
			testAccPreCheck(t)
			if err := accClient().Do(context.Background(), "PUT", client.Path("teams", id), map[string]any{"title": "Existing"}, nil); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = accClient().Do(context.Background(), "DELETE", client.Path("teams", id), nil, nil) })
		},
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:      fmt.Sprintf("resource \"asterius_team\" \"t\" {\nidentifier = %q\ntitle = \"Mine\"\n}", id),
			ExpectError: regexp.MustCompile(`already exists`),
		}},
	})
}

func TestAccActionWebhookIntegrationSecret(t *testing.T) {
	id := randID("tf")
	secret := "TF_" + acctest.RandStringFromCharSet(8, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
	config := func(title, value string) string {
		return fmt.Sprintf(`
resource "asterius_secret" "token" {
  name        = %[2]q
  value       = %[4]q
  description = "Ingest token"
}

resource "asterius_secret" "wo" {
  name             = "%[2]s_WO"
  value_wo         = %[4]q
  value_wo_version = 1
}

resource "asterius_blueprint" "service" {
  identifier = %[1]q
  title      = "Service"
}

resource "asterius_action" "register" {
  identifier  = %[1]q
  title       = %[3]q
  description = "Register a service"
  trigger = jsonencode({
    type      = "form"
    on        = "create"
    blueprint = asterius_blueprint.service.identifier
    inputs = {
      properties = { name = { type = "string", title = "Name" } }
      required   = ["name"]
    }
  })
  steps = jsonencode([{
    id   = "run"
    name = "Register"
    type = "invoke"
    invoker = {
      type       = "catalog"
      operation  = "upsert"
      blueprint  = asterius_blueprint.service.identifier
      identifier = "{{ inputs.name }}"
    }
  }])
}

resource "asterius_webhook" "events" {
  identifier = %[1]q
  title      = %[3]q
  url        = "https://hooks.example.com/asterius"
  events     = ["entity.created", "entity.updated"]
  blueprints = [asterius_blueprint.service.identifier]
  secret     = "$${secret:${asterius_secret.token.name}}"
  headers    = { X-Team = "platform" }
}

resource "asterius_integration" "inbound" {
  identifier = %[1]q
  title      = %[3]q
  type       = "webhook"
  config     = jsonencode({ secret = "$${secret:${asterius_secret.token.name}}" })
  mappings = jsonencode([{
    entity = {
      blueprint  = asterius_blueprint.service.identifier
      identifier = "body.name"
      title      = "body.name"
    }
  }])
}
`, id, secret, title, value)
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy: resource.ComposeTestCheckFunc(
			checkDestroyed(specByName("action")), checkDestroyed(specByName("webhook")), checkDestroyed(specByName("integration"))),
		Steps: []resource.TestStep{
			{
				Config:           config("Register", "a-long-enough-secret-value-0123456789"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("asterius_action.register", "enabled", "true"),
					resource.TestCheckResourceAttr("asterius_action.register", "managed", "false"),
					resource.TestCheckResourceAttr("asterius_action.register", "version", "1"),
					resource.TestCheckResourceAttr("asterius_webhook.events", "has_secret", "true"),
					resource.TestCheckResourceAttr("asterius_webhook.events", "enabled", "true"),
					resource.TestCheckResourceAttr("asterius_integration.inbound", "interval_minutes", "60"),
					resource.TestMatchResourceAttr("asterius_integration.inbound", "webhook_url", regexp.MustCompile(`/api/v1/ingest/.+/`+id+`$`)),
					resource.TestCheckResourceAttr("asterius_secret.token", "description", "Ingest token"),
					resource.TestCheckResourceAttrSet("asterius_secret.token", "updated_at"),
					resource.TestCheckNoResourceAttr("asterius_secret.wo", "value_wo"),
				),
			},
			{
				Config:           config("Register a service", "another-long-enough-secret-value-0123456789"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("asterius_action.register", "title", "Register a service"),
					resource.TestCheckResourceAttr("asterius_action.register", "version", "2"),
				),
			},
			{ResourceName: "asterius_action.register", ImportState: true, ImportStateVerify: true,
				// The imported documents carry the defaults the API fills in (approval, retries…).
				ImportStateVerifyIgnore: []string{"trigger", "steps"}},
			{ResourceName: "asterius_webhook.events", ImportState: true, ImportStateVerify: true},
			{ResourceName: "asterius_integration.inbound", ImportState: true, ImportStateVerify: true,
				// Defaults the API fills into each mapping are in the imported document, not in the configuration.
				ImportStateVerifyIgnore: []string{"mappings"}},
			{ResourceName: "asterius_secret.token", ImportState: true, ImportStateVerify: true,
				ImportStateVerifyIgnore: []string{"value"}},
		},
	})
}

func TestAccScorecardPolicyDashboard(t *testing.T) {
	id := randID("tf")
	config := func(title string) string {
		return fmt.Sprintf(`
resource "asterius_blueprint" "service" {
  identifier = %[1]q
  title      = "Service"
  schema     = jsonencode({ properties = { owner = { type = "string" } } })
}

resource "asterius_scorecard" "basics" {
  identifier = %[1]q
  title      = %[2]q
  blueprint  = asterius_blueprint.service.identifier
  levels     = jsonencode([{ name = "Bronze", color = "orange" }, { name = "Gold" }])
  rules = jsonencode([
    { identifier = "has_owner", title = "Has an owner", level = "Bronze", expression = "$exists(properties.owner)" },
  ])
}

resource "asterius_policy" "guard" {
  identifier = %[1]q
  title      = %[2]q
  target     = "entity"
  expression = "true"
  message    = "Denied"
}

resource "asterius_dashboard" "home" {
  identifier = %[1]q
  title      = %[2]q
  blueprint  = asterius_blueprint.service.identifier
}
`, id, title)
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy: resource.ComposeTestCheckFunc(
			checkDestroyed(specByName("scorecard")), checkDestroyed(specByName("policy")), checkDestroyed(specByName("dashboard"))),
		Steps: []resource.TestStep{
			{
				Config:           config("Basics"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("asterius_policy.guard", "enabled", "true"),
					resource.TestCheckResourceAttr("asterius_policy.guard", "match", "{}"),
					resource.TestCheckResourceAttr("asterius_dashboard.home", "default", "false"),
					resource.TestCheckResourceAttr("asterius_dashboard.home", "widgets", "[]"),
				),
			},
			{Config: config("Basics v2"), ConfigPlanChecks: noChanges()},
			{ResourceName: "asterius_scorecard.basics", ImportState: true, ImportStateVerify: true},
			{ResourceName: "asterius_policy.guard", ImportState: true, ImportStateVerify: true},
			{ResourceName: "asterius_dashboard.home", ImportState: true, ImportStateVerify: true},
		},
	})
}

func TestAccConnectorConnection(t *testing.T) {
	id := randID("tf")
	config := func(title string) string {
		return fmt.Sprintf(`
resource "asterius_secret" "token" {
  name  = "%[3]s"
  value = "a-long-enough-secret-value-0123456789"
}

resource "asterius_connector" "inventory" {
  identifier = %[1]q
  title      = %[2]q
  category   = "other"
  fields = jsonencode({
    properties = { baseUrl = { type = "string", title = "Server URL", default = "https://inventory.example.com" } }
  })
  auth = jsonencode([{ type = "bearer", title = "API token" }])
  test = jsonencode({ method = "GET", path = "/health" })
  kinds = jsonencode({
    host = { title = "Hosts", method = "GET", path = "/hosts", itemsPath = "items" }
  })
}

resource "asterius_connection" "prod" {
  identifier = %[1]q
  title      = %[2]q
  connector  = asterius_connector.inventory.identifier
  fields     = jsonencode({ baseUrl = "https://inventory.example.com" })
  auth       = jsonencode({ type = "bearer", token = "$${secret:${asterius_secret.token.name}}" })
}
`, id, title, "TF_CONN_"+acctest.RandStringFromCharSet(6, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             resource.ComposeTestCheckFunc(checkDestroyed(specByName("connection")), checkDestroyed(specByName("connector"))),
		Steps: []resource.TestStep{
			{
				Config:           config("Inventory"),
				ConfigPlanChecks: noChanges(),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("asterius_connector.inventory", "builtin", "false"),
					resource.TestCheckResourceAttr("asterius_connection.prod", "access", "read"),
				),
			},
			{Config: config("Inventory v2"), ConfigPlanChecks: noChanges()},
			{ResourceName: "asterius_connector.inventory", ImportState: true, ImportStateVerify: true,
				ImportStateVerifyIgnore: []string{"auth", "test", "kinds"}},
			{ResourceName: "asterius_connection.prod", ImportState: true, ImportStateVerify: true},
		},
	})
}
