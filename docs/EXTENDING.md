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

## Pruning webhook deliveries

Pull integrations remove vanished entities with `deleteMissing`; a webhook only sees one delivery, so a mapping can declare that
the delivery is the complete set for one scope with `prune`:

```yaml
mappings:
  - kind: bom
    items: components
    prune: { relation: service, value: metadata.component.name }   # JSONata on the delivered item
    entity: { blueprint: sbom-component, ... }
```

After the delivery is applied, the entities of `entity.blueprint` that have `relation` pointing at `value`, that were written by
this integration and that the delivery did not emit are deleted (with the usual `onDelete` rules, tombstones, history and events).
Safe by construction: only entities whose owner is this integration are candidates (hand-made entities and other integrations'
are never deleted); entities written after the delivery started (concurrent deliveries on other replicas) are kept; nothing is
pruned when the mapping did not match the item or when anything in the delivery failed. Ingestion writes are not evaluated by
`policies` (neither upserts nor prunes), like `deleteMissing`; the integration secret is what authorises them.

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

The pre-start approval takes the same reminders and escalation as approval steps, plus an expiry:
`approval: { required: true, approvers: { teams: [platform] }, remindEvery: 1d, maxReminders: 3, escalate: { after: 2d, approvers: { roles: [admin] } }, expireAfter: 7d, onExpiry: reject }`
(`onExpiry`: `fail`, the default, fails the run; `reject` rejects it; `approve` and `skip` start the workflow anyway).

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

Step outputs: invoke → the invoker result (webhook response, callback `result`); approval → `{ approved, by, comments }` (plus `tiers: [{ name, approved, by, comments }]` for tiered steps, `delegated: [{ by, for }]` when a delegate decided, `expired: true` after an `onExpiry` outcome); agent → the structured fields or `{ text }`; transform → its keys. Every step also exposes `steps.<id>.status` and `steps.<id>.link`. The run result is the outputs by step id.

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
  event: entity.created                            # entity.created | entity.updated | entity.deleted | entity.expired | scorecard.changed | run.finished
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

**Missed ticks and fan-out.** A schedule whose ticks passed while no worker ran (downtime, upgrade) catches up according to `catchUp`; it can also start one run per entity of a blueprint on every tick:

```yaml
trigger:
  type: schedule
  cron: "0 * * * *"
  catchUp: all              # none (default: one run for the oldest missed tick, the others dropped) | last | all
  maxCatchUp: 24            # all: the most recent missed ticks, within the last 7 days (default 10, max 100)
  entities:                 # optional fan-out: one run per matching entity, on that entity (like a day-2 action)
    blueprint: service
    filter: 'entity.properties.tier = "gold"'   # JSONata over { entity, schedule }
    limit: 200              # runs per tick (default 200, max 1000)
  inputs: { name: "{{ entity.identifier }}", at: "{{ schedule.at }}" }
```

Each run's `schedule.at` (and `trigger.tick`) is the tick it stands for. Ticks are exactly-once across replicas: the replica that moves `next_fire_at` forward owns every tick up to now, and every run carries the idempotency key `schedule:<tick>` (`schedule:<tick>:<entity>` for a fan-out), so a replayed tick starts nothing twice.

**Blackout windows.** Freeze periods of a workflow, at the action level:

```yaml
blackouts:
  - { name: weekend, cron: "0 18 * * 5", duration: 62h, timezone: Europe/Paris }   # recurring: start (cron) + duration (30m, 2h, 1d, 1h30m; max 31d)
  - { name: year-end, from: "2026-12-20T00:00:00Z", to: "2027-01-04T00:00:00Z" }   # fixed dates
blackoutMode: defer         # skip (default) | defer
```

