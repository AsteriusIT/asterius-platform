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
The `sbom-component.vulnerabilities` relation is optional: fill it from a mapping (for example a CycloneDX `vulnerabilities[]`
section) or a workflow when you want to link a component to the vulnerabilities that affect it.

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

A webhook cannot tell which components disappeared, so removed dependencies stay until deleted (or until a workflow
prunes components not seen recently).

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
