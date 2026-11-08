#!/usr/bin/env bash
# Asterius Platform V2 — local management cluster on kind (docs/V2.md).
#
#   lean (default, docs/V2-KIND.md): kind cluster asterius-v2 (host ports 18080/18443) with ingress-nginx, Argo CD,
#     OpenBao + External Secrets, Loki + Tempo + kube-prometheus-stack, OTel Collector, PostgreSQL, the portal (chart
#     deploy/helm/asterius-platform, image from the root Dockerfile), namespace asterius-jobs (Job invoker), and the
#     extension hook (plan service image apps/render-service, deploy/kind/manifests/*.yaml).
#   crossplane (docs/V2-CROSSPLANE.md): lean + Crossplane v2 core, Gatekeeper, the catalog watcher (apps/agent,
#     deploy/kind/manifests/crossplane/*.yaml), Crossplane health checks in Argo CD, portal config v2cp-*.
#
# Idempotent: re-run at will. Usage: deploy/kind/install.sh [--profile lean|crossplane] [--build] [--skip-verify]
#   --profile      lean | crossplane; remembered in the cluster (ConfigMap kube-system/asterius-install), so a re-run
#                  without the flag keeps it (default for a new cluster: lean)
#   --build        rebuild the images (portal, render[, agent]) from the working tree and restart their pods
#   --skip-verify  skip the end-to-end checks
# Azure DevOps PAT: ADO_PAT=<pat> or ADO_PAT_FILE=<file> seeds OpenBao secret/platform/ado with an existing PAT
#   (optional ADO_PAT_VALID_TO=<RFC3339>); otherwise the stored one is reused, else one is created with `az`.
# Never touches another kind cluster: every command names the cluster / context explicitly.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLUSTER=asterius-v2
CONTEXT="kind-$CLUSTER"
NS=asterius-platform
HTTP_PORT=18080
BAO_POD=openbao-0
ADO_ORG=AsteriusIT
ADO_ORG_URL="https://dev.azure.com/$ADO_ORG"
REPO_URL="$ADO_ORG_URL/Platform/_git/portal-resources"

# ---- pinned versions (latest stable at the time of writing) ----
INGRESS_NGINX_VERSION=1.15.1                                            # kind manifest of controller-v<version>
ARGOCD_CHART=10.15.0            # Argo CD v3.6.1        oci://ghcr.io/argoproj/argo-helm/argo-cd
CROSSPLANE_CHART=2.4.3          # Crossplane v2.4.3     https://charts.crossplane.io/stable
GATEKEEPER_CHART=3.23.1         # Gatekeeper v3.23.1    https://open-policy-agent.github.io/gatekeeper/charts
OPENBAO_CHART=0.30.7            # OpenBao v2.7.2        oci://ghcr.io/openbao/charts/openbao
ESO_CHART=2.14.0                # ESO v2.14.0           oci://ghcr.io/external-secrets/charts/external-secrets
KPS_CHART=93.1.0                # Prometheus Operator v0.95.1, Prometheus, Grafana
LOKI_CHART=21.0.0               # Loki 3.7.9            oci://ghcr.io/grafana-community/helm-charts/loki
TEMPO_CHART=3.2.1               # Tempo 3.1.1           oci://ghcr.io/grafana-community/helm-charts/tempo
OTEL_CHART=0.178.2              # Collector contrib 0.163.2

BUILD=false; VERIFY=true; PROFILE_ARG=""
while (($#)); do
  case "$1" in
    --build) BUILD=true ;;
    --skip-verify) VERIFY=false ;;
    --profile) PROFILE_ARG="${2:-}"; shift ;;
    --profile=*) PROFILE_ARG="${1#--profile=}" ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -z "$PROFILE_ARG" || "$PROFILE_ARG" =~ ^(lean|crossplane)$ ]] || { echo "--profile: lean or crossplane" >&2; exit 2; }

