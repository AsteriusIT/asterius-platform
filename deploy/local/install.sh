#!/usr/bin/env bash
# Asterius Platform on the local OrbStack Kubernetes cluster, with its ecosystem:
#   metrics-server, kube-prometheus-stack (Prometheus + Grafana), OpenBao, External Secrets Operator, SonarQube, Nexus,
#   and the platform chart with every component enabled (CNPG, Keycloak, ingress/TLS, NetworkPolicy, one replica each,
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
for ns in observability openbao external-secrets sonarqube nexus "$NS" asterius-jobs; do
  k create namespace "$ns" --dry-run=client -o yaml | k apply -f - >/dev/null
done

log "Helm repositories"
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add openbao https://openbao.github.io/openbao-helm >/dev/null 2>&1 || true
helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1 || true
helm repo add sonarqube https://SonarSource.github.io/helm-chart-sonarqube >/dev/null 2>&1 || true
helm repo update >/dev/null

log "metrics-server"
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
printf 'path "secret/data/sonarqube/*" { capabilities = ["read"] }\n' | bao policy write eso-sonarqube - >/dev/null
printf 'path "secret/data/nexus/*" { capabilities = ["read"] }\n' | bao policy write eso-nexus - >/dev/null
# The platform itself resolves ${vault:secret/apps/...#key} references of actions and integrations.
printf 'path "secret/data/apps/*" { capabilities = ["read"] }\n' | bao policy write asterius-platform - >/dev/null

baoq write auth/kubernetes/role/eso-asterius-platform bound_service_account_names=openbao-reader \
  bound_service_account_namespaces="$NS" token_policies=eso-asterius-platform token_ttl=15m >/dev/null
baoq write auth/kubernetes/role/eso-observability bound_service_account_names=openbao-reader \
  bound_service_account_namespaces=observability token_policies=eso-observability token_ttl=15m >/dev/null
baoq write auth/kubernetes/role/eso-sonarqube bound_service_account_names=openbao-reader \
  bound_service_account_namespaces=sonarqube token_policies=eso-sonarqube token_ttl=15m >/dev/null
baoq write auth/kubernetes/role/eso-nexus bound_service_account_names=openbao-reader \
  bound_service_account_namespaces=nexus token_policies=eso-nexus token_ttl=15m >/dev/null
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

# SonarQube: the admin password must have 12+ characters with upper and lower case, a digit and a special character.
current="$(kv_get sonarqube/server)"
jq -nc --argjson cur "$current" --arg db "$(rand)" --arg mp "$(rand)" --arg adm "Aa1-$(rand 16)" \
  '{DB_USERNAME:"sonarqube", DB_PASSWORD:$db, MONITORING_PASSCODE:$mp, ADMIN_PASSWORD:$adm} + $cur' | kv_put sonarqube/server

# Nexus: initial admin password (first start only) and the password of the platform's read-only user.
current="$(kv_get nexus/server)"
jq -nc --argjson cur "$current" --arg adm "$(rand)" '{ADMIN_PASSWORD:$adm} + $cur' | kv_put nexus/server
current="$(kv_get apps/nexus)"
jq -nc --argjson cur "$current" --arg p "$(rand)" '{password:$p} + $cur' | kv_put apps/nexus

# Sample secret for ${vault:secret/apps/demo#token} in actions.
[[ "$(kv_get apps/demo)" != '{}' ]] || jq -nc --arg t "$(rand)" '{token:$t}' | kv_put apps/demo

log "External Secrets Operator"
h upgrade --install external-secrets external-secrets/external-secrets -n external-secrets -f "$HERE/values/external-secrets.yaml" --wait
k apply -f "$HERE/manifests/observability-secrets.yaml" -f "$HERE/manifests/platform-secrets.yaml" -f "$HERE/manifests/sonarqube.yaml" -f "$HERE/manifests/nexus.yaml"
for es in asterius-platform-secrets asterius-platform-keycloak keycloak-db-credentials; do
  k -n "$NS" wait externalsecret/$es --for=condition=Ready --timeout=120s
done
k -n observability wait externalsecret/grafana-admin --for=condition=Ready --timeout=120s
k -n "$NS" wait cluster.postgresql.cnpg.io/keycloak-db --for=condition=Ready --timeout=300s
k -n nexus wait externalsecret/nexus-secrets --for=condition=Ready --timeout=120s
for es in sonarqube-secrets sonarqube-db-credentials; do k -n sonarqube wait externalsecret/$es --for=condition=Ready --timeout=120s; done
k -n sonarqube wait cluster.postgresql.cnpg.io/sonarqube-db --for=condition=Ready --timeout=300s

log "SonarQube Community Build"
h upgrade --install sonarqube sonarqube/sonarqube -n sonarqube -f "$HERE/values/sonarqube.yaml" --wait --timeout 15m

