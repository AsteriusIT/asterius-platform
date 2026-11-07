# Supply chain data model

A convention for tracking vulnerabilities and software bills of materials (SBOM) per service. Everything is
configuration: the blueprints, the ingestion mappings and the scorecard live in
[`examples/demo-config/supply-chain.yaml`](../examples/demo-config/supply-chain.yaml); copy it into your `CONFIG_DIR`
(see [EXTENDING.md](EXTENDING.md) for the concepts used here).

## Blueprints

| Blueprint | Properties | Relations |
| --- | --- | --- |
| `vulnerability` | `severity` (critical/high/medium/low), `status` (open/fixed/ignored), `cve`, `package`, `version`, `fixedIn`, `url`, `firstSeen` | `service` |
| `sbom-component` | `purl`, `name`, `version`, `type`, `license`, `supplier` | `service`, `vulnerabilities` (many, optional) |

Both point to the owning `service`, so a service page lists its vulnerabilities and components as incoming
relations, and scorecards read them through `incoming."vulnerability.service"` and `incoming."sbom-component.service"`.
The `sbom-component.vulnerabilities` relation is optional. The CycloneDX mapping fills it from the document's `vulnerabilities[]`
section (see below); you can also fill it from another mapping or a workflow.

## Ingestion

**Snyk issues (pull).** The `snyk` preset has an `issue` kind (`GET /rest/orgs/{orgId}/issues`, JSON:API). The `snyk-issues`
integration maps each `package_vulnerability` to a `vulnerability`:

| Property | Snyk field |
| --- | --- |
| identifier | `<project id>:<issue key>` |
| `severity` | `attributes.effective_severity_level` |
| `status` | `ignored` is `ignored`, `resolved` is `fixed`, else `open` |
| `cve`, `url` | `attributes.problems[0]` |
| `package`, `version` | `attributes.coordinates[0].representations[0].dependency` |
| `fixedIn` | `attributes.coordinates[0].remedies[0].details.upgrade_package` |
| `firstSeen` | `attributes.created_at` |

Issues only carry the Snyk project id, so the service is resolved with a lookup table in the integration config:
`config.serviceByProject: { "<snyk project id>": "<service identifier>" }`. Issues of an unmapped project are still
created, without a service. With `deleteMissing: true`, issues that disappear from Snyk are removed from the catalog.

**CycloneDX SBOM (push).** The `sbom` webhook integration accepts a CycloneDX JSON document, one `sbom-component` per
entry of `components[]`. The service is `metadata.component.name` (set it when generating the SBOM, for example
`cyclonedx-npm --output-file bom.json`, then name the root component after the service). The component identifier is
`<service>/<purl>` (`pkg:generic/<name>@<version>` when there is no purl); the license is the first `license.id`,
`license.name` or license `expression`. Post it from CI after every build:

```bash
curl -X POST "$PLATFORM_URL/api/v1/ingest/<org>/sbom" \
  -H "X-Asterius-Token: $INGEST_TOKEN" -H 'content-type: application/json' -d @bom.json
```

**CycloneDX vulnerabilities.** When the document has a `vulnerabilities[]` section (for example from `grype`, `trivy` or
`cdxgen`), the `sbom` integration also upserts one `vulnerability` per entry and links the components it affects:

| Property / relation | CycloneDX field |
| --- | --- |
| identifier | `<service>:<id>` (Snyk uses `<snyk project id>:<issue key>`, so the two sources never write the same entity) |
| `severity` | `ratings[0].severity` lower-cased (`critical`, `high`, `medium`, `low`; anything else, such as `info`, becomes `low`) |
| `status` | `analysis.state`: `resolved*` is `fixed`, `false_positive` / `not_affected` is `ignored`, else `open` |
| `cve` | `id` when it starts with `CVE-` |
| `package`, `version` | the component whose `bom-ref` is `affects[0].ref` |
| `url` | `advisories[0].url`, else `source.url` |
| `service` | `metadata.component.name` |
| `sbom-component.vulnerabilities` | the vulnerabilities whose `affects[].ref` contains the component's `bom-ref` |

`firstSeen` is not set (CycloneDX has no such field), so the Gold rule does not count these vulnerabilities as stale. If the same
issue is also reported by Snyk it appears twice (two identifiers); scope Snyk and the SBOM to different services or ignore one source
in the scorecard rule if that matters.

**Pruning.** Each delivery is the complete component set of one service, so both mappings carry
`prune: { relation: service, value: metadata.component.name }` (see "Pruning webhook deliveries" in
[EXTENDING.md](EXTENDING.md)): components and vulnerabilities of that service created by the `sbom` integration that are absent
from the latest document are deleted. Entities of other services, of other integrations (Snyk) and entities created by hand are
never touched. A document without `vulnerabilities[]` therefore removes the service's previously ingested SBOM vulnerabilities.

## Scorecard

`supply-chain-security` is evaluated on services:

| Level | Rule |
| --- | --- |
| Bronze | an SBOM is published (at least one `sbom-component`) |
| Silver | no open critical vulnerability |
| Gold | no open high vulnerability first seen more than 30 days ago |

Rules are JSONata, so the thresholds are easy to adapt, for example
`$count(incoming."vulnerability.service"[properties.status = "open" and properties.severity in ["critical", "high"]]) = 0`.
`scorecard.changed` events can trigger a workflow or an outbound webhook when a service drops a level.

## Adding another scanner

Map its findings to `vulnerability` (same severity and status vocabulary) with a source mapping, and keep the `service`
relation: the scorecard needs nothing else.