k() { kubectl --context "$CONTEXT" "$@"; }
h() { helm --kube-context "$CONTEXT" "$@"; }
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARN: %s\033[0m\n' "$*" >&2; }
rand() { openssl rand -hex "${1:-24}"; }
# HTTP through the ingress without relying on DNS for *.localtest.me.
ing() { local host="$1" path="$2"; shift 2; curl -sS --resolve "$host:$HTTP_PORT:127.0.0.1" "http://$host:$HTTP_PORT$path" "$@"; }
retry() { local n="$1" d="$2"; shift 2; local i; for ((i = 1; i <= n; i++)); do "$@" && return 0; sleep "$d"; done; return 1; }

for c in kind kubectl helm docker jq curl openssl; do
  command -v "$c" >/dev/null || { echo "$c is required" >&2; exit 1; }
done

# ---------------------------------------------------------------------------------------------------------------------
log "kind cluster $CLUSTER"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  # kind makes the new context current; restore the previous one afterwards (the user's other clusters stay current).
  prev_ctx="$(kubectl config current-context 2>/dev/null || true)"
  kind create cluster --name "$CLUSTER" --config "$HERE/kind-config.yaml" --wait 180s
  [[ -n "$prev_ctx" && "$prev_ctx" != "$CONTEXT" ]] && kubectl config use-context "$prev_ctx" >/dev/null
fi
k get nodes -o wide

# Profile: flag > remembered in the cluster > lean.
STORED_PROFILE="$(k -n kube-system get configmap asterius-install -o jsonpath='{.data.profile}' 2>/dev/null || true)"
PROFILE="${PROFILE_ARG:-${STORED_PROFILE:-lean}}"
CP=false; [[ "$PROFILE" == crossplane ]] && CP=true
log "Profile $PROFILE${STORED_PROFILE:+ (stored: $STORED_PROFILE)}"
if [[ "$STORED_PROFILE" == crossplane && "$PROFILE" == lean ]]; then
  warn "switching from crossplane to lean: Crossplane, Gatekeeper and the watcher are left installed (their charts and
  manifests are no longer updated). Pause every Crossplane-managed service first (portal.asterius.io/paused) so both
  paths do not reconcile the same ADO resources; recreate the cluster for a clean lean install."
elif [[ "$STORED_PROFILE" == lean && "$PROFILE" == crossplane ]]; then
  warn "switching from lean to crossplane: pause every OpenTofu-managed service first (portal.asterius.io/paused) so
  both paths do not reconcile the same ADO resources."
fi
k -n kube-system create configmap asterius-install --from-literal=profile="$PROFILE" \
  --from-literal=updated="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --dry-run=client -o yaml | k apply -f - >/dev/null

log "Namespaces"
k apply -f "$HERE/bootstrap/namespaces.yaml" >/dev/null
$CP && k apply -f "$HERE/bootstrap/crossplane/namespaces.yaml" >/dev/null
k apply -f "$HERE/bootstrap/jobs.yaml" >/dev/null

# ---------------------------------------------------------------------------------------------------------------------
log "ingress-nginx $INGRESS_NGINX_VERSION (kind provider manifest)"
k apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v$INGRESS_NGINX_VERSION/deploy/static/provider/kind/deploy.yaml" >/dev/null
k -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s
k -n ingress-nginx wait --for=condition=complete job --all --timeout=300s >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------------------------------------------------
log "External Secrets Operator + OpenBao"
h upgrade --install external-secrets oci://ghcr.io/external-secrets/charts/external-secrets --version "$ESO_CHART" \
  -n external-secrets -f "$HERE/values/external-secrets.yaml" --wait --timeout 10m >/dev/null

if ! k -n openbao get secret openbao-unseal-key >/dev/null 2>&1; then
  key="$(mktemp)"; openssl rand -out "$key" 32
  k -n openbao create secret generic openbao-unseal-key --from-file=key="$key" >/dev/null
  rm -f "$key"
fi
h upgrade --install openbao oci://ghcr.io/openbao/charts/openbao --version "$OPENBAO_CHART" \
  -n openbao -f "$HERE/values/openbao.yaml" >/dev/null
retry 60 5 k -n openbao get pod/$BAO_POD >/dev/null 2>&1
k -n openbao wait pod/$BAO_POD --for=jsonpath='{.status.phase}'=Running --timeout=300s >/dev/null
# `bao status` exits 2 while sealed: read its JSON regardless of the exit code.
bao_status() { k -n openbao exec $BAO_POD -- bao status -format=json 2>/dev/null || true; }
until bao_status | jq -e '.type' >/dev/null 2>&1; do sleep 2; done
if [[ "$(bao_status | jq -r .initialized)" != "true" ]]; then
  log "Initializing OpenBao (recovery key and root token kept in Secret openbao/openbao-init)"
  init="$(k -n openbao exec $BAO_POD -- bao operator init -recovery-shares=1 -recovery-threshold=1 -format=json)"
  k -n openbao create secret generic openbao-init \
    --from-literal=root-token="$(jq -r .root_token <<<"$init")" \
    --from-literal=recovery-key="$(jq -r '.recovery_keys_b64[0]' <<<"$init")" >/dev/null
