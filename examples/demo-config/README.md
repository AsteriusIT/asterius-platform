# Demo configuration (backup)

The earlier example configuration: a small catalog (systems, services, environments, databases, workloads),
self-service workflows (catalog writes, GitHub / Azure DevOps / Kubernetes jobs, the AI-reviewed database request),
example integrations and an outbound webhook.

Run the platform with it instead of `config/`:

```bash
CONFIG_DIR=$PWD/examples/demo-config DATA_DIR=$PWD/data-demo npm run dev -w apps/server
```

Or copy individual files into `config/`. Identifiers must stay unique across all files.