log "Grafana integration (service account, alert rules, contact point → platform webhook)"
# Grafana side from examples/grafana/grafana/*.json; the platform side (blueprints, integrations) is in the
# configuration ConfigMap below. Tokens live in OpenBao (secret/apps/grafana), read by the platform as ${vault:…}.
k -n observability rollout status deploy/kps-grafana --timeout=300s
GDIR="$ROOT/examples/grafana"
GRAFANA="https://platform-grafana.k8s.orb.local"
GAUTH="admin:$(k -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
g() { local m="$1" p="$2"; shift 2; curl -fsS -u "$GAUTH" -H 'content-type: application/json' -H 'X-Disable-Provenance: true' -X "$m" "$GRAFANA$p" "$@"; }
gstatus() { curl -s -o /dev/null -w '%{http_code}' -u "$GAUTH" "$GRAFANA$1"; }

grafana_secrets="$(kv_get apps/grafana)"
token="$(jq -r '.token // empty' <<<"$grafana_secrets")"
# A stored token is reused while Grafana still accepts it.
if [[ -z "$token" || "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$GRAFANA/api/search?limit=1")" != 200 ]]; then
  sa="$(g GET '/api/serviceaccounts/search?query=asterius-platform' | jq -r '.serviceAccounts[] | select(.name=="asterius-platform") | .id' | head -1)"
  [[ -n "$sa" ]] || sa="$(g POST /api/serviceaccounts --data @"$GDIR/grafana/service-account.json" | jq -r .id)"
  token="$(g POST "/api/serviceaccounts/$sa/tokens" --data "$(jq -nc --arg n "asterius-platform-$(date +%Y%m%d%H%M%S)" '{name:$n}')" | jq -r .key)"
fi
webhook_token="$(jq -r '.webhookToken // empty' <<<"$grafana_secrets")"; [[ -n "$webhook_token" ]] || webhook_token="$(rand)"
jq -nc --arg t "$token" --arg w "$webhook_token" '{token:$t, webhookToken:$w}' | kv_put apps/grafana

[[ "$(gstatus /api/folders/asterius-platform)" == 200 ]] || g POST /api/folders --data @"$GDIR/grafana/folder.json" >/dev/null
jq -c '.[]' "$GDIR/grafana/alert-rules.json" | while IFS= read -r rule; do
  uid="$(jq -r .uid <<<"$rule")"
  if [[ "$(gstatus "/api/v1/provisioning/alert-rules/$uid")" == 200 ]]; then g PUT "/api/v1/provisioning/alert-rules/$uid" --data "$rule" >/dev/null
  else g POST /api/v1/provisioning/alert-rules --data "$rule" >/dev/null; fi
done
contact="$(jq -c --arg t "$webhook_token" '.settings.authorization_credentials = $t' "$GDIR/grafana/contact-point.json")"
if g GET /api/v1/provisioning/contact-points | jq -e '.[] | select(.uid=="asterius-platform")' >/dev/null; then
  g PUT /api/v1/provisioning/contact-points/asterius-platform --data "$contact" >/dev/null
else g POST /api/v1/provisioning/contact-points --data "$contact" >/dev/null; fi
# Replaces the notification policy tree of this (dedicated) Grafana: every alert goes to the platform.
g PUT /api/v1/provisioning/policies --data @"$GDIR/grafana/notification-policy.json" >/dev/null
k apply -f "$HERE/manifests/grafana-integration.yaml" >/dev/null

log "SonarQube integration (admin password, platform user and token, analysis webhook → platform)"
# Platform side: examples/sonarqube/platform/*.json in the configuration ConfigMap below. The token and the webhook
# secret live in OpenBao (secret/apps/sonarqube), read by the platform as ${vault:…}.
SDIR="$ROOT/examples/sonarqube"
SONAR="https://sonarqube.k8s.orb.local"
SONAR_ADMIN="$(jq -r .ADMIN_PASSWORD <<<"$(kv_get sonarqube/server)")"
sstatus() { curl -s -o /dev/null -w '%{http_code}' -u "$1" "$SONAR/api/system/info"; }
until [[ "$(curl -s "$SONAR/api/system/status" | jq -r .status 2>/dev/null)" == UP ]]; do sleep 5; done
# First start: admin/admin, replaced by the password of OpenBao.
if [[ "$(sstatus "admin:$SONAR_ADMIN")" != 200 ]]; then
  curl -fsS -u admin:admin -X POST "$SONAR/api/users/change_password" \
    --data-urlencode login=admin --data-urlencode previousPassword=admin --data-urlencode "password=$SONAR_ADMIN"
fi
s() { local m="$1" p="$2"; shift 2; curl -fsS -u "admin:$SONAR_ADMIN" -X "$m" "$SONAR$p" "$@"; }

sonar_secrets="$(kv_get apps/sonarqube)"
token="$(jq -r '.token // empty' <<<"$sonar_secrets")"
# A stored token is reused while SonarQube still accepts it.
if [[ -z "$token" || "$(curl -s -u "$token:" "$SONAR/api/authentication/validate" | jq -r .valid)" != true ]]; then
  if [[ "$(s GET '/api/v2/users-management/users?q=asterius-platform' | jq '[.users[] | select(.login=="asterius-platform")] | length')" == 0 ]]; then
    # Local user without a usable password: it only signs in with its token (Browse through the sonar-users group).
    s POST /api/v2/users-management/users -H 'content-type: application/json' \
      --data "$(jq -nc --arg p "Aa1-$(rand 24)" '{login:"asterius-platform", name:"Asterius Platform", password:$p, local:true}')" >/dev/null
  fi
  token="$(s POST /api/user_tokens/generate --data-urlencode login=asterius-platform \
    --data-urlencode "name=asterius-platform-$(date +%Y%m%d%H%M%S)" | jq -r .token)"
fi
webhook_secret="$(jq -r '.webhookSecret // empty' <<<"$sonar_secrets")"; [[ -n "$webhook_secret" ]] || webhook_secret="$(rand)"
jq -nc --arg t "$token" --arg w "$webhook_secret" '{token:$t, webhookSecret:$w}' | kv_put apps/sonarqube

# Global webhook: every analysis is sent to the platform, signed with X-Sonar-Webhook-HMAC-SHA256.
hook_url="http://asterius-platform.asterius-platform.svc/api/v1/ingest/default/sonarqube-analyses"
hook="$(s GET /api/webhooks/list | jq -r '.webhooks[] | select(.name=="asterius-platform") | .key' | head -1)"
if [[ -n "$hook" ]]; then
  s POST /api/webhooks/update --data-urlencode "webhook=$hook" --data-urlencode name=asterius-platform \
    --data-urlencode "url=$hook_url" --data-urlencode "secret=$webhook_secret" >/dev/null
else
  s POST /api/webhooks/create --data-urlencode name=asterius-platform \
    --data-urlencode "url=$hook_url" --data-urlencode "secret=$webhook_secret" >/dev/null
fi

log "Nexus Repository integration (EULA, read-only role and user for the platform)"
# Platform side: examples/nexus/platform/*.json in the configuration ConfigMap below; the user's password lives in
# OpenBao (secret/apps/nexus), read by the platform as ${vault:…}.
NDIR="$ROOT/examples/nexus"
NEXUS="https://nexus.k8s.orb.local"
k -n nexus rollout status statefulset/nexus --timeout=600s
NAUTH="admin:$(jq -r .ADMIN_PASSWORD <<<"$(kv_get nexus/server)")"
n() { local m="$1" p="$2"; shift 2; curl -fsS -u "$NAUTH" -H 'content-type: application/json' -X "$m" "$NEXUS/service/rest$p" "$@"; }
until [[ "$(curl -s -o /dev/null -w '%{http_code}' "$NEXUS/service/rest/v1/status/writable")" == 200 ]]; do sleep 5; done
# Community Edition asks to accept its EULA before use; the local trial accepts it on the operator's behalf.
eula="$(n GET /v1/system/eula)"
[[ "$(jq -r .accepted <<<"$eula")" == true ]] || n POST /v1/system/eula --data "$(jq -c '.accepted = true' <<<"$eula")" >/dev/null
role="$(jq -nc '{id:"asterius-platform-read", name:"asterius-platform-read", description:"Asterius Platform: browse and search every repository",
  privileges:["nx-repository-view-*-*-browse","nx-repository-view-*-*-read","nx-search-read"], roles:[]}')"