fi
until [[ "$(bao_status | jq -r .sealed)" == "false" ]]; do sleep 2; done
ROOT_TOKEN="$(k -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d)"

# bao in the pod; the token goes through stdin (never on a command line), the rest of stdin is passed on.
bao() { { echo "$ROOT_TOKEN"; cat; } | k -n openbao exec -i $BAO_POD -- sh -c 'read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' bao "$@"; }
baoq() { bao "$@" </dev/null; }
kv_get() { local r; r="$(baoq kv get -format=json -mount=secret "$1" 2>/dev/null | jq -c '.data.data' 2>/dev/null || true)"; [[ -n "$r" && "$r" != null ]] && echo "$r" || echo '{}'; }
kv_put() { bao kv put -mount=secret "$1" - >/dev/null; }
# Merges generated defaults under the stored values: what is stored wins (generated once, kept).
kv_seed() { local path="$1" defaults="$2"; jq -c --argjson cur "$(kv_get "$path")" '. + $cur' <<<"$defaults" | kv_put "$path"; }

log "Configuring OpenBao (KV v2 at secret/, Kubernetes auth, policies, roles)"
baoq secrets list -format=json | jq -e '."secret/"' >/dev/null || baoq secrets enable -path=secret kv-v2 >/dev/null
baoq auth list -format=json | jq -e '."kubernetes/"' >/dev/null || baoq auth enable kubernetes >/dev/null
baoq write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc >/dev/null
# ClusterSecretStore `openbao` (local trial: reads the whole KV mount).
# Writes only under secret/teams/*: the rotate-secret action pushes generated values there (PushSecret).
printf 'path "secret/data/*" { capabilities = ["read"] }\npath "secret/metadata/*" { capabilities = ["read", "list"] }\npath "secret/data/teams/*" { capabilities = ["create", "update", "read"] }\npath "secret/metadata/teams/*" { capabilities = ["create", "update", "read", "list"] }\n' \
  | bao policy write eso - >/dev/null
baoq write auth/kubernetes/role/eso bound_service_account_names=openbao-reader \
  bound_service_account_namespaces=external-secrets token_policies=eso token_ttl=15m >/dev/null
# The portal itself resolves ${vault:secret/apps/...#key} references.
printf 'path "secret/data/apps/*" { capabilities = ["read"] }\n' | bao policy write asterius-platform - >/dev/null
baoq write auth/kubernetes/role/asterius-platform bound_service_account_names=asterius-platform-api,asterius-platform-worker \
  bound_service_account_namespaces="$NS" token_policies=asterius-platform token_ttl=1h >/dev/null
# One-shot Jobs of the portal's Kubernetes Job invoker (rotate-secret): write team secrets only.
printf 'path "secret/data/teams/*" { capabilities = ["create", "update", "read"] }\npath "secret/metadata/teams/*" { capabilities = ["create", "update", "read", "list"] }\n' \
  | bao policy write asterius-jobs - >/dev/null
baoq write auth/kubernetes/role/asterius-jobs bound_service_account_names=rotate-secret \
  bound_service_account_namespaces=asterius-jobs token_policies=asterius-jobs token_ttl=15m >/dev/null

log "Seeding generated secrets (kept across runs)"
PG_PASSWORD="$(jq -r '.password // empty' <<<"$(kv_get asterius-platform/postgres)")"; [[ -n "$PG_PASSWORD" ]] || PG_PASSWORD="$(rand 16)"
jq -nc --arg p "$PG_PASSWORD" '{username:"asterius", password:$p}' | kv_put asterius-platform/postgres
kv_seed asterius-platform/env "$(jq -nc --arg s "$(openssl rand -base64 32)" --arg m "$(rand 20)" --arg b "$(rand 16)" \
  '{SECRETS_KEY:$s, METRICS_TOKEN:$m, BOOTSTRAP_TOKEN:$b}')"
