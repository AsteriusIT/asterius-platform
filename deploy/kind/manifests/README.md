Extension point: install.sh runs `kubectl apply -f` on every `*.yaml` / `*.yml` / `*.json` file of this folder (alphabetical order, **not recursive**) after the core install, in both profiles (render.yaml, opa.yaml, jobs-rbac.yaml…); the image `asterius-render:dev` is built from `apps/render-service` and loaded into the node beforehand.

`crossplane/` is applied only with `install.sh --profile crossplane` (agent.yaml, dashboard.yaml, render-crossplane.yaml — which replaces the lean plan service Deployment `render` with the Crossplane render and its function sidecars, same Service), after building `asterius-agent:dev` from `apps/agent`. Its namespaces (crossplane-system, gatekeeper-system, portal-agent) and the Secret `portal-agent/watcher` exist by then.

Images are loaded with `kind load docker-image`: use `imagePullPolicy: Never` or `IfNotPresent`.
