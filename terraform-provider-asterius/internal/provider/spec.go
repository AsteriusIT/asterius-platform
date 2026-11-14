package provider

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/AsteriusIT/terraform-provider-asterius/internal/client"
)

// kind is the Terraform type of an attribute.
type kind int

const (
	kString kind = iota
	kBool
	kInt
	kStringList
	kStringMap
	// kJSON: a nested document, as a JSON string (jsonencode()) with semantic equality, see JSONType.
	kJSON
)

// field maps one Terraform attribute to one property of the API document.
type field struct {
	Name        string // Terraform attribute (snake_case)
	Key         string // JSON property of the API document (camelCase)
	Kind        kind
	Description string

	// Required: set by the configuration. Otherwise optional: when left out, the server default is read back
	// (Optional + Computed), unless Nullable.
	Required bool
	// Nullable: optional without a server default (Optional only): removing it from the configuration clears it.
	Nullable bool
	// Computed: output only (managed, timestamps…).
	Computed bool
	// Volatile (with Computed): changes on every write (version, updatedAt): unknown in plans of an update.
	Volatile bool
	// ForceNew: a change replaces the resource (identifiers).
	ForceNew  bool
	Sensitive bool
	// NotInBody: part of the URL, not of the request document.
	NotInBody bool
}

// resourceSpec describes a document resource: PUT/GET/DELETE of one document by identifier.
type resourceSpec struct {
	Name        string // asterius_<Name>
	Title       string // human name, in messages
	Description string
	// Collection: API path segment (/api/v1/<Collection>/<identifier>).
	Collection string
	// Parent: attribute holding the parent identifier (entities: blueprint); the import id is then "<parent>/<identifier>".
	Parent string
	Fields []field
	// Get overrides the GET of one document (teams have no GET by identifier: the list is filtered).
	Get func(ctx context.Context, c *client.Client, parent, id string) (map[string]json.RawMessage, error)
}

func (s *resourceSpec) path(parent, id string) string {
	if s.Parent != "" {
		return client.Path("blueprints", parent, "entities", id)
	}
	return client.Path(s.Collection, id)
}

func (s *resourceSpec) get(ctx context.Context, c *client.Client, parent, id string) (map[string]json.RawMessage, error) {
	if s.Get != nil {
		return s.Get(ctx, c, parent, id)
	}
	var doc map[string]json.RawMessage
	err := c.Do(ctx, "GET", s.path(parent, id), nil, &doc)
	return doc, err
}

// Common fields.
var (
	identifierField = field{Name: "identifier", Key: "identifier", Kind: kString, Required: true, ForceNew: true, NotInBody: true,
		Description: "Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource."}
	titleField       = field{Name: "title", Key: "title", Kind: kString, Required: true, Description: "Display name."}
	descriptionField = field{Name: "description", Key: "description", Kind: kString, Description: "Description (default: empty)."}
	iconField        = field{Name: "icon", Key: "icon", Kind: kString, Nullable: true,
		Description: "Icon: a name from the icon set, an `https://` URL or a `data:image/…;base64,` URI."}
	managedField = field{Name: "managed", Key: "managed", Kind: kBool, Computed: true,
		Description: "Declared in the server's configuration directory (CONFIG_DIR): read-only through the API."}
	enabledField   = field{Name: "enabled", Key: "enabled", Kind: kBool, Description: "Enabled (default: `true`)."}
	createdAtField = field{Name: "created_at", Key: "createdAt", Kind: kString, Computed: true, Description: "Creation time (ISO 8601)."}
	updatedAtField = field{Name: "updated_at", Key: "updatedAt", Kind: kString, Computed: true, Volatile: true, Description: "Last change (ISO 8601)."}
	versionField   = field{Name: "version", Key: "version", Kind: kInt, Computed: true, Volatile: true, Description: "Version, incremented on every change."}
)

func teamGet(ctx context.Context, c *client.Client, _ string, id string) (map[string]json.RawMessage, error) {
	var teams []map[string]json.RawMessage
	if err := c.Do(ctx, "GET", client.Path("teams"), nil, &teams); err != nil {
		return nil, err
	}
	for _, t := range teams {
		var tid string
		if json.Unmarshal(t["identifier"], &tid) == nil && tid == id {
			return t, nil
		}
	}
	return nil, &client.Error{Method: "GET", Path: client.Path("teams"), Status: 404, Message: fmt.Sprintf("Team %s not found", id)}
}