# DATABASE_URL always follows the stored password.
jq -c --arg u "postgres://asterius:$PG_PASSWORD@postgres.$NS.svc:5432/asterius" '.DATABASE_URL = $u' \
  <<<"$(kv_get asterius-platform/env)" | kv_put asterius-platform/env
$CP && kv_seed platform/watcher "$(jq -nc --arg s "$(rand 32)" '{secret:$s}')"
kv_seed observability/grafana "$(jq -nc --arg p "$(rand 16)" '{"admin-user":"admin","admin-password":$p}')"
[[ "$(kv_get apps/demo)" != '{}' ]] || jq -nc --arg t "$(rand)" '{token:$t}' | kv_put apps/demo

# ---------------------------------------------------------------------------------------------------------------------
log "Azure DevOps PAT (secret/platform/ado)"
# The PAT goes to curl through a config on stdin (never on a command line) and is never printed.
ado_ok() { [[ "$(curl -s -o /dev/null -w '%{http_code}' -K - "$ADO_ORG_URL/_apis/projects?api-version=7.1&\$top=1" <<<"user = \":$1\"")" == 200 ]]; }
ado="$(kv_get platform/ado)"
pat="$(jq -r '.pat // empty' <<<"$ado")"
valid_to="$(jq -r '.valid_to // empty' <<<"$ado")"
given_pat="${ADO_PAT:-}"
if [[ -z "$given_pat" && -n "${ADO_PAT_FILE:-}" ]]; then
  [[ -r "$ADO_PAT_FILE" ]] || { echo "ADO_PAT_FILE=$ADO_PAT_FILE is not readable" >&2; exit 1; }
  given_pat="$(tr -d '[:space:]' <"$ADO_PAT_FILE")"
fi
# Expiry as an RFC3339 date: "2027-02" / "2027-02-15" / any `date -d` form; unparseable → unknown.
to_rfc3339() { local d="$1"; [[ "$d" =~ ^[0-9]{4}-[0-9]{2}$ ]] && d="$d-01"; date -u -d "$d" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true; }
if [[ -n "${ADO_PAT_VALID_TO:-}" ]]; then
  ADO_PAT_VALID_TO="$(to_rfc3339 "$ADO_PAT_VALID_TO")"
  [[ -n "$ADO_PAT_VALID_TO" ]] || warn "ADO_PAT_VALID_TO is not a date: stored as unknown"
fi
# A stored expiry that does not parse counts as unknown (the PAT is reused while it authenticates).
[[ -n "$valid_to" && -z "$(to_rfc3339 "$valid_to")" ]] && valid_to=""
if [[ -n "$given_pat" ]]; then
  # An existing PAT given by the caller: it must authenticate; it replaces the stored one.
  ado_ok "$given_pat" || { echo "the given PAT (ADO_PAT / ADO_PAT_FILE) does not authenticate against $ADO_ORG_URL" >&2; exit 1; }
  if [[ "$given_pat" == "$pat" && ( -z "${ADO_PAT_VALID_TO:-}" || "${ADO_PAT_VALID_TO:-}" == "$valid_to" ) ]]; then
    echo "The given PAT is already in OpenBao (valid to ${valid_to:-unknown})"
  else
    jq -nc --arg p "$given_pat" --arg o "$ADO_ORG_URL" --arg v "${ADO_PAT_VALID_TO:-}" \
      '{pat:$p, org_url:$o, source:"provided"} + (if $v == "" then {} else {valid_to:$v} end)' | kv_put platform/ado
    echo "Stored the given PAT in OpenBao (valid to ${ADO_PAT_VALID_TO:-unknown})"
  fi
# Reused while it authenticates and stays valid for more than 7 days.
elif [[ -n "$pat" ]] && ado_ok "$pat" && [[ -z "$valid_to" || "$(date -u -d "$valid_to" +%s 2>/dev/null || echo 0)" -gt "$(( $(date +%s) + 7*86400 ))" ]]; then
  echo "Reusing the stored PAT (valid to ${valid_to:-unknown})"
else
  command -v az >/dev/null || { echo "no usable PAT: set ADO_PAT / ADO_PAT_FILE, or install the az CLI (az login) to create one" >&2; exit 1; }
  TOK="$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)"
  create_pat() {
    curl -sS -X POST "https://vssps.dev.azure.com/$ADO_ORG/_apis/tokens/pats?api-version=7.1-preview.1" \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      --data "$(jq -nc --arg s "$1" --arg v "$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)" \
        '{displayName:"asterius-v2-kind", scope:$s, validTo:$v, allOrgs:false}')"
  }
  resp="$(create_pat 'vso.code_full vso.project_manage vso.build_execute vso.serviceendpoint_manage vso.environment_manage vso.graph_manage vso.variablegroups_manage')"
  if [[ "$(jq -r '.patToken.token // empty' <<<"$resp" 2>/dev/null)" == "" ]]; then
    warn "PAT with explicit scopes refused ($(jq -r '.patTokenError // .message // .' <<<"$resp" 2>/dev/null | head -c 300)); retrying with app_token"
    resp="$(create_pat app_token)"
  fi
  pat="$(jq -r '.patToken.token // empty' <<<"$resp")"
  [[ -n "$pat" ]] || { echo "PAT creation failed: $(jq -c 'del(.patToken.token)' <<<"$resp" 2>/dev/null || echo "$resp" | head -c 300)" >&2; exit 1; }
  jq -nc --arg p "$pat" --arg o "$ADO_ORG_URL" --argjson t "$(jq -c .patToken <<<"$resp")" \
    '{pat:$p, org_url:$o, valid_to:$t.validTo, authorization_id:$t.authorizationId, scope:$t.scope, display_name:$t.displayName}' \
    | kv_put platform/ado
  echo "Created PAT asterius-v2-kind (valid to $(jq -r .patToken.validTo <<<"$resp"), scope $(jq -r .patToken.scope <<<"$resp"))"
  retry 12 5 ado_ok "$pat" || warn "the new PAT does not authenticate yet against $ADO_ORG_URL"
fi
unset given_pat pat

# ---------------------------------------------------------------------------------------------------------------------
# Argo Workflows is not part of V2 any more (one-shot operations are ADO pipelines or Kubernetes Jobs): removed from
# clusters built by an earlier version of this script.
if h status argo-workflows -n argo-workflows >/dev/null 2>&1 || k get namespace argo-workflows >/dev/null 2>&1; then
  log "Removing Argo Workflows (no longer part of V2)"
  h uninstall argo-workflows -n argo-workflows --wait --timeout 5m >/dev/null 2>&1 || true
  k -n "$NS" delete externalsecret portal-argo-token --ignore-not-found >/dev/null
  k -n "$NS" delete secret portal-argo-token --ignore-not-found >/dev/null
  k get crd -o name | grep -E '^customresourcedefinition\.apiextensions\.k8s\.io/[a-z]*workflow[a-z]*\.argoproj\.io$' \
    | xargs -r kubectl --context "$CONTEXT" delete --wait=false >/dev/null || true
  k delete namespace argo-workflows --ignore-not-found --wait=false >/dev/null
  baoq kv metadata delete -mount=secret platform/argo-workflows >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------------------------------------------------
log "Argo CD (chart $ARGOCD_CHART)"
# Crossplane profile: health checks in the `resource.customizations` block of argocd-cm (wildcard groups/kinds are
# only valid there; ConfigMap keys cannot hold `*`), all using values/crossplane-health.lua; ProviderConfigUsage
# objects (churn with every managed resource) hidden from Argo CD.
profile_values="$(mktemp --suffix=.json)"
if $CP; then
  custom=""
  for key in 'platform.asterius.io/Service' 'platform.asterius.io/*' '*.upbound.io/*' '*.crossplane.io/*'; do
    custom+="\"$key\":"$'\n'"  health.lua: |"$'\n'"$(sed 's/^/    /' "$HERE/values/crossplane-health.lua")"$'\n'
  done
  jq -n --arg c "$custom" '{configs: {cm: {"resource.customizations": $c, resourceExclusionsAdditional: [
    {apiGroups: ["*.crossplane.io", "*.upbound.io"], kinds: ["ProviderConfigUsage", "ClusterProviderConfigUsage"], clusters: ["*"]}]}}}' >"$profile_values"