During a window, schedule, event and webhook starts are skipped (audited as `run.skipped`) or, with `defer`, held and started once the window ends (`run.deferred`; a webhook still answers 202, with `runId: null` and `deferredUntil`). Form and API submissions are refused with a 409 that names the window; an admin may pass `"overrideBlackout": true` in `POST /api/v1/actions/<id>/runs` (audited as `run.blackout_overridden`). `GET /api/v1/actions/<id>` returns `blackout: { active, next }`, shown on the form and in the trigger editor.

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
  - id: signoff
    type: approval
    tiers:                                                         # instead of approvers / minApprovals: decided in order
      - { name: lead, approvers: { ownerTeam: true } }
      - { name: director, approvers: { roles: [director] }, minApprovals: 1 }
    remindEvery: 1d                                                # re-notify who has not decided (also on input steps)
    maxReminders: 3                                                # default 3
    escalate: { after: 2d, approvers: { roles: [admin] } }         # they become eligible too, and are notified
    timeoutMinutes: 10080                                          # the expiry (default 7 days)
    onExpiry: skip                                                 # fail (default) | reject | approve | skip
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

**Approvals.** A tier opens once the previous one has its `minApprovals`; a reject at any tier rejects the step, and one person decides at most once per step. Reminders go (email / Slack, per each person's preferences) to the approvers who have not decided, every `remindEvery`, at most `maxReminders` times. Escalation adds `escalate.approvers` (to the open tier) after `escalate.after` and logs it on the run. `onExpiry` on an approval step wins over any generic timeout handling. **Delegation** (out of office): `PUT /api/v1/me/delegation { delegate: <user id or email>, startsAt?, endsAt? }` (Profile → Out of office; `GET`/`DELETE` the same path; admins: `GET /api/v1/delegations`, `DELETE /api/v1/delegations/:userId`). While it is in effect the delegate may decide what the person is eligible for (approvals, pre-start approvals, input steps) and is notified of it, never their own request unless `allowSelfApproval`; the decision records both (`approvals[].onBehalfOf`). Delegation is one hop.

Child runs belong to the parent's requester, link to the parent (`parent`), are cancelled with it, and are limited to 5 levels of nesting.

### Control flow

```yaml
vars:                                    # templates evaluated once when the run starts (inputs, entity, trigger)
  slug: "{{ $lowercase(inputs.name) }}"  # → {{ vars.slug }} in every template and condition
outputs:                                 # templates evaluated when the run ends: the run result (a parent's steps.<id>.output.result)
  url: "https://{{ steps.deploy.output.host }}/{{ vars.slug }}"
steps:
  - id: route
    type: switch                         # decided by the engine, output { case }
    cases:                               # in order: the first true JSONata `when` wins
      - { id: prod, when: 'inputs.env = "prod"' }
      - { id: test, when: 'inputs.env in ["dev", "test"]' }
    default: other                       # when nothing matches (omitted: no branch, case = null)
  - { id: approve, type: approval, case: route.prod }           # skipped unless route took "prod"
  - id: deploy
    type: invoke
    needs: [route, approve]
    case: [route.prod, route.test]       # any of these branches
    timeoutMinutes: 30
    onTimeout: fail                      # fail (default) · skip: SKIPPED, the run goes on · continue: FAILURE treated like continueOnError
    invoker: { type: webhook, … }
  - id: rollback
    type: invoke
    needs: [deploy]
    when: failure                        # success (default) · failure · always
    invoker: { type: webhook, … }
  - { id: cleanup, type: transform, needs: [deploy], when: always, output: { done: "true" } }
  - id: notify
    type: invoke
    forEach: { items: inputs.channels, failFast: false }   # inline loop: item / index in templates, no child runs
    invoker: { type: webhook, url: …, body: { channel: "{{ item }}" } }
```

- **`when`.** `success` runs after the dependencies succeeded (a failed or blocked one skips it as *blocked*, and that cascades). `failure` runs only when at least one dependency failed (also a `continueOnError` failure) or was blocked by a failure; otherwise it is skipped. `always` runs once every dependency is done, whatever the outcome. `if` is evaluated after `when`. Cancelling a run stops everything, cleanups included.
- **Handled failures.** The run fails when a step failed without `continueOnError`, **unless** a `when: failure` step that has it upstream (through `needs`) succeeded: the failure is *handled* and the run succeeds with the label `Recovered: <steps>`. A failing handler fails the run.
- **Switch.** Steps of the other branches are SKIPPED (not blocked): their dependents run as after a false `if`, so a join step after several branches runs. Put `case` on every step of a multi-step branch. The switch must be upstream of the steps naming its cases, and the case ids are checked when saving.
- **Inline `forEach`** (invoke, agent, transform): output `{ results: [{ item, status, output, error? }], succeeded, failed }`; the step fails when an item failed (items not run after a `failFast` stop are `SKIPPED`), at most 200 items. Agent items run in parallel up to `maxConcurrency`; transform and invoke items run one at a time. Invoke items may poll or wait for their callback: the callback (`PATCH /runs/:id/steps/:step`) reports the item in flight, the next item starts after it. Each item gets its own idempotency key (`<run>/<step>/<index>`). `retries` cannot be combined with an inline loop (it would repeat the items that already ran).
- **`vars` / `outputs`** cannot reference secrets (their values are stored with the run). A `vars` error fails the run at start; an `outputs` error fails a run that would have succeeded. Without `outputs`, the result is the outputs by step id.
- **Resume / retry** start over the failed steps (not the handled ones) and every finished step downstream of them, including cleanups and branch decisions. Failed runs can be re-run (`POST /runs/:id/rerun`), resumed in place from the failed steps (`POST /runs/:id/resume`) or have one failed step retried (`POST /runs/:id/steps/:step/retry`): requester and admins only.

### Service levels (SLA)

`slaMinutes` on a step starts a clock when the step starts; `slaMinutes` on the action starts one when the run is
requested (approval time included). When the step (or run) is still not finished after it, the platform reports it
once: `step.sla_breached` / `run.sla_breached` webhook events, an in-app notification (and email / Slack following the
`runs` preference) to the requester and the organization's admins, a warning in the run log, the
`asterius_sla_breaches_total{kind,action}` counter and an "SLA breached" badge on the run page. An SLA never stops
anything (use `timeoutMinutes` for that).

```yaml
actions:
  - identifier: provision-db
    slaMinutes: 240            # whole run, from the request
    steps:
      - id: dba
        type: approval
        slaMinutes: 60         # nobody approved within an hour → notify
```

### Run artifacts

Steps can attach files (plans, reports, generated configuration) to the run. Upload with the step's callback token
while the run is not finished, or as the requester / an admin at any time:

```bash
curl -X POST "$CALLBACK_URL/artifacts" -H "Authorization: Bearer $CALLBACK_TOKEN" -H 'content-type: application/json' \
  -d "{\"name\": \"plan.txt\", \"contentType\": \"text/plain\", \"content\": \"$(base64 -w0 plan.txt)\"}"
```

A webhook invoker in `sync` mode may answer `{ …, "artifacts": [{ "name", "contentType", "content" (base64) }] }`: the
files are stored (rejected ones are logged) and removed from the step output. Limits: `ARTIFACT_MAX_BYTES` per file
(default 10 MB, 413 above), `RUN_ARTIFACTS_MAX` per run (default 20, 409 above), content types in
`ARTIFACT_CONTENT_TYPES` (no HTML or SVG by default). `GET /runs/:id` lists them (`artifacts`, also
`GET /runs/:id/artifacts`); `GET /runs/:id/artifacts/:artifactId` downloads one with the run's read permission, always as
an attachment (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, sandbox CSP). Later steps read
`steps.<id>.artifacts` (`[{ id, name, contentType, size, sha256, url }]`). Artifacts are deleted with their run.

### Workflow tests

An action may declare tests, run with mocks by `POST /actions/:id/tests/run { name?, definition? }` (admin; `definition`
tests an unsaved draft), the Tests dialog of the workflow editor, and `node dist/cli.js actions test [id] [--name <test>]
[--org <slug>] [--json]` (exit code 1 when a test fails, for CI). Nothing external is called and no run is created:

- `invoke`, `agent` and `workflow` steps must be mocked (`mocks.<step>: { status: SUCCESS | FAILURE, output }`), an
  unmocked one is an error; their configuration is still rendered and validated;
- approvals are approved, waits resolve at once, input steps answer with sample values, unless mocked;
- conditions, transforms, `needs`, `continueOnError` and `outputSchema` behave as in a run; secrets are masked.

`expect.status` defaults to `SUCCESS`; `expect.steps.<id>.output` and `expect.outputs` (run result: outputs by step id)
are partial matches. Results list each test's `passed`, simulated step statuses and `diffs: [{ path, expected, actual }]`.
When `CONFIG_DIR` applies an action with tests, they are run and failures are logged (never blocking).

```yaml
    tests:
      - name: dev deploys without approval
        inputs: { env: dev }
        mocks:
          deploy: { status: SUCCESS, output: { url: https://dev.example } }
        expect:
          steps: { gate: { status: SKIPPED } }
          outputs: { deploy: { url: https://dev.example } }
```

### Run operations

```yaml
concurrency:                                   # at most `max` runs of a group at a time
  group: "deploy-{{ entity.identifier }}"      # template over action, inputs, entity, trigger (default: the action id)
  max: 1                                       # 1..100, default 1
  mode: queue                                  # queue | cancel-in-progress | reject
priority: 10                                   # -100..100, default 0: queued runs start by priority, then age
```

- **queue**: extra runs stay `QUEUED` ("Waiting for 2 run(s) in group deploy-api") and start one by one as slots free up, by priority then creation order; the head of a full group blocks the runs behind it.
- **cancel-in-progress**: a new run cancels the older runs of its group (pending approval, queued or in progress, two-phase cancel), keeping the `max - 1` newest, then waits for the slot.
- **reject**: creating a run while the group is full answers `409` (a run waiting for its own approval holds its slot).
- Every run goes through the gate: forms, the API, schedules, events, webhooks, re-runs and child runs of `workflow` steps (a child rejected by its group fails the parent's step). Resuming or retrying a finished run needs a free slot again.
- Admins may override the priority of one run: `POST /actions/<id>/runs {"inputs": …, "priority": 50}` (others get `403`).

Operators can also act on a healthy run:

- `POST /runs/:id/pause` / `POST /runs/:id/unpause` (requester and admins): a paused run starts no new step. Running steps finish, and waits and approvals still complete, but their successors wait for the unpause. The run deadline (`RUN_TIMEOUT_HOURS`) does not run while paused: unpausing extends it, and the timeouts of queued steps, by the paused time. Step timeouts of running, waiting and approval steps keep running. Child runs are not paused.
- `POST /runs/:id/steps/:step/skip {"comment": "…"}` and `POST /runs/:id/steps/:step/complete {"comment": "…", "output": {…}}` (admins, comment required): force a pending, queued, running, waiting or failed step to `SKIPPED` or `SUCCESS` (the output is checked against `outputSchema`). The steps skipped because it failed are evaluated again and a failed run continues. The change is fenced by the step's attempt, so a worker still executing it can no longer report a result. A skipped running job is asked to stop and child runs are cancelled. Both are logged on the run and audited (`run.step_skipped`, `run.step_completed`; `run.paused`, `run.unpaused`).

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
| `tekton` | `pipeline`, `namespace`, `params`, `serviceAccountName`, `context` | creates a `PipelineRun` of an existing Pipeline and follows its `Succeeded` condition (the platform's service account needs create/get/patch on `pipelineruns.tekton.dev`) |
| `scaffolder` | `provider: github\|gitlab\|azure-devops`, `mode: pull-request\|new-repository`, `templateRepo`, `templatePath`, `templateRef`, `repo`, `baseBranch`, `targetPath`, `variables`, `title`, `branch`, `token`, `apiUrl`/`baseUrl`, `organization`/`project` (azure-devops); new-repository: `description`, `visibility`, `defaultBranch`, `topics`, `team`, `teamPermission`, `ownerType`, `reuseExisting`, `namespace` (gitlab); `reviewers` (azure-devops) | renders a template repository (`{{ variable }}` placeholders in paths and text files; unknown variables fail) and publishes it. Immediate; output below |

### Scaffolder output and modes

The scaffolder result has a stable shape, usable by later steps (`{{ steps.scaffold.output.prUrl }}`):

```json
{ "repoUrl": "https://github.com/org/new", "prUrl": "https://github.com/org/new/pull/7", "branch": "scaffold/abcdef12",
  "commit": "<sha of the branch tip>", "provider": "github", "files": ["README.md", "src/index.ts"] }
```

`pullRequest` (same as `prUrl`) and `number` (PR/MR number) are still returned for compatibility. `prUrl` is `null` when no pull request is opened.

`mode: pull-request` (default) pushes a branch to the existing repository `repo` and opens a PR/MR, and `mode: new-repository` creates the repository; both are implemented for `github`, `gitlab` and `azure-devops`. Re-runs are idempotent: an existing branch gets new commits on top and an open PR/MR for the same source and target is reused. Code lives in `apps/server/src/actions/invokers/scaffolder/`: `config.ts` (zod schema), `types.ts` (`ScaffoldPublisher`, `ScaffoldOutput`), one module per provider registered in `index.ts`.

#### Authoring scaffolder templates

The template is a directory of a repository (`templateRepo`, optionally `templatePath` and `templateRef`).

- Placeholders `{{ name }}` and `{{ cookiecutter.name }}` (the `cookiecutter.` prefix is optional, spaces inside the braces are allowed) are replaced in **file paths and in text file contents**, with the values of `variables`. Variable names match `[A-Za-z_][A-Za-z0-9_]*`. A placeholder without a matching variable **fails the run** (no silent typos). There are no filters or conditionals.
- Binary files (those containing a NUL byte) are copied as is.
- Limits: at most 200 files, 512 KiB per file and 5 MiB in total.
- `targetPath` (default `.`) is the directory in the target repository that receives the files; `..` is rejected, as is any rendered path with an empty or `..` segment.
- A complete golden path (new GitHub repository from a template, then a `catalog` step registering the service with `{{ steps.create.output.repoUrl }}`) is the `scaffold-service-template` action in `examples/demo-config/self-service.yaml`.

#### GitHub

**GitHub `pull-request` re-runs are idempotent:** an existing branch gets new commits on top (it is only created when missing), files whose content is unchanged are skipped, and an open PR for `branch` -> `baseBranch` is reused (same `prUrl`/`number`) instead of opening a duplicate.

**GitHub `new-repository`:** `repo` is `owner/name`. The repository is created under the organization (`POST /orgs/{org}/repos`) or the authenticated user (`POST /user/repos`); `ownerType: org|user` forces the choice, otherwise it is `user` when the token's login equals the owner. Fields: `description`, `visibility` (`private` default, `internal`, `public`), `baseBranch` (default branch name, default `main`; the initial branch is renamed if the account default differs), `topics` (list or comma separated), `team` + `teamPermission` (default `push`, organization repositories only: `PUT /orgs/{org}/teams/{team}/repos/{owner}/{repo}`). The repository is created with `auto_init` (the Git Data API cannot write to an empty repository), then the rendered files are committed in one commit (blobs, tree, commit, ref update) on the default branch; template files override the generated README. Output: `repoUrl` = repository URL, `prUrl` = null, `branch` = default branch, `commit` = new tip.
If the name already exists (422) the run does not fail only when the repository is **empty** (a previous attempt created it but did not push; it is filled through the contents API for the first file, then Git Data) or `reuseExisting: true` (a commit is added on its default branch; identical content creates no commit). Otherwise it fails so that an unrelated repository is never written to.

#### Azure DevOps

```json
{ "type": "scaffolder", "provider": "azure-devops", "mode": "new-repository",
  "organization": "https://dev.azure.com/my-org", "project": "Platform",
  "templateRepo": "service-template", "templatePath": "skeleton", "templateRef": "main",
  "repo": "{{ inputs.name }}", "defaultBranch": "main", "variables": { "name": "{{ inputs.name }}" },
  "token": "${secret:ADO_PAT}" }
```

- `organization` is the organization URL and `project` the project, as for the `azure-pipeline` invoker; `templateRepo` and `repo` are repository names in that project (`other-project/repo` selects another project). `templateRef` is a branch, `refs/tags/<tag>` or a commit sha (default: the repository's default branch).
- `token`: a PAT (sent as Basic) or `Bearer <Entra token>`. PAT scope: **Code (Read & write)** for `pull-request`, **Code (Read, write, & manage)** for `new-repository` (see the token table).
- `pull-request`: creates `branch` from `baseBranch` (default `main`) if it does not exist, otherwise pushes on top of it (existing files are `edit`ed, others `add`ed), then opens a PR, or reuses the active PR for the same source and target. Optional `reviewers`: reviewer ids (array or comma separated string); `description` replaces the PR body.
- `new-repository`: creates `repo` in the project and pushes the files to `defaultBranch` (default `main`) in a first commit; `prUrl` is `null`. An existing repository is reused only if it is empty, or when `reuseExisting: true` (the push then lands on `defaultBranch`). The Azure DevOps API has no repository description; `description` is appended to the commit message.
- Output: `repoUrl` (repository web URL), `prUrl` (`<repoUrl>/pullrequest/<id>`), `commit` (id of the pushed commit) and `number` (pull request id).

GitLab `mode: new-repository` creates the project (`POST /projects`) and pushes the files as the initial commit; `prUrl` is `null`, `repoUrl` is the project `web_url`. `repo` is the project path (`group/sub/name`); alternatively `repo: name` plus `namespace: group/sub`. Optional: `description`, `visibility` (`private` default, `internal`, `public`), `defaultBranch` (default `baseBranch` or `main`). If the project already exists it is used only when empty or with `reuseExisting: true` (files are then committed on its default branch, existing paths updated); otherwise the run fails. In `pull-request` mode a re-run is idempotent: an existing branch receives the commit on top of it (existing files are updated) and an open MR for the same source/target branches is reused (same `prUrl`/`number`).

#### Scaffolder tokens and security

Token scopes (least privilege):

| Provider | Needed |
| --- | --- |
| GitHub fine-grained token | `Contents: write` (blobs, trees, commits, refs, contents, branch rename) + `Pull requests: write` on the target repository; `Contents: read` on the template. `new-repository` additionally needs `Administration: write` or the `Repository creation` permission to create the repository (`POST /orgs/{org}/repos`, `POST /user/repos`), `Administration: write` for `topics` and `team` (`PUT /orgs/{org}/teams/{team}/repos/…`). Templates containing `.github/workflows/*` need `Workflows: write`. [1] |
| GitHub classic token | `repo` (`workflow` if the template contains `.github/workflows/*`; `admin:org` only for `team`). |
| GitLab | `api`. `write_repository` is **not** enough: it only covers Git over HTTP and "does not support API authentication", while this invoker uses the REST API (commits, merge requests, projects). Project access tokens: role Developer for `pull-request`, Maintainer/group Owner to create projects. [2] |
| Azure DevOps PAT | `Code (Read & write)` (`vso.code_write`) for `pull-request` (pushes, branches, pull requests). `new-repository` needs `Code (Read, write, & manage)` (`vso.code_manage`), the scope documented for *Repositories - Create*, **and** the *Create repository* permission of the PAT owner on the project (a security permission, not a PAT scope). Code (Status) is not needed. [3] |

Sources (checked against the public documentation): [1] docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens; [2] docs.gitlab.com/security/tokens/access_token_scopes/; [3] learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth (scope table) and learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories/create (`vso.code_manage`), `.../git/pushes/create` (`vso.code_write`).

**Re-runs and no-op pushes.** All three providers skip files whose content already matches the branch: GitHub compares the contents API payload (and the tree sha for `new-repository`), GitLab compares `GET /projects/:id/repository/files/:path?ref=` with the rendered content, Azure DevOps compares the item `objectId` with the git blob id of the rendered content. When nothing differs no commit/push is made and `commit` is the current branch tip; an existing open PR/MR is reused. (The GitLab commits docs only mention `allow_empty` for empty commits and say nothing about no-op updates, so the invoker does not rely on the server's behaviour.)

Safeguards enforced by the invoker: `apiUrl` / `baseUrl` / `organization` must be `https` URLs without credentials and, like every outbound call, go through the SSRF guard (private, loopback and link-local addresses are refused unless allow-listed in `OUTBOUND_ALLOW`; plain `http` is only accepted for allow-listed hosts). Repository and ref names are restricted to plain segments (no `..`, `?`, `#`). Only `token` may be a `${secret:…}`/`${env:…}` reference: it is rejected in `variables`, `title`, `description`, `branch` and paths because the resolved value would be committed, and a final check refuses to publish any file containing the token or the run callback token. The token is masked in errors and logs. Rendered paths cannot be absolute, contain `..`, `\` or control characters, or enter `.git/` (any case). Writing `.github/workflows/` is allowed but logs a warning: a workflow runs with repository secrets once merged, so keep the PR review required and grant the `workflow` scope only when templates need it. Each successful publish writes a `scaffold.published` audit entry (provider, mode, repoUrl, prUrl, branch, file count; no token).

#### Manual verification against live providers

The scaffolder is tested against in-process fakes of the GitHub, GitLab and Azure DevOps APIs, not live accounts. Before relying on it, run once per provider with a throwaway repository and a token with exactly the scopes above:

- `pull-request`: first run opens a PR/MR; re-run with the same run inputs adds no commit and reuses the PR/MR; change a template file and re-run to see one commit with only that file.
- `new-repository`: creates the repository (GitHub org and user owners, GitLab nested group via `namespace`, Azure DevOps project); a second run fails with "already exists and is not empty" and succeeds with `reuseExisting: true` without a new commit.
- GitHub: default branch rename when the account default is not `main`; `topics` and `team` (needs `Administration`); a template with `.github/workflows/*` (needs `Workflows: write`, otherwise 403/404).
- GitLab: token with only `write_repository` is rejected (confirms `api` is required); self-managed `baseUrl`; a binary file survives base64 round-trip; protected default branch behaviour for `reuseExisting`.
- Azure DevOps: PAT with only `Code (Read & write)` fails to create a repository, `Code (Read, write, & manage)` without the *Create repository* permission also fails; Entra `Bearer` token; `reviewers` by id; edit of an identical file is skipped (blob id match) including a CRLF/binary file.
- Secrets: confirm the token never appears in run logs, the commit, or error messages on a failing run (e.g. revoked token).
- MCP: see "Manual verification" in docs/MCP.md.

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
| `GET /api/v1/insights?days=&team=&service=` | the DORA metrics of the organization, as the caller may read them |
| `GET /api/v1/policies` · `PUT\|DELETE /api/v1/policies/:id` | policy gate definitions (admin) |
| `GET /api/v1/dashboards/resolve?blueprint=` · `GET …/dashboards/:id/data` | the dashboard to show and its widget data |
| `GET /api/v1/actions` · `POST /api/v1/actions/:id/runs` `{ entity?, inputs }` | trigger actions from scripts |
| `GET /api/v1/runs?mine=true&status=…` · `GET /api/v1/runs/:id` | runs with logs and approvals |
| `POST /api/v1/runs/:id/approve\|reject\|cancel` | `{ comment }` |
| `POST /api/v1/ingest/:integration` | inbound webhook (integration secret, not a user token) |

Entity identifiers may contain `/`, `:` and `@` (third-party ids); URL-encode them in paths.

## Catalog governance

All of these are declared in the configuration files like the other resources (`scorecards:`, `policies:`, `dashboards:`), or in the admin UI.

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

**Policies** (`policies:`, admin UI *Policies*). A policy is a JSONata guard evaluated before a run is queued (`target: run`, filter with `match.actions`) or before an entity is created, updated or deleted through the API or the catalog invoker (`target: entity`, filter with `match.blueprints` and `match.operations`). The context is `{ inputs, entity, previous, principal, action, blueprint, operation }` (`entity` is what would be stored, `previous` the stored entity; `principal` has `id`, `email`, `name`, `role`, `roles`, `teams`). The expression must evaluate to exactly `true` to allow; any other result, and any evaluation error, denies (fail closed) with `403` `{ error, policy, message }` and a `policy.denied` audit entry. `message` may embed `{{ expression }}` over the same context. Disabled policies are ignored. Integration syncs, configuration seeding and cascading deletes of referrers are not gated. Policies are per organization; those declared in configuration files are managed (read-only through the API).

```yaml
policies:
  - identifier: service-needs-owner
    title: Services need an owner team
    target: entity
    match: { blueprints: [service], operations: [create, update] }
    expression: entity.team != null
    message: "{{ entity.identifier }} must have an owner team"
```

**Computed properties** (`computed:` in a blueprint). `calculated` is a JSONata expression evaluated on read; `mirror` copies a property (or `title`, `team`) of the related entity; `aggregation` is `count`, `sum`, `min` or `max` over the entities pointing to this one through `blueprint.relation`, with an optional JSONata `filter`. Mirrors and aggregations are materialised when either side is written, so they work in `filter.<name>=` queries. Values appear under `entity.computed`.

**Relations** accept `onDelete` (`ignore` default, `restrict`, `cascade`, `detach`), `inverseTitle` (name of the reverse relation on the target page) and `requireExisting` (entities written from the UI or API must point to existing entities). Changing a relation target re-indexes automatically; `POST /blueprints/:bp/repair-relations` rebuilds the index from the entities.

**Supply chain.** Vulnerability and SBOM blueprints, Snyk and CycloneDX mappings and a security scorecard are described in [SUPPLY-CHAIN.md](SUPPLY-CHAIN.md).

**Dashboards.** Widgets: `count` (optionally `groupBy` a property, `team` or `source`), `scorecard`, `runs`, `approvals`, `table` (a saved view), `insights` (DORA metrics, below), `markdown`. A dashboard with `default: true` is the home page; with `team:` it is the home page of that team; with `blueprint:` it appears on that blueprint's catalog page.

**Delivery insights (DORA).** The `insights` widget shows the four DORA metrics over `days` (default 30) as stat tiles with their band (elite / high / medium / low); the same numbers are served by `GET /api/v1/insights`, scoped to the organization and to the blueprints the caller may read. Optional `team` / `service` filters. Sources, all configurable:
- *Deployment frequency* and *change failure rate*: entities of `deployments.blueprint` (default `deployment`, e.g. the Argo CD preset, whose example mapping sets `deployedAt` and `status` from the last sync operation) with `timeProperty` (default `deployedAt`) in the window and a `statusProperty` (default `status`) matching `successValues` (`success`, `succeeded`, `healthy`, `synced`) or `failureValues` (`failure`, `failed`, `error`, `degraded`); other states are ignored. `deploymentActions` adds the runs of those actions (SUCCESS = deployment, FAILURE = failed deployment).
- *Lead time for changes*: median of `deployedAt - mergedAt` (`deployments.mergedProperty`, default `mergedAt`) over successful deployments carrying it.
- *Time to restore*: median of `resolvedAt - createdAt` of `incidents.blueprint` (default `incident`; the PagerDuty preset has an `incident` kind, see its example mapping) for incidents created in the window.
A metric with no data is `null` (shown as a dash), never NaN. Bands: frequency daily / weekly / monthly; lead time and restore time under a day (restore: an hour) / a week / a month (restore: a day / a week); failure rate up to 5 / 10 / 15 %.

## Ephemeral entities (expiry)

A blueprint can name a date or date-time property as its `ttlProperty` (also in the blueprint editor, "Expiry property"). Once that value is in the past, the maintenance pass (every 5 minutes, on every replica) emits `entity.expired` with `data: { entity, property, expiresAt }`, in the entity's organization. It is announced **once per expiry value**: the announced value is stored in `entity_expiry` and claimed with a conditional upsert, so replicas never double-emit; changing the date re-arms it. A date without a time expires at the end of that day (UTC). The entity is *not* deleted: subscribe a webhook or a workflow event trigger (`event: entity.expired`, see `decommission-expired-environment` in `examples/demo-config`) to act on it.

```yaml
blueprints:
  - identifier: environment
    ttlProperty: expiresAt        # a property with format date / date-time
    schema: { properties: { expiresAt: { type: string, format: date } } }
```

## Outbound webhooks

The payload has the form `{ id, type, at, blueprint, actor, data }`. Event types are `entity.created`, `entity.updated` (with `data.before`), `entity.deleted`, `entity.expired` (`data: { entity, property, expiresAt }`), `run.created`, `run.updated`, `run.sla_breached` (`data: { runId, action, status, createdAt, breachedAt }`), `step.started`, `step.finished`, `step.sla_breached` (`data: { runId, action, stepId, name, status, slaMinutes, startedAt, breachedAt }`) and `scorecard.changed` (`data: { scorecard, entity, from, to, passed, total }`). Requests carry the headers `X-Asterius-Event`, `X-Asterius-Delivery` and `X-Asterius-Signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<body>")`. Receivers must recompute it over the raw body, compare in constant time, and reject timestamps more than **5 minutes** from their clock (replay protection); the timestamp is refreshed on every retry. `secret` and `secondarySecret` must be references (`${secret:NAME}` / `${env:NAME}`); literal values are rejected.

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
