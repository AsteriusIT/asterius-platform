# Platform configuration (configuration as code)

Every `*.yaml` / `*.yml` / `*.json` file here is loaded at startup and re-read every minute (`CONFIG_DIR`).
In Kubernetes, mount this directory from a ConfigMap (Helm `config.files`) or a git-sync sidecar.

Top-level keys, any file may declare any of them:

| Key | What |
|---|---|
| `teams` | Teams (optionally bound to an Entra ID group) |
| `blueprints` | Entity types: JSON Schema properties + relations |
| `connectors` | Connector definitions of your own (how to talk to a tool: fields, auth, kinds, operations); built-ins need none |
| `connections` | Configured instances of a connector: URL and fields, credential references, access, allowed workflows |
| `actions` | Self-service actions: inputs, invoker, approval policy, permissions |
| `integrations` | Data ingestion: source type, config, JSONata mappings, schedule |
| `webhooks` | Outbound notifications of catalog changes and runs |
| `entities` | Seed entities (created when missing, never overwritten) |

Resources declared here are **managed**: read-only in the UI, deleted when removed from the files.
Admins can export what was created in the UI (`Admin → Configuration → Export`) and commit it here.

Within one file, YAML anchors and merge keys share settings (`x-shared: &name {…}` then `<<: *name`);
top-level keys other than the ones above are ignored, so they can hold such shared blocks.

The files shipped here set up Azure DevOps self-service through the `azure-devops` connection (see
`examples/azure-devops/README.md`);
the earlier demo configuration is in `examples/demo-config/`.

Secrets are never written in these files: use `${secret:NAME}` (stored encrypted, Admin → Secrets)
or `${env:NAME}` (an environment variable of the pods, e.g. from a Kubernetes Secret).