else
  echo '{}' >"$profile_values"
fi
h upgrade --install argocd oci://ghcr.io/argoproj/argo-helm/argo-cd --version "$ARGOCD_CHART" \
  -n argocd -f "$HERE/values/argo-cd.yaml" -f "$profile_values" --timeout 10m >/dev/null
rm -f "$profile_values"
# No helm --wait: the controller restarts until the redis-secret-init Job has run, which helm 4's watcher reports
# as a failure. rollout status tolerates it.
for w in deploy/argocd-server deploy/argocd-repo-server deploy/argocd-redis statefulset/argocd-application-controller; do
  k -n argocd rollout status "$w" --timeout=600s >/dev/null
done
ARGOCD_ADMIN="$(k -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
argocd_session() {
  ing argocd.localtest.me /api/v1/session -H 'content-type: application/json' \
    --data "$(jq -nc --arg p "$ARGOCD_ADMIN" '{username:"admin", password:$p}')" | jq -r '.token // empty'
}
retry 30 5 argocd_session >/dev/null || { echo "Argo CD API not reachable through the ingress" >&2; exit 1; }
ARGOCD_SESSION="$(argocd_session)"
portal_token="$(jq -r '.token // empty' <<<"$(kv_get platform/argocd)")"
if [[ -z "$portal_token" || "$(ing argocd.localtest.me /api/v1/session/userinfo -H "Authorization: Bearer $portal_token" | jq -r '.loggedIn // false')" != true ]]; then
  echo "Generating an API token for the Argo CD account 'portal'"
  portal_token="$(ing argocd.localtest.me /api/v1/account/portal/token -X POST -H "Authorization: Bearer $ARGOCD_SESSION" \
    -H 'content-type: application/json' --data '{"name":"portal"}' | jq -r '.token // empty')"
  [[ -n "$portal_token" ]] || { echo "Argo CD token generation failed" >&2; exit 1; }
  jq -nc --arg t "$portal_token" '{token:$t}' | kv_put platform/argocd