if [[ "$(curl -s -o /dev/null -w '%{http_code}' -u "$NAUTH" "$NEXUS/service/rest/v1/security/roles/asterius-platform-read")" == 200 ]]; then
  n PUT /v1/security/roles/asterius-platform-read --data "$role" >/dev/null
else n POST /v1/security/roles --data "$role" >/dev/null; fi
nexus_password="$(jq -r .password <<<"$(kv_get apps/nexus)")"
if [[ "$(n GET '/v1/security/users?userId=asterius-platform' | jq '[.[] | select(.userId=="asterius-platform")] | length')" == 0 ]]; then
  n POST /v1/security/users --data "$(jq -nc --arg p "$nexus_password" '{userId:"asterius-platform", firstName:"Asterius", lastName:"Platform",
    emailAddress:"asterius-platform@localhost", password:$p, status:"active", roles:["asterius-platform-read"]}')" >/dev/null
else
  n PUT /v1/security/users/asterius-platform/change-password -H 'content-type: text/plain' --data "$nexus_password" >/dev/null
fi

log "Platform configuration (config/ + examples/{grafana,sonarqube,nexus}/platform)"
k -n "$NS" create configmap asterius-platform-config-files \
  $(for f in "$ROOT"/config/*.yaml "$GDIR"/platform/*.json "$SDIR"/platform/*.json "$NDIR"/platform/*.json; do printf -- '--from-file=%s ' "$f"; done) \
  --dry-run=client -o yaml | k apply -f - >/dev/null

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
SonarQube  https://sonarqube.k8s.orb.local   (user admin, password below)
Nexus      https://nexus.k8s.orb.local   (user admin, password below)

BOOTSTRAP_TOKEN  kubectl -n $NS get secret asterius-platform-secrets -o jsonpath='{.data.BOOTSTRAP_TOKEN}' | base64 -d
Grafana admin    kubectl -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
OpenBao root     kubectl -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d
SonarQube admin  kubectl -n sonarqube get secret sonarqube-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d
Nexus admin      kubectl -n nexus get secret nexus-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d
EOF
