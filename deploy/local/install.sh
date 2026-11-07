#!/usr/bin/env bash
# Asterius Platform on the local OrbStack Kubernetes cluster, with its ecosystem:
#   metrics-server, kube-prometheus-stack (Prometheus + Grafana), OpenBao, External Secrets Operator,
#   and the platform chart with every component enabled (CNPG, Keycloak, ingress/TLS, HPA, PDB, NetworkPolicy,
#   RBAC, migration Job, ServiceMonitor, PrometheusRule, Grafana dashboard).
# Secrets flow: .env + generated values → OpenBao KV → External Secrets → Kubernetes Secrets → pods.
# Idempotent: re-run after changing .env, the chart or the image. Usage: deploy/local/install.sh [--build]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
CONTEXT="${KUBE_CONTEXT:-orbstack}"
NS=asterius-platform
BAO_POD=openbao-0
k() { kubectl --context "$CONTEXT" "$@"; }
h() { helm --kube-context "$CONTEXT" "$@"; }
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[[ "$(kubectl config get-contexts -o name)" == *"$CONTEXT"* ]] || { echo "kube context $CONTEXT not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if [[ "${1:-}" == "--build" ]] || ! docker image inspect asterius-platform:local >/dev/null 2>&1; then
  log "Building image asterius-platform:local"
  docker build -t asterius-platform:local "$ROOT"
fi

log "Namespaces"
for ns in observability openbao external-secrets "$NS" asterius-jobs; do
  k create namespace "$ns" --dry-run=client -o yaml | k apply -f - >/dev/null
done

log "Helm repositories"
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add openbao https://openbao.github.io/openbao-helm >/dev/null 2>&1 || true
helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1 || true
helm repo update >/dev/null

log "metrics-server (HPA)"
h upgrade --install metrics-server metrics-server/metrics-server -n kube-system -f "$HERE/values/metrics-server.yaml" --wait

log "kube-prometheus-stack (Prometheus Operator, Prometheus, Alertmanager, Grafana)"
# No --wait: Grafana starts once External Secrets has written its admin Secret (later in this script).
h upgrade --install kps prometheus-community/kube-prometheus-stack -n observability -f "$HERE/values/kube-prometheus-stack.yaml"
k -n observability rollout status deploy/kps-operator --timeout=300s

log "OpenBao"
if ! k -n openbao get secret openbao-unseal-key >/dev/null 2>&1; then
  key="$(mktemp)"; openssl rand -out "$key" 32
  k -n openbao create secret generic openbao-unseal-key --from-file=key="$key" >/dev/null
  rm -f "$key"
fi
h upgrade --install openbao openbao/openbao -n openbao -f "$HERE/values/openbao.yaml"
k -n openbao wait pod/$BAO_POD --for=jsonpath='{.status.phase}'=Running --timeout=300s
# `bao status` exits 2 while sealed: read its JSON regardless of the exit code.
bao_status() { k -n openbao exec $BAO_POD -- bao status -format=json 2>/dev/null || true; }
until bao_status | jq -e '.type' >/dev/null; do sleep 2; done

if [[ "$(bao_status | jq -r .initialized)" != "true" ]]; then
  log "Initializing OpenBao (recovery key and root token kept in Secret openbao/openbao-init)"
  init="$(k -n openbao exec $BAO_POD -- bao operator init -recovery-shares=1 -recovery-threshold=1 -format=json)"
  k -n openbao create secret generic openbao-init \
    --from-literal=root-token="$(jq -r .root_token <<<"$init")" \
    --from-literal=recovery-key="$(jq -r '.recovery_keys_b64[0]' <<<"$init")" >/dev/null
fi
until [[ "$(bao_status | jq -r .sealed)" == "false" ]]; do sleep 2; done
ROOT_TOKEN="$(k -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d)"

# Runs bao in the pod; the token goes through stdin (never on a command line), the rest of stdin is passed on.
bao() { { echo "$ROOT_TOKEN"; cat; } | k -n openbao exec -i $BAO_POD -- sh -c 'read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' bao "$@"; }
baoq() { bao "$@" </dev/null; }

log "Configuring OpenBao (KV v2, Kubernetes auth, policies, roles)"
baoq secrets list -format=json | jq -e '."secret/"' >/dev/null || baoq secrets enable -path=secret kv-v2
baoq auth list -format=json | jq -e '."kubernetes/"' >/dev/null || baoq auth enable kubernetes
baoq write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc >/dev/null

printf 'path "secret/data/asterius-platform/*" { capabilities = ["read"] }\n' | bao policy write eso-asterius-platform - >/dev/null
printf 'path "secret/data/observability/*" { capabilities = ["read"] }\n' | bao policy write eso-observability - >/dev/null
# The platform itself resolves ${vault:secret/apps/...#key} references of actions and integrations.
printf 'path "secret/data/apps/*" { capabilities = ["read"] }\n' | bao policy write asterius-platform - >/dev/null

baoq write auth/kubernetes/role/eso-asterius-platform bound_service_account_names=openbao-reader \
  bound_service_account_namespaces="$NS" token_policies=eso-asterius-platform token_ttl=15m >/dev/null
baoq write auth/kubernetes/role/eso-observability bound_service_account_names=openbao-reader \
  bound_service_account_namespaces=observability token_policies=eso-observability token_ttl=15m >/dev/null
baoq write auth/kubernetes/role/asterius-platform bound_service_account_names=asterius-platform-api,asterius-platform-worker \
  bound_service_account_namespaces="$NS" token_policies=asterius-platform token_ttl=1h >/dev/null

kv_get() { local r; r="$(baoq kv get -format=json -mount=secret "$1" 2>/dev/null | jq -c '.data.data' 2>/dev/null || true)"; [[ -n "$r" && "$r" != null ]] && echo "$r" || echo '{}'; }
kv_put() { bao kv put -mount=secret "$1" - >/dev/null; }
rand() { openssl rand -hex "${1:-24}"; }

log "Seeding secrets from $ENV_FILE"
# .env → JSON, skipping comments; surrounding quotes removed.
env_json='{}'
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]] && val="${BASH_REMATCH[1]}"
    env_json="$(jq -c --arg k "$name" --arg v "$val" '.[$k]=$v' <<<"$env_json")"
  done <"$ENV_FILE"
