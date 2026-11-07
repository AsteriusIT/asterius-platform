# Extending the platform

There are three levels of extension, from no code to code:

1. **Configuration.** Declare blueprints, actions, integrations and webhooks in YAML (`config/`) or in the admin UI.
2. **Custom services over HTTP.** Your service receives runs (webhook invoker) and reports back (callback API), and pushes data to the catalog (bulk API, inbound webhook) or exposes it for pulling (HTTP source).
3. **Code plugins.** Add an invoker or a source type in `apps/server/src`.

## Expressions and templates

The platform uses one language everywhere: [JSONata](https://jsonata.org).

- **Mappings** (integrations) are plain expressions evaluated against each item: `name`, `owner.login`, `"service"`, `$lowercase(name)`, `status.readyReplicas = spec.replicas`. Available variables are `$parent` (when `items` fans out), `$integration` (`{identifier, config}`) and `$headers` (inbound webhooks).
- **Invoker configurations** are templates. A string may embed `{{ expression }}`. A string that is only one expression keeps the expression's type, so `"{{ inputs.replicas }}"` yields a number. The context is:

  | Variable | Content |
  |---|---|
  | `run` | `{ id, url, callback: { url, token } }` |
  | `action` | `{ identifier, title, blueprint }` |
  | `inputs` | the validated form inputs |
  | `entity` | the target entity (day-2 / delete actions), with `properties` and `relations` |
  | `trigger` | `{ user: { id, email, name }, at }` |

- **Secrets** are references resolved at execution time: `${secret:NAME}` (Admin → Secrets) or `${env:NAME}` (a pod environment variable, e.g. from a Kubernetes Secret). Values never appear in configuration, the API or run logs.

## Blueprint property formats

`url`, `docs` (URL of a markdown file: the entity page gets a **Docs** tab rendering it; the platform fetches it server-side through the SSRF guard, http(s) only, 1 MB cap, GitHub/GitLab `blob` URLs are turned into raw ones, relative links and images resolve against the file URL; `GET /api/v1/blueprints/:bp/entities/:id/docs`), `email`, `date`, `date-time`, `markdown`, `yaml`, `team` (team picker), `user` (user picker, stores the email), `entity` + `blueprint: <id>` (catalog search). Other options: `enum`, `enumColors` (`{ value: color }`), `default`, `minimum`/`maximum`, `pattern`, `hidden` (not shown in tables), and `order` on the schema. Action inputs use the same formats.

## Workflows

A workflow (an *action*) is a **trigger** followed by **steps**. The usual trigger is a form submission (other triggers are described below):

```yaml
trigger:
  type: form
  on: create                       # create: self-service page · day-2 / delete: the "⋯" menu of entities of `blueprint`
  blueprint: database              # required for day-2 / delete
  inputs: { properties: { name: { type: string } }, required: [name] }   # the form → {{ inputs.* }}
  allowed: { teams: [payments] }   # who can submit it (empty: everyone; ownerTeam: the entity's team)
  approval: { required: false }    # approval before the workflow starts (or use an approval step)
```

Without `trigger` (or without `steps`), the workflow is a draft: it can be saved and edited, but not run, and users don't see it. The older flat form (`blueprint`, `trigger: day-2`, `inputs`, `allowed`, `approval` at the top level, and a single `invoker` instead of `steps`) is still accepted and read as the above.

Steps run in order, or as a graph with `needs`:

```yaml
steps:
  - id: review                     # later steps read {{ steps.review.output.<field> }}
    type: agent                    # Claude
    model: claude-opus-5-5         # default; claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1
    effort: medium                 # low | medium | high | xhigh | max
    tools: [catalog]               # read-only catalog lookups
    continueOnError: true          # AI unavailable → the workflow continues
    system: You review infrastructure requests…
    prompt: "Assess {{ inputs.name }} ({{ inputs.sizeGb }} GB) for {{ inputs.service }}"
    output:                        # structured output (omit for free text: output.text)
      properties: { risk: { type: string, enum: [low, medium, high] }, summary: { type: string } }
      required: [risk, summary]
  - id: approval
    type: approval
    if: '$not(steps.review.status = "SUCCESS" and steps.review.output.risk = "low")'
    approvers: { teams: [platform] }
    minApprovals: 1
    message: "AI review: **{{ steps.review.output.risk }}** — {{ steps.review.output.summary }}"
  - id: provision
    type: invoke
    retries: 2                     # with retryDelaySeconds (default 30), doubling
    timeoutMinutes: 60
    invoker: { type: azure-pipeline, … }
  - id: notify
    type: invoke
    needs: []                      # parallel branch from the start (default: after the previous step)
    continueOnError: true
    invoker: { type: webhook, url: …, body: { text: "{{ trigger.user.name }} requested {{ inputs.name }}" } }
  - id: summary
    type: transform                # JSONata, no external call
    needs: [provision, notify]
    output: { url: "steps.provision.link" }
```

Step outputs: invoke → the invoker result (webhook response, callback `result`); approval → `{ approved, by, comments }`; agent → the structured fields or `{ text }`; transform → its keys. Every step also exposes `steps.<id>.status` and `steps.<id>.link`. The run result is the outputs by step id.

### Other triggers

```yaml
trigger: { type: api, on: create, inputs: {…} }    # a form without a page: POST /api/v1/actions/<id>/runs
trigger:                                           # cron (5 fields) in an IANA time zone, one run per tick across all replicas
  type: schedule
  cron: "0 3 * * 1-5"
  timezone: Europe/Paris
  inputs: { day: "{{ schedule.at }}" }
trigger:                                           # catalog events and finished runs; JSONata filter over { event }
  type: event
  event: entity.created                            # entity.created | entity.updated | entity.deleted | scorecard.changed | run.finished
  blueprint: service
  filter: 'event.entity.properties.tier = "gold"'
  inputs: { name: "{{ event.entity.identifier }}" }   # the entity of the event is the run's entity
trigger:                                           # POST /api/v1/hooks/<action>, token (X-Asterius-Token) or HMAC of the body
  type: webhook
  secret: ${secret:HOOK_SECRET}
  signatureHeader: X-Hub-Signature-256             # optional: verify "sha256=<hmac>" instead of the token
  inputs: { repo: "{{ body.repository.name }}" }
```

Runs started automatically belong to the "Workflow automation" service account and record `trigger.type` (and, for event triggers, a depth that stops loops). The inputs of these triggers are free-form templates (`event`, `body`, `headers`, `query`, `schedule`); secret references are not allowed in them.

### More step types

```yaml
  - { id: nap, type: wait, duration: 15m }                         # or `until: "{{ inputs.window }}"`
  - id: gate
    type: wait
    event: { name: deployed, filter: 'event.env = "prod"' }        # POST /api/v1/runs/<run>/steps/gate/events {"name":"deployed","payload":{…}}
    timeoutMinutes: 120                                            # token: {{ steps.gate.events.token }} (or an admin token)
  - id: pick
    type: input                                                    # a form mid-run; output = the values
    message: Which cluster?
    inputs: { properties: { cluster: { type: string, enum: [eu, us] } }, required: [cluster] }
    assignees: { teams: [platform] }                               # default: the requester and admins
  - id: ok
    type: approval
    choices: [eu, us]                                              # output.choice
    fields: { properties: { ticket: { type: string } } }           # output.values
  - id: child                                                      # run another action and wait: output { runId, status, result }
    type: workflow
    action: create-repo
    inputs: { name: "{{ inputs.name }}" }
  - id: each                                                       # fan-out: one child run per item, `item` and `index` in templates
    type: workflow
    action: add-member
    inputs: { user: "{{ item }}" }
    forEach: { items: inputs.users, maxConcurrency: 3, failFast: false }   # output { results: [{ item, status, result, runId }], succeeded, failed }
```

Child runs belong to the parent's requester, link to the parent (`parent`), are cancelled with it, and are limited to 5 levels of nesting. Failed runs can be re-run (`POST /runs/:id/rerun`), resumed in place from the failed steps (`POST /runs/:id/resume`) or have one failed step retried (`POST /runs/:id/steps/:step/retry`): requester and admins only.

### Safety and testing

- `secrets: [NAME, env:OTHER]` on an action restricts the references its steps may use (checked when saving and when rendering).
- `outputSchema` on a step makes it fail when its output does not match; outputs above `STEP_OUTPUT_MAX_BYTES` fail the step.
- JSONata is stopped after `EXPR_TIMEOUT_MS` / `EXPR_MAX_DEPTH`.
- Every change of an action is a version (`GET /actions/:id/versions`, `/diff?from=&to=`, `POST /actions/:id/rollback`); runs record `actionVersion`.
- `POST /actions/:id/dry-run { definition?, inputs, entity?, mock? }` renders and validates without calling anything (the builder's Test button).
- Notifications: invokers `slack`, `teams` and `email`; defaults in Admin → Notifications (`/notification-settings`), personal preferences in the profile (`/me/notifications`); `SMTP_URL` / `SMTP_FROM` configure email.

## Invokers

| `type` | Fields | Status |
|---|---|---|
| `webhook` | `url`, `method`, `headers`, `body`, `mode: sync\|async`, `secret` (HMAC signing) | sync: 2xx = success, and the JSON response becomes the result. async: waits for the callback. |
| `github-workflow` | `owner`, `repo`, `workflow`, `ref`, `inputs`, `token`, `apiUrl` | polls the workflow run |
| `azure-pipeline` | `organization`, `project`, `pipelineId`, `branch`, `templateParameters`, `variables`, `token` (PAT or `Bearer …`) | polls the pipeline run; output `{ runId, result, url, organization, project }`. Variables need "settable at queue time" in Azure DevOps; prefer `templateParameters`. |
| `gitlab-pipeline` | `baseUrl`, `project`, `ref`, `variables`, `token` | polls the pipeline |
| `kubernetes-job` | `namespace`, `image`, `command`, `args`, `env`, `serviceAccountName`, `resources`, `securityContext` (pod; non-root by default), `activeDeadlineSeconds`, `context` | polls the Job (fails fast on image or config errors) and collects the pod logs |
| `catalog` | `operation: upsert\|delete`, `blueprint`, `identifier`, `title`, `team`, `properties`, `relations`, `merge`, `cascade` (delete: also the entities that point to it) | immediate |

Every invoker can also receive callbacks, for example a GitHub workflow that reports progress and the URL of what it created.

## The run callback API

Send `run.callback.url` and `run.callback.token` to your service, pipeline or job (the Kubernetes Job invoker sets `ASTERIUS_CALLBACK_URL` and `ASTERIUS_CALLBACK_TOKEN`). Both are scoped to the step that started it: `…/api/v1/runs/<run>/steps/<step>`. The run-level URL `…/api/v1/runs/<run>` still works (admin token) and applies to the single running step.

```bash
# progress
curl -X POST "$CALLBACK_URL/logs" -H "Authorization: Bearer $CALLBACK_TOKEN" -H 'content-type: application/json' \
  -d '{"message": "terraform apply: 3 to add"}'

# final status (+ optional link, label, result, logs)
curl -X PATCH "$CALLBACK_URL" -H "Authorization: Bearer $CALLBACK_TOKEN" -H 'content-type: application/json' \
  -d '{"status": "SUCCESS", "link": "https://console/…", "result": {"url": "https://new-service.example"}, "logs": ["done"]}'
```

`status` is `IN_PROGRESS`, `SUCCESS` or `FAILURE`. Once a run is final, further updates return 409. The token is valid for that run only. To also register the created resource in the catalog, call the entity API with a service-account token, or chain a `catalog` action.

## Catalog API (automation)

All endpoints take `Authorization: Bearer <token>`. Personal tokens come from the profile page; service accounts are created under Admin → Users. Members can write the entities of their teams; admins can write everything.

| Method & path | |
|---|---|
| `GET /api/v1/blueprints` · `PUT/DELETE /api/v1/blueprints/:bp` | blueprints (PUT/DELETE: admin) |
| `GET /api/v1/blueprints/:bp/entities?search=&team=&sort=title\|updated&limit=&offset=&filter.<prop>=<value>` | list and search |
| `GET /api/v1/entities?search=` | search across blueprints |
| `GET /api/v1/blueprints/:bp/entities/:id` · `…/related` · `…/actions` | entity, relations both ways, available day-2 actions |
| `PUT /api/v1/blueprints/:bp/entities/:id` | create or replace (idempotent) |
| `PATCH /api/v1/blueprints/:bp/entities/:id` | merge properties and relations |
| `POST /api/v1/blueprints/:bp/entities/bulk` | `{ entities: [...≤1000], merge }`, returns per-entity errors |
| `DELETE /api/v1/blueprints/:bp/entities/:id` | honours the relations' `onDelete`; the entity stays restorable for `TOMBSTONE_DAYS` (default 30) |
| `GET …/entities/:id/history` · `POST …/entities/:id/history/:version/revert` | versions with diff, actor and source; a revert writes a new version |
| `GET /api/v1/deleted-entities` · `POST …/entities/:id/restore` · `DELETE /api/v1/deleted-entities/:bp/:id` | tombstones (admin) |
| `GET …/entities/:id/scorecards` · `GET /api/v1/scorecards/:id/summary` | scorecard results of an entity, distribution and trend |
| `POST /api/v1/blueprints/:bp/impact` · `…/migrate` · `GET …/validation` | check a proposed blueprint against its entities, migrate (rename / default / remove), last background report (admin) |
| `GET /api/v1/dashboards/resolve?blueprint=` · `GET …/dashboards/:id/data` | the dashboard to show and its widget data |
| `GET /api/v1/actions` · `POST /api/v1/actions/:id/runs` `{ entity?, inputs }` | trigger actions from scripts |
| `GET /api/v1/runs?mine=true&status=…` · `GET /api/v1/runs/:id` | runs with logs and approvals |
| `POST /api/v1/runs/:id/approve\|reject\|cancel` | `{ comment }` |
| `POST /api/v1/ingest/:integration` | inbound webhook (integration secret, not a user token) |

Entity identifiers may contain `/`, `:` and `@` (third-party ids); URL-encode them in paths.

## Catalog governance

All of these are declared in the configuration files like the other resources (`scorecards:`, `dashboards:`), or in the admin UI.

**Scorecards.** Rules are JSONata over the entity (`properties`, `relations`, `computed`, `team`, `related.<relation>[]` for the entities it points to, `incoming.<blueprint.relation>[]` for those pointing to it). Levels are ordered; an entity reaches a level when it passes the rules of that level and the levels below. Results are recomputed on every entity write and hourly, level changes emit `scorecard.changed`, and workflows can read `entity.scorecards.<id>.level` / `.rank` in `if` conditions and templates.

```yaml
scorecards:
  - identifier: production-readiness
    title: Production readiness
    blueprint: service
    levels: [{ name: Bronze }, { name: Silver }, { name: Gold }]
    rules:
      - { identifier: has_owner, title: Has an owner, level: Bronze, expression: team != null }
      - { identifier: has_docs, title: Has docs, level: Silver, expression: properties.docs != null }
```

**Computed properties** (`computed:` in a blueprint). `calculated` is a JSONata expression evaluated on read; `mirror` copies a property (or `title`, `team`) of the related entity; `aggregation` is `count`, `sum`, `min` or `max` over the entities pointing to this one through `blueprint.relation`, with an optional JSONata `filter`. Mirrors and aggregations are materialised when either side is written, so they work in `filter.<name>=` queries. Values appear under `entity.computed`.

**Relations** accept `onDelete` (`ignore` default, `restrict`, `cascade`, `detach`), `inverseTitle` (name of the reverse relation on the target page) and `requireExisting` (entities written from the UI or API must point to existing entities). Changing a relation target re-indexes automatically; `POST /blueprints/:bp/repair-relations` rebuilds the index from the entities.

**Dashboards.** Widgets: `count` (optionally `groupBy` a property, `team` or `source`), `scorecard`, `runs`, `approvals`, `table` (a saved view), `markdown`. A dashboard with `default: true` is the home page; with `team:` it is the home page of that team; with `blueprint:` it appears on that blueprint's catalog page.

## Outbound webhooks

The payload has the form `{ id, type, at, blueprint, actor, data }`. Event types are `entity.created`, `entity.updated` (with `data.before`), `entity.deleted`, `run.created`, `run.updated` and `scorecard.changed` (`data: { scorecard, entity, from, to, passed, total }`). Requests carry the headers `X-Asterius-Event`, `X-Asterius-Delivery` and `X-Asterius-Signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<body>")`. Receivers must recompute it over the raw body, compare in constant time, and reject timestamps more than **5 minutes** from their clock (replay protection); the timestamp is refreshed on every retry. `secret` and `secondarySecret` must be references (`${secret:NAME}` / `${env:NAME}`); literal values are rejected.

**Rotating a signing secret without downtime:** (1) create the new secret and set it as `secondarySecret`: deliveries now carry two `v1=` entries, one per secret; (2) make receivers accept either (any matching `v1`) and switch them to the new secret; (3) move the new secret to `secret` and remove `secondarySecret`.

Receiver sketch (Node):

```ts
function verify(header: string, rawBody: string, secret: string, toleranceSec = 300) {
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return parts.some(([k, v]) => k === 'v1' && v?.length === expected.length && timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
}
```

The `webhook` invoker (action steps) keeps its simpler `X-Asterius-Signature: sha256=<HMAC of the body>`. Delivery is at-least-once: retries back off from 30 s to 6 h (8 attempts), so deduplicate on `id`. Client errors (4xx other than 408/429) are not retried.

## Writing a code plugin

An invoker (`apps/server/src/actions/types.ts`):

```ts
import { registerInvoker } from './actions/invokers/index.js';

registerInvoker({
  info: { type: 'servicenow-change', title: 'ServiceNow change', description: 'Open a change request', example: { type: 'servicenow-change', instance: 'acme' } },
  validate(c) { if (!c.instance) throw new Error('servicenow-change: instance is required'); },
  async start({ ctx, config, log }) {
    const id = await createChange(config, ctx.inputs);          // your call
    await log(`Change ${id} opened`);
    return { status: 'IN_PROGRESS', state: { id }, link: `https://${config.instance}.service-now.com/…` };
  },
  async poll({ config }, state) {
    const s = await changeState(config, state.id as string);
    return s === 'closed' ? { status: 'SUCCESS' } : { status: 'IN_PROGRESS', state, statusLabel: s };
  },
});
```

A source (`apps/server/src/integrations/types.ts`) implements `list(kind, { config, log })` as an async generator that yields pages of raw items. Mappings take care of the rest. Register built-ins in `invokers/index.ts` or `sources/index.ts`. Their `info.example` appears as a template in the admin UI. Code that touches the database runs inside an organization: read it with `orgId()` (`orgs/context.ts`) and filter on `org_id`; background jobs enter it with `withOrg()`. Sources declare `info.fields` like invokers do: the integration form renders them on its Connection tab (without `fields`, a JSON editor).

To give your invoker a form in the action builder, declare `info.fields` (`PluginField` in `packages/shared`): each field has a `key`, a `label` and a `kind` (`text`, `textarea`, `number`, `boolean`, `select` with `options`, `secret`, `list`, `keyvalue`, `json`, `blueprint`), plus optional `required`, `help`, `placeholder` and `advanced`. Without `fields`, the builder shows a JSON editor for the invoker settings.

### Loading plugins without forking

Set `PLUGIN_DIR` (a directory of `*.mjs` / `*.js` files or sub-directories with an `index.mjs`) and/or `PLUGINS` (comma separated packages or paths installed in the image). Each module default-exports a function that receives the `PluginApi` (`registerSource`, `registerInvoker`, `log`); types are in `packages/plugin-sdk`:

```js
// plugins/jira.mjs
export default function register(api) {
  api.registerInvoker({ info: { type: 'jira-ticket', title: 'Jira ticket', description: '…', example: { type: 'jira-ticket' } }, validate() {}, async start({ config }) { /* … */ } });
}
```

Plugins load before the configuration files, so declared resources may use them. A plugin that fails to load is logged and skipped. In-process plugins run with the server's privileges: install only code you trust.

### Out-of-process plugins (any language)

The `external` source and invoker call a service of yours over HTTP, so plugins can be written in any language and run isolated. Authenticate with `headers` or an `auth` block (OAuth2 client credentials, GitHub App, cloud identities, SigV4, mTLS).

- Source: `POST {url}/list` with `{ kind, config, cursor, state, startedAt }` answers `{ items, nextCursor?, state?, incomplete? }`. Call again with `cursor = nextCursor` until it is absent. Return `incomplete` when the listing was cut short (nothing is deleted then) and `state` to be handed back on the next run (incremental listings).
- Invoker: `POST {url}/start` with `{ config, run, action, inputs, entity, trigger, steps }`, then `POST {url}/poll` with `{ config, state, run }` while the answer is `IN_PROGRESS`, and optionally `POST {url}/cancel`. Answers are `{ status: "IN_PROGRESS" | "SUCCESS" | "FAILURE", state?, link?, statusLabel?, result? }`.

`config` is the configuration without `url`, `auth` and `headers`.
