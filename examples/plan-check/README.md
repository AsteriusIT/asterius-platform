# Plan checks before deploy (lean / OpenTofu path)

Cost, carbon and policy checks on the OpenTofu plan of a self-service request, **before the approval and before
anything exists**. Reference: [docs/EXTENDING.md, "Plan checks"](../../docs/EXTENDING.md#plan-checks-cost-carbon-policies).

```
form → tofu plan (portal-services-plan, publishes plan.json) → plan-check → approval (prod / override)
     → tofu apply (portal-services-apply) → catalog: estimatedMonthlyCost, estimatedCo2eKgMonth on the entity
```

| File | What |
|---|---|
| [config/plan-check.yaml](config/plan-check.yaml) | a price catalog extending the built-in sample, four plan policies (critical, warning, advisory), the `create-app-environment` workflow with its workflow tests, the `app-environment` blueprint |
| [azure-pipelines/portal-services-plan.yml](azure-pipelines/portal-services-plan.yml) | the plan stage: `tofu plan`, `tofu show -json` → build artifact `plan` / `plan.json` |

## With the V2 lean setup

The V2 branch (`docs/V2-WRITE-SIDE.md`, `examples/v2/config/actions.yaml`) commits a Service spec, then queues
`portal-services-apply`, whose `outputs.json` artifact the azure-pipeline invoker reads (`outputs: { artifact, file }`).
To add the plan stage there:

1. Add `portal-services-plan` next to `portal-services-apply` in the Portal repo (same OpenTofu version, backend and
   variable group: what is checked must be what is applied). It plans the committed spec of `service` (run it after
   the `commit` step, or have it plan the spec from its `spec` parameter before the commit).
2. In `create-platform-service`, between `commit` and the `approval`, add the `tfplan` step (azure-pipeline,
   `pipeline: portal-services-plan`) and the `plan` step of [config/plan-check.yaml](config/plan-check.yaml). With the
   V2 invoker, `outputs: { artifact: plan, file: plan.json }` on `tfplan` also works: then
   `plan: '{{ steps.tfplan.output.outputs }}'` replaces the `ado` block (plans up to STEP_OUTPUT_MAX_BYTES, 256 KB by
   default; the `ado` block has no such limit).
3. Change the approval condition to `'"prod" in inputs.environments or steps.plan.output.requiresOverride'` and put
   `{{ steps.plan.output.summary }}` in its message.
4. Add `estimatedMonthlyCost`, `costCurrency` and `estimatedCo2eKgMonth` to the `platform-service` blueprint and to
   the `x-ready` properties: `'{{ steps.plan.output.cost.monthly }}'`…

The V2 pre-check (`service-precheck`: schema, OPA on the spec, render-service plan preview) stays: it validates the
request before it is committed; the plan check prices and gates the concrete plan.

## Manual verification (needs a live Azure DevOps organization and a subscription)

The platform side is covered by tests with fixture plans, a fake Azure DevOps artifact API and a real `opa run
--server` (apps/server/test/plan-check*.test.ts). Not verified live:

- `portal-services-plan` runs and publishes `plan/plan.json`; the pipeline id is set in `config/plan-check.yaml`.
- The `ado` source reads it: `GET _apis/build/builds/<id>/artifacts?artifactName=plan` then the download URL with
  `$format=file&subPath=/plan.json`. With a PAT of scope **Build: Read** (the `ADO_PAT` already has Build: read &
  execute). Check a plan of several MB.
- The estimate of a real plan: resources reported "without a price" are the ones to add to your catalog.
- OPA: `OPA_URL` reachable from the portal pod and allowed by `OUTBOUND_ALLOW` when it is a cluster-internal address.