fi

# ---------------------------------------------------------------------------------------------------------------------
log "ClusterSecretStore openbao and ExternalSecrets"
k apply -f "$HERE/bootstrap/secrets.yaml" >/dev/null
$CP && k apply -f "$HERE/bootstrap/crossplane/secrets.yaml" >/dev/null
retry 30 2 bash -c "kubectl --context $CONTEXT get clustersecretstore openbao -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}' | grep -qx True" \
  || { k get clustersecretstore openbao -o yaml >&2; exit 1; }
externalsecrets=("$NS/portal-ado" "$NS/portal-postgres" "$NS/asterius-platform-secrets" observability/grafana-admin argocd/repo-portal-resources)
$CP && externalsecrets+=("$NS/portal-v2" portal-agent/watcher)
for es in "${externalsecrets[@]}"; do
  # A changed secret is picked up now rather than at the next refresh.
  k -n "${es%/*}" annotate externalsecret "${es#*/}" force-sync="$(date +%s)" --overwrite >/dev/null
  k -n "${es%/*}" wait externalsecret "${es#*/}" --for=condition=Ready --timeout=120s >/dev/null
done
echo "ExternalSecrets synced"

# ---------------------------------------------------------------------------------------------------------------------
if $CP; then
  log "Crossplane v2 core (chart $CROSSPLANE_CHART) and Gatekeeper (chart $GATEKEEPER_CHART)"
  h upgrade --install crossplane crossplane --repo https://charts.crossplane.io/stable --version "$CROSSPLANE_CHART" \
    -n crossplane-system -f "$HERE/values/crossplane.yaml" >/dev/null
  h upgrade --install gatekeeper gatekeeper --repo https://open-policy-agent.github.io/gatekeeper/charts --version "$GATEKEEPER_CHART" \
    -n gatekeeper-system -f "$HERE/values/gatekeeper.yaml" >/dev/null
fi

# ---------------------------------------------------------------------------------------------------------------------
log "Observability: Loki, Tempo, kube-prometheus-stack, OTel Collector"
h upgrade --install loki oci://ghcr.io/grafana-community/helm-charts/loki --version "$LOKI_CHART" \
  -n observability -f "$HERE/values/loki.yaml" >/dev/null
h upgrade --install tempo oci://ghcr.io/grafana-community/helm-charts/tempo --version "$TEMPO_CHART" \
  -n observability -f "$HERE/values/tempo.yaml" >/dev/null
