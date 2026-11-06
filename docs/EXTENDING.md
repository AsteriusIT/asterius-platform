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

`url`, `email`, `date`, `date-time`, `markdown`, `yaml`, `team` (team picker), `user` (user picker, stores the email), `entity` + `blueprint: <id>` (catalog search). Other options: `enum`, `enumColors` (`{ value: color }`), `default`, `minimum`/`maximum`, `pattern`, `hidden` (not shown in tables), and `order` on the schema. Action inputs use the same formats.

## Workflows

A workflow (an *action*) is a **trigger** followed by **steps**. Today the trigger is a form submission:

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
| `DELETE /api/v1/blueprints/:bp/entities/:id` | |
| `GET /api/v1/actions` · `POST /api/v1/actions/:id/runs` `{ entity?, inputs }` | trigger actions from scripts |
| `GET /api/v1/runs?mine=true&status=…` · `GET /api/v1/runs/:id` | runs with logs and approvals |
| `POST /api/v1/runs/:id/approve\|reject\|cancel` | `{ comment }` |
| `POST /api/v1/ingest/:integration` | inbound webhook (integration secret, not a user token) |

Entity identifiers may contain `/`, `:` and `@` (third-party ids); URL-encode them in paths.

## Outbound webhooks

The payload has the form `{ id, type, at, blueprint, actor, data }`. Event types are `entity.created`, `entity.updated` (with `data.before`), `entity.deleted`, `run.created` and `run.updated`. Requests carry the headers `X-Asterius-Event`, `X-Asterius-Delivery` and `X-Asterius-Signature: sha256=<HMAC-SHA256(body, secret)>`. Delivery is at-least-once: retries back off from 30 s to 6 h (8 attempts), so deduplicate on `id`. Client errors (4xx other than 408/429) are not retried.

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

A source (`apps/server/src/integrations/types.ts`) implements `list(kind, { config, log })` as an async generator that yields pages of raw items. Mappings take care of the rest. Register built-ins in `invokers/index.ts` or `sources/index.ts`. Their `info.example` appears as a template in the admin UI.

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