// specs are the document resources (and their data sources), in documentation order.
var specs = []*resourceSpec{
	{
		Name: "blueprint", Title: "Blueprint", Collection: "blueprints",
		Description: "A blueprint: the type of catalog entities (its property schema, relations and computed properties).",
		Fields: []field{
			identifierField, titleField, descriptionField, iconField,
			{Name: "schema", Key: "schema", Kind: kJSON, Description: "Property schema (JSON Schema subset: `{ properties, required }`), as JSON."},
			{Name: "relations", Key: "relations", Kind: kJSON, Description: "Relations to other blueprints (`{ name: { target, many, title… } }`), as JSON."},
			{Name: "computed", Key: "computed", Kind: kJSON, Description: "Computed properties (JSONata over the entity), as JSON."},
			{Name: "permissions", Key: "permissions", Kind: kJSON, Nullable: true, Description: "Per-blueprint permissions (`{ read, create, update, delete }`), as JSON."},
			{Name: "ttl_property", Key: "ttlProperty", Kind: kString, Nullable: true, Description: "Date property after which entities expire."},
			managedField,
			createdAtField,
			updatedAtField,
		},
	},
	{
		Name: "entity", Title: "Entity", Parent: "blueprint",
		Description: "A catalog entity of a blueprint. The import identifier is `<blueprint>/<identifier>`. Destroying it moves it to the deleted entities of the server (restorable by an admin until purged).",
		Fields: []field{
			{Name: "blueprint", Key: "blueprint", Kind: kString, Required: true, ForceNew: true, NotInBody: true, Description: "Blueprint of the entity. Changing it replaces the entity."},
			{Name: "identifier", Key: "identifier", Kind: kString, Required: true, ForceNew: true, NotInBody: true, Description: "Identifier of the entity in its blueprint. Changing it replaces the entity."},
			{Name: "title", Key: "title", Kind: kString, Description: "Display name (default: the identifier)."},
			{Name: "team", Key: "team", Kind: kString, Description: "Owning team (identifier)."},
			{Name: "properties", Key: "properties", Kind: kJSON, Description: "Property values, validated by the blueprint schema, as JSON."},
			{Name: "relations", Key: "relations", Kind: kJSON, Description: "Related entities (`{ relation: \"id\" | [\"id\"…] }`), as JSON."},
			{Name: "computed", Key: "computed", Kind: kJSON, Computed: true, Volatile: true, Description: "Values of the blueprint's computed properties, as JSON."},
			{Name: "source", Key: "source", Kind: kString, Computed: true, Volatile: true, Description: "What wrote the entity last (`api`, `ui`, an integration…)."},
			versionField,
			createdAtField,
			updatedAtField,
		},
	},
	{
		Name: "action", Title: "Action", Collection: "actions",
		Description: "A self-service action (workflow): its trigger and form, invoker or steps, approvals and options.",
		Fields: []field{
			identifierField, titleField, descriptionField, iconField,
			{Name: "trigger", Key: "trigger", Kind: kJSON, Nullable: true, Description: "Trigger (`form`, `event`, `schedule`, `webhook`…) with its inputs, as JSON."},
			{Name: "invoker", Key: "invoker", Kind: kJSON, Nullable: true, Description: "Single-step invoker (`{ type, … }`), as JSON. Prefer `steps`."},
			{Name: "steps", Key: "steps", Kind: kJSON, Description: "Steps of the workflow, as JSON."},
			{Name: "secrets", Key: "secrets", Kind: kStringList, Nullable: true, Description: "Secrets the steps may reference."},
			enabledField,
			{Name: "blackouts", Key: "blackouts", Kind: kJSON, Nullable: true, Description: "Blackout windows, as JSON."},
			{Name: "blackout_mode", Key: "blackoutMode", Kind: kString, Nullable: true, Description: "Behaviour during a blackout window."},
			{Name: "sla_minutes", Key: "slaMinutes", Kind: kInt, Nullable: true, Description: "Expected duration of a run, in minutes."},
			{Name: "tests", Key: "tests", Kind: kJSON, Nullable: true, Description: "Workflow tests, as JSON."},
			{Name: "concurrency", Key: "concurrency", Kind: kJSON, Nullable: true, Description: "Concurrency limits, as JSON."},
			{Name: "priority", Key: "priority", Kind: kInt, Nullable: true, Description: "Queue priority of runs."},
			{Name: "vars", Key: "vars", Kind: kJSON, Nullable: true, Description: "Variables available to the steps, as JSON."},
			{Name: "outputs", Key: "outputs", Kind: kJSON, Nullable: true, Description: "Outputs of a run, as JSON."},
			managedField,
			versionField,
		},
	},
	{
		Name: "integration", Title: "Integration", Collection: "integrations",
		Description: "An ingestion integration: a pull source or an inbound webhook, and its JSONata mappings to entities.",
		Fields: []field{
			identifierField, titleField,
			{Name: "type", Key: "type", Kind: kString, Required: true, Description: "Source type (`webhook`, `github`, `azure-devops`, `kubernetes`, `connector`…)."},
			enabledField,
			{Name: "config", Key: "config", Kind: kJSON, Description: "Configuration of the source type, as JSON. Credentials must be `${secret:NAME}` references."},
			{Name: "mappings", Key: "mappings", Kind: kJSON, Description: "Mappings from source items to entities, as JSON."},
			{Name: "interval_minutes", Key: "intervalMinutes", Kind: kInt, Description: "Minutes between synchronisations (0: manual only; default 60)."},
			{Name: "schedule", Key: "schedule", Kind: kString, Nullable: true, Description: "Cron expression (5 fields, UTC) replacing `interval_minutes`."},
			{Name: "delete_missing", Key: "deleteMissing", Kind: kBool, Description: "Delete the entities it created and no longer sees (default `false`)."},
			{Name: "delete_max_percent", Key: "deleteMaxPercent", Kind: kInt, Description: "Cancel a deletion above this share of the existing entities (default 20)."},
			{Name: "delete_dry_run", Key: "deleteDryRun", Kind: kBool, Description: "Only report what would be deleted (default `false`)."},
			{Name: "priority", Key: "priority", Kind: kInt, Description: "Ownership priority when several integrations write the same entity (default 0)."},
			{Name: "primary_for", Key: "primaryFor", Kind: kStringList, Description: "Blueprints this integration is the primary source of."},
			managedField,
			{Name: "webhook_url", Key: "webhookUrl", Kind: kString, Computed: true, Description: "Inbound URL (webhook integrations)."},
			{Name: "last_success_at", Key: "lastSuccessAt", Kind: kString, Computed: true, Volatile: true, Description: "Time of the last successful synchronisation."},
		},
	},
	{
		Name: "webhook", Title: "Webhook", Collection: "webhooks",
		Description: "An outbound webhook: catalog and run events delivered to a URL.",
		Fields: []field{
			identifierField, titleField,
			{Name: "url", Key: "url", Kind: kString, Required: true, Description: "Destination URL."},
			{Name: "events", Key: "events", Kind: kStringList, Required: true, Description: "Events delivered (`entity.created`, `run.completed`…)."},
			{Name: "blueprints", Key: "blueprints", Kind: kStringList, Description: "Only events of these blueprints (default: all)."},
			{Name: "secret", Key: "secret", Kind: kString, Nullable: true, Description: "Signing secret, as a `${secret:NAME}` reference."},
			{Name: "secondary_secret", Key: "secondarySecret", Kind: kString, Nullable: true, Description: "Second signing secret during a rotation, as a `${secret:NAME}` reference."},
			{Name: "headers", Key: "headers", Kind: kStringMap, Description: "Extra request headers."},
			{Name: "filter", Key: "filter", Kind: kString, Nullable: true, Description: "JSONata condition over the event."},
			{Name: "transform", Key: "transform", Kind: kString, Nullable: true, Description: "JSONata transformation of the payload."},
			enabledField, managedField,
			{Name: "has_secret", Key: "hasSecret", Kind: kBool, Computed: true, Volatile: true, Description: "A signing secret is set."},
		},
	},
	{
		Name: "team", Title: "Team", Collection: "teams", Get: teamGet,
		Description: "A team: owner of entities, approver of requests.",
		Fields: []field{
			identifierField, titleField, descriptionField,
			{Name: "entra_group_id", Key: "entraGroupId", Kind: kString, Nullable: true, Description: "Entra ID group whose members join the team at sign-in."},
			managedField,
		},
	},
	{
		Name: "scorecard", Title: "Scorecard", Collection: "scorecards",
		Description: "A scorecard: levels and rules (JSONata) evaluated on the entities of a blueprint.",
		Fields: []field{
			identifierField, titleField, descriptionField,
			{Name: "blueprint", Key: "blueprint", Kind: kString, Required: true, Description: "Blueprint whose entities are evaluated."},
			{Name: "levels", Key: "levels", Kind: kJSON, Required: true, Description: "Levels from the lowest to the highest (`[{ name, color }]`), as JSON."},
			{Name: "rules", Key: "rules", Kind: kJSON, Required: true, Description: "Rules (`[{ identifier, title, level, expression }]`), as JSON."},
			managedField,
		},
	},
	{
		Name: "policy", Title: "Policy", Collection: "policies",
		Description: "A policy: a JSONata guard evaluated on writes (entities, runs…).",
		Fields: []field{
			identifierField, titleField, descriptionField, enabledField,
			{Name: "target", Key: "target", Kind: kString, Required: true, Description: "What the policy guards (e.g. `entity`, `run`)."},
			{Name: "match", Key: "match", Kind: kJSON, Description: "Which writes it applies to, as JSON."},
			{Name: "expression", Key: "expression", Kind: kString, Required: true, Description: "JSONata expression: the write is allowed when it is truthy."},
			{Name: "message", Key: "message", Kind: kString, Description: "Message of a denial."},
			managedField,
		},
	},
	{
		Name: "dashboard", Title: "Dashboard", Collection: "dashboards",
		Description: "A dashboard of widgets (home page of a team, of everyone, or of a blueprint's catalog page).",
		Fields: []field{
			identifierField, titleField, descriptionField,
			{Name: "team", Key: "team", Kind: kString, Nullable: true, Description: "Default home dashboard of this team."},
			{Name: "blueprint", Key: "blueprint", Kind: kString, Nullable: true, Description: "Shown on the catalog page of this blueprint."},
			{Name: "default", Key: "default", Kind: kBool, Description: "Home page for everyone (default `false`)."},
			{Name: "widgets", Key: "widgets", Kind: kJSON, Description: "Widgets, as JSON."},
			managedField,
		},
	},
	{
		Name: "connector", Title: "Connector", Collection: "connectors",
		Description: "A connector definition: a declarative HTTP API (connection form, authentication, kinds to ingest, operations).",
		Fields: []field{
			identifierField, titleField, descriptionField, iconField,
			{Name: "category", Key: "category", Kind: kString, Description: "Category (default `other`)."},
			{Name: "fields", Key: "fields", Kind: kJSON, Required: true, Description: "Connection form (object schema declaring `baseUrl`), as JSON."},
			{Name: "auth", Key: "auth", Kind: kJSON, Description: "Supported authentication methods, as JSON."},
			{Name: "auth_optional", Key: "authOptional", Kind: kBool, Description: "Connections may omit authentication (default `false`)."},
			{Name: "headers", Key: "headers", Kind: kJSON, Description: "Headers sent with every request, as JSON."},
			{Name: "test", Key: "test", Kind: kJSON, Nullable: true, Description: "Request of \"Test connection\", as JSON."},
			{Name: "kinds", Key: "kinds", Kind: kJSON, Description: "Item kinds an integration can ingest, as JSON."},
			{Name: "operations", Key: "operations", Kind: kJSON, Description: "Operations workflow steps can call, as JSON."},
			{Name: "example", Key: "example", Kind: kJSON, Nullable: true, Description: "Example connection, as JSON."},
			{Name: "builtin", Key: "builtin", Kind: kBool, Computed: true, Description: "Shipped with the platform."},
			managedField,
			versionField,
			updatedAtField,
		},
	},
	{
		Name: "connection", Title: "Connection", Collection: "connections",
		Description: "A connection: an instance of a connector (its field values and credentials references).",
		Fields: []field{
			identifierField, titleField, descriptionField,
			{Name: "connector", Key: "connector", Kind: kString, Required: true, Description: "Connector definition (identifier)."},
			{Name: "fields", Key: "fields", Kind: kJSON, Description: "Values of the connector's fields, as JSON."},
			{Name: "auth", Key: "auth", Kind: kJSON, Nullable: true, Description: "Authentication (`{ type, … }`), as JSON. Credentials must be `${secret:NAME}` references."},
			{Name: "access", Key: "access", Kind: kString, Description: "`read` or `read-write` (default `read`)."},
			{Name: "allowed", Key: "allowed", Kind: kJSON, Description: "Workflows and teams allowed to use it in automation, as JSON."},
			{Name: "api", Key: "api", Kind: kJSON, Nullable: true, Description: "Raw API calls allowed through the connection, as JSON."},
			managedField,
			versionField,
			createdAtField,
			updatedAtField,
		},
	},
}