h upgrade --install kps oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack --version "$KPS_CHART" \
  -n observability -f "$HERE/values/kube-prometheus-stack.yaml" --timeout 10m >/dev/null
k apply -f "$HERE/bootstrap/aliases.yaml" >/dev/null
h upgrade --install otel-collector oci://ghcr.io/open-telemetry/opentelemetry-helm-charts/opentelemetry-collector --version "$OTEL_CHART" \
  -n otel -f "$HERE/values/otel-collector.yaml" >/dev/null
agent_values=(-f "$HERE/values/otel-agent.yaml"); $CP && agent_values+=(-f "$HERE/values/otel-agent-crossplane.yaml")
h upgrade --install otel-agent oci://ghcr.io/open-telemetry/opentelemetry-helm-charts/opentelemetry-collector --version "$OTEL_CHART" \
  -n otel "${agent_values[@]}" >/dev/null

# ---------------------------------------------------------------------------------------------------------------------
# Loads a local image into the node unless the node already has this exact image.
kind_load() {
  local img="$1" id node_id
  id="$(docker image inspect -f '{{.Id}}' "$img")"
  node_id="$(docker exec "$CLUSTER-control-plane" crictl inspecti -o json "docker.io/library/$img" 2>/dev/null | jq -r '.status.id // empty' || true)"
  if [[ "$id" != "$node_id" ]]; then kind load docker-image --name "$CLUSTER" "$img"; else echo "$img already on the node"; fi
}
build_image() { # build_image <tag> <context> [dockerfile]
  if $BUILD || ! docker image inspect "$1" >/dev/null 2>&1; then
    log "Building image $1"
    docker build -t "$1" ${3:+-f "$3"} "$2"
  fi
  kind_load "$1"
}

log "Portal database (PostgreSQL 17)"
k apply -f "$HERE/bootstrap/postgres.yaml" >/dev/null
k -n "$NS" rollout status statefulset/postgres --timeout=300s

log "Portal configuration (config/*.yaml + examples/v2/config/*$($CP && echo ' + examples/v2/crossplane/config/*'))"
cm_args=()
for f in "$ROOT"/config/*.yaml; do cm_args+=("--from-file=$(basename "$f")=$f"); done
shopt -s nullglob
add_config() { local dir="$1" prefix="$2" f; for f in "$dir"/*.yaml "$dir"/*.yml "$dir"/*.json; do cm_args+=("--from-file=$prefix$(basename "$f")=$f"); done; }
add_config "$ROOT/examples/v2/config" v2-
$CP && add_config "$ROOT/examples/v2/crossplane/config" v2cp-
shopt -u nullglob
k -n "$NS" create configmap asterius-platform-config-files "${cm_args[@]}" --dry-run=client -o yaml | k apply -f - >/dev/null
printf '  %s\n' "${cm_args[@]#--from-file=}" | sed 's/=.*//'

# Portal image: the repository's Dockerfile.
if $BUILD || ! docker image inspect asterius-platform:v2-dev >/dev/null 2>&1; then
  log "Building image asterius-platform:v2-dev"
  docker build -t asterius-platform:v2-dev "$ROOT"
fi
kind_load asterius-platform:v2-dev

log "Portal (chart deploy/helm/asterius-platform)"
# Same image tag after a rebuild, and Secret / values read at startup only: a pod annotation with their hash rolls the
# pods when one of them changed.
inputs_hash="$( { k -n "$NS" get secret asterius-platform-secrets -o jsonpath='{.data}'; cat "$HERE/values/asterius-platform.yaml";
  docker image inspect -f '{{.Id}}' asterius-platform:v2-dev; } | sha256sum | cut -c1-16)"
h upgrade --install asterius-platform "$ROOT/deploy/helm/asterius-platform" -n "$NS" \
  -f "$HERE/values/asterius-platform.yaml" --set-string "podAnnotations.asterius\\.io/inputs=$inputs_hash" \
  --wait --timeout 10m >/dev/null
for d in asterius-platform-api asterius-platform-worker; do k -n "$NS" rollout status deploy/$d --timeout=600s; done

# ---------------------------------------------------------------------------------------------------------------------
log "Argo CD bootstrap: app of apps asterius-root ($REPO_URL, main, argocd/)"
k apply -f "$HERE/bootstrap/argocd-root.yaml" >/dev/null