fi

# Keys owned by the chart's ConfigMap (PUBLIC_URL, AUTH_PROVIDERS, KEYCLOAK_URL…) or meaningless in the cluster
# stay out of the Secret: envFrom gives the Secret precedence and local values (localhost URLs) would win.
chart_keys="$(h template asterius-platform "$ROOT/deploy/helm/asterius-platform" -n "$NS" -f "$HERE/values/asterius-platform.yaml" \
  -s templates/config.yaml | awk '/^kind: ConfigMap/{c=1} c&&/^data:/{d=1;next} d&&/^  [A-Z_]+:/{sub(/^  /,"");sub(/:.*/,"");print} /^---/{c=0;d=0}' | jq -R . | jq -sc .)"
# ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ADMIN_EMAILS become chart values (below).
skip='["DATABASE_URL","SECRETS_KEY","DATA_DIR","PLATFORM_ROLE","KUBECONFIG_PATH","ENTRA_REDIRECT_URI","ENTRA_TENANT_ID","ENTRA_CLIENT_ID","ADMIN_EMAILS","KEYCLOAK_CLIENT_SECRET","KEYCLOAK_INTERNAL_URL"]'
excluded="$(jq -nc --argjson a "$chart_keys" --argjson b "$skip" '$a + $b - ["SECRETS_KEY"]')"
env_secrets="$(jq -c --argjson x "$excluded" --argjson b "$skip" 'with_entries(select(.key as $k | ($x+$b) | index($k) | not))' <<<"$env_json")"

# Generated once and kept: changing SECRETS_KEY makes the stored secrets unreadable.
current="$(kv_get asterius-platform/env)"
generated="$(jq -nc --arg s "$(openssl rand -base64 32)" --arg m "$(rand 20)" --arg b "$(rand 16)" \
  '{SECRETS_KEY:$s, METRICS_TOKEN:$m, BOOTSTRAP_TOKEN:$b}')"
jq -c --argjson cur "$current" --argjson env "$env_secrets" \
  --argjson x "$excluded" \
  '. as $gen | ($gen + $cur + $env + {SECRETS_KEY: ($cur.SECRETS_KEY // $gen.SECRETS_KEY), METRICS_TOKEN: ($cur.METRICS_TOKEN // $gen.METRICS_TOKEN), BOOTSTRAP_TOKEN: ($cur.BOOTSTRAP_TOKEN // $gen.BOOTSTRAP_TOKEN)})
   | with_entries(select(.key as $k | $x | index($k) | not))' \
  <<<"$generated" | kv_put asterius-platform/env

# Keycloak: the platform client reuses KEYCLOAK_CLIENT_SECRET of .env the first time.
current="$(kv_get asterius-platform/keycloak)"
jq -nc --argjson cur "$current" --arg db "$(rand)" --arg adm "$(rand)" --arg cs "$(jq -r '.KEYCLOAK_CLIENT_SECRET // empty' <<<"$env_json")" --arg rcs "$(rand)" \
  '{KC_DB_USERNAME:"keycloak", KC_DB_PASSWORD:$db, KC_BOOTSTRAP_ADMIN_USERNAME:"admin", KC_BOOTSTRAP_ADMIN_PASSWORD:$adm,
    ASTERIUS_CLIENT_SECRET:(if $cs != "" then $cs else $rcs end)} + $cur' | kv_put asterius-platform/keycloak

current="$(kv_get observability/grafana)"
jq -nc --argjson cur "$current" --arg p "$(rand)" '{"admin-user":"admin","admin-password":$p} + $cur' | kv_put observability/grafana

# Sample secret for ${vault:secret/apps/demo#token} in actions.
[[ "$(kv_get apps/demo)" != '{}' ]] || jq -nc --arg t "$(rand)" '{token:$t}' | kv_put apps/demo

log "External Secrets Operator"
h upgrade --install external-secrets external-secrets/external-secrets -n external-secrets -f "$HERE/values/external-secrets.yaml" --wait
k apply -f "$HERE/manifests/observability-secrets.yaml" -f "$HERE/manifests/platform-secrets.yaml"
for es in asterius-platform-secrets asterius-platform-keycloak keycloak-db-credentials; do
  k -n "$NS" wait externalsecret/$es --for=condition=Ready --timeout=120s
done
k -n observability wait externalsecret/grafana-admin --for=condition=Ready --timeout=120s
k -n "$NS" wait cluster.postgresql.cnpg.io/keycloak-db --for=condition=Ready --timeout=300s

log "Asterius Platform"
# Non-secret values of .env that map to chart values.
sets=()
tenant="$(jq -r '.ENTRA_TENANT_ID // empty' <<<"$env_json")"; [[ -n "$tenant" ]] && sets+=(--set "auth.entra.tenantId=$tenant")
client="$(jq -r '.ENTRA_CLIENT_ID // empty' <<<"$env_json")"; [[ -n "$client" ]] && sets+=(--set "auth.entra.clientId=$client")
admins="$(jq -r '.ADMIN_EMAILS // empty' <<<"$env_json")"; [[ -n "$admins" ]] && sets+=(--set "auth.adminEmails={$admins}")
h upgrade --install asterius-platform "$ROOT/deploy/helm/asterius-platform" -n "$NS" \
  -f "$HERE/values/asterius-platform.yaml" ${sets[@]+"${sets[@]}"} --timeout 15m
# No --wait above: the post-install migration Job must run while the pods wait for the schema.
# A rebuilt image keeps the same tag: restart so the pods pick it up.
if [[ "${1:-}" == "--build" ]]; then k -n "$NS" rollout restart deploy/asterius-platform-api deploy/asterius-platform-worker; fi
for d in asterius-platform-api asterius-platform-worker asterius-platform-keycloak; do k -n "$NS" rollout status deploy/$d --timeout=600s; done
k -n observability rollout status deploy/kps-grafana --timeout=300s

log "Done"
cat <<EOF
Platform   https://platform.k8s.orb.local   (first admin: sign up with a local account and the BOOTSTRAP_TOKEN below)
Keycloak   https://platform-id.k8s.orb.local
Grafana    https://platform-grafana.k8s.orb.local   (dashboard "Asterius Platform")
OpenBao    https://openbao.k8s.orb.local   (UI, token: root token below)

BOOTSTRAP_TOKEN  kubectl -n $NS get secret asterius-platform-secrets -o jsonpath='{.data.BOOTSTRAP_TOKEN}' | base64 -d
Grafana admin    kubectl -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
OpenBao root     kubectl -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d
EOF