# ---------------------------------------------------------------------------------------------------------------------
log "Extension hook: image of apps/render-service$($CP && echo ' and apps/agent'), manifests in deploy/kind/manifests/$($CP && echo ' and manifests/crossplane/')"
# Build context: the repository root when the Dockerfile copies paths under apps/ or packages/, else the app folder.
build_app() { # build_app <dir> <tag>
  local df="$ROOT/apps/$1/Dockerfile" ctx="$ROOT/apps/$1"
  [[ -f "$df" ]] || { echo "apps/$1: no Dockerfile (skipped)"; return 0; }
  grep -qE '^\s*(COPY|ADD)\b.*\s(\./)?(apps|packages)/' "$df" && ctx="$ROOT"
  build_image "$2" "$ctx" "$df"
}
# Owned by other parts of the build: a failing image build is reported, not fatal.
build_app render-service asterius-render:dev || warn "image asterius-render:dev failed to build"
$CP && { build_app agent asterius-agent:dev || warn "image asterius-agent:dev failed to build"; }
# Not recursive: manifests/crossplane/ belongs to the crossplane profile only.
shopt -s nullglob
manifests=("$HERE"/manifests/*.yaml "$HERE"/manifests/*.yml "$HERE"/manifests/*.json)
$CP && manifests+=("$HERE"/manifests/crossplane/*.yaml "$HERE"/manifests/crossplane/*.yml "$HERE"/manifests/crossplane/*.json)
shopt -u nullglob
for m in "${manifests[@]}"; do echo "apply ${m#"$HERE"/manifests/}"; k apply -f "$m" || warn "kubectl apply -f $m failed"; done
if $BUILD; then
  for d in $(k get deploy -A -o json | jq -r '.items[] | select([.spec.template.spec.containers[].image] | any(. == "asterius-render:dev" or . == "asterius-agent:dev")) | "\(.metadata.namespace)/\(.metadata.name)"'); do
    k -n "${d%/*}" rollout restart deploy "${d#*/}" >/dev/null
  done
fi

# ---------------------------------------------------------------------------------------------------------------------
log "Waiting for every Deployment / StatefulSet / DaemonSet"
for kind in deploy statefulset daemonset; do
  # OnDelete StatefulSets (OpenBao) have no rollout status: their pods are waited for instead.
  k get "$kind" -A -o json | jq -r '.items[] | "\(.metadata.namespace) \(.metadata.name) \(.spec.updateStrategy.type // .spec.strategy.type // "")"' |
    while read -r ns name strategy; do
      if [[ "$strategy" == OnDelete ]]; then
        sel="$(k -n "$ns" get "$kind/$name" -o json | jq -r '.spec.selector.matchLabels | to_entries | map("\(.key)=\(.value)") | join(",")')"
        k -n "$ns" wait pod -l "$sel" --for=condition=Ready --timeout=600s >/dev/null || warn "$kind $ns/$name not ready"
      else
        k -n "$ns" rollout status "$kind/$name" --timeout=600s >/dev/null || warn "$kind $ns/$name not ready"
      fi
    done
done

$VERIFY && "$HERE/verify.sh" || true

log "Done"
GRAFANA_PW_CMD="kubectl --context $CONTEXT -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d"
cat <<EOF
Profile: $PROFILE (re-run with --profile lean|crossplane to change it)

URL                                          What               Credentials
http://portal.localtest.me:$HTTP_PORT            Portal             sign up (local account) with the BOOTSTRAP_TOKEN below → first admin
http://argocd.localtest.me:$HTTP_PORT            Argo CD            admin / argocd-initial-admin-secret below
http://grafana.localtest.me:$HTTP_PORT           Grafana            admin / grafana-admin below
http://openbao.localtest.me:$HTTP_PORT           OpenBao UI         root token below

BOOTSTRAP_TOKEN  kubectl --context $CONTEXT -n $NS get secret asterius-platform-secrets -o jsonpath='{.data.BOOTSTRAP_TOKEN}' | base64 -d
Argo CD admin    kubectl --context $CONTEXT -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
Grafana admin    $GRAFANA_PW_CMD
OpenBao root     kubectl --context $CONTEXT -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d
ADO PAT          kubectl --context $CONTEXT -n $NS get secret portal-ado -o jsonpath='{.data.ADO_PAT}' | base64 -d
EOF
