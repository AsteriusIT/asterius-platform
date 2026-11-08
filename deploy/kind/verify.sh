#!/usr/bin/env bash
# End-to-end checks of the kind management cluster (run by install.sh; can be run alone). Exit code = failed checks.
# The profile (lean | crossplane) is read from ConfigMap kube-system/asterius-install; crossplane adds its checks.
set -uo pipefail

CONTEXT=kind-asterius-v2
HTTP_PORT=18080
k() { kubectl --context "$CONTEXT" "$@"; }
ing() { local host="$1" path="$2"; shift 2; curl -sS -m 20 --resolve "$host:$HTTP_PORT:127.0.0.1" "http://$host:$HTTP_PORT$path" "$@"; }
FAILED=0
ok() { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
ko() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=$((FAILED + 1)); }
# Runs curl inside the cluster (in-cluster URLs of the contract).
POD=verify-curl
incluster() { k -n default exec "$POD" -- curl -sS -m 15 "$@"; }
# Same, with the request body on stdin (keeps tokens off command lines).
incluster_stdin() { k -n default exec -i "$POD" -- curl -sS -m 15 "$@"; }

PROFILE="$(k -n kube-system get configmap asterius-install -o jsonpath='{.data.profile}' 2>/dev/null)"
PROFILE="${PROFILE:-lean}"
CP=false; [[ "$PROFILE" == crossplane ]] && CP=true
printf '\n\033[1m==> Verification (profile %s)\033[0m\n' "$PROFILE"

# ---- pods ----
notready="$(k get pods -A -o json | jq -r '.items[]
  | select(.status.phase != "Succeeded" and .metadata.deletionTimestamp == null)
  | select(.metadata.name != "'$POD'" and (.metadata.name | startswith("verify-") | not))
  | select(([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 0)
  | "\(.metadata.namespace)/\(.metadata.name)"')"
if [[ -z "$notready" ]]; then ok "all pods Ready ($(k get pods -A --no-headers | wc -l) pods)"; else ko "pods not Ready: $(echo $notready)"; fi
k get namespace argo-workflows >/dev/null 2>&1 && ko "namespace argo-workflows still present (Argo Workflows is removed)" || ok "no Argo Workflows"

# ---- ingress ----
for host in portal argocd grafana openbao; do
  code="$(ing "$host.localtest.me" / -o /dev/null -w '%{http_code}' 2>/dev/null)"
  [[ "$code" =~ ^(200|301|302|307|308)$ ]] && ok "http://$host.localtest.me:$HTTP_PORT → $code" || ko "http://$host.localtest.me:$HTTP_PORT → $code"
done
if getent hosts portal.localtest.me >/dev/null; then
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://portal.localtest.me:$HTTP_PORT/")"
  [[ "$code" == 200 ]] && ok "DNS: portal.localtest.me resolves and answers" || ko "DNS: portal.localtest.me → $code"
fi

# ---- secrets ----
ROOT_TOKEN="$(k -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d)"
bao_root() { echo "$ROOT_TOKEN" | k -n openbao exec -i openbao-0 -- sh -c 'read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' bao "$@"; }
bao_get() { bao_root kv get -format=json -mount=secret "$1" 2>/dev/null | jq -c .data.data; }
ado="$(bao_get platform/ado)"
pat="$(jq -r '.pat // empty' <<<"$ado")"
[[ -n "$pat" ]] && ok "OpenBao secret/platform/ado has the PAT (valid to $(jq -r '.valid_to // "unknown"' <<<"$ado"))" || ko "OpenBao secret/platform/ado has no PAT"
code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -K - 'https://dev.azure.com/AsteriusIT/_apis/projects?api-version=7.1&$top=1' <<<"user = \":$pat\"")"
[[ "$code" == 200 ]] && ok "the PAT authenticates against dev.azure.com/AsteriusIT" || ko "PAT → HTTP $code"
unset pat ado
bad_es="$(k get externalsecret -A -o json | jq -r '.items[] | select(([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 0) | "\(.metadata.namespace)/\(.metadata.name)"')"
[[ -z "$bad_es" ]] && ok "ExternalSecrets synced: $(k get externalsecret -A --no-headers | awk '{print $1"/"$2}' | tr '\n' ' ')" || ko "ExternalSecrets not synced: $bad_es"
secret_keys=(asterius-platform/portal-ado:ADO_PAT asterius-platform/asterius-platform-secrets:ADO_PAT
  asterius-platform/asterius-platform-secrets:ARGOCD_TOKEN asterius-platform/asterius-platform-secrets:DATABASE_URL
  argocd/repo-portal-resources:password)
$CP && secret_keys+=(asterius-platform/portal-v2:CROSSPLANE_WATCHER_SECRET asterius-platform/asterius-platform-secrets:CROSSPLANE_WATCHER_SECRET portal-agent/watcher:secret)
for s in "${secret_keys[@]}"; do
  ns="${s%%/*}"; rest="${s#*/}"; name="${rest%%:*}"; key="${rest#*:}"
  [[ -n "$(k -n "$ns" get secret "$name" -o jsonpath="{.data.$key}" 2>/dev/null)" ]] && ok "Secret $ns/$name has $key" || ko "Secret $ns/$name lacks $key"
done
if $CP; then
  [[ "$(k -n asterius-platform get secret portal-v2 -o jsonpath='{.data.CROSSPLANE_WATCHER_SECRET}')" == "$(k -n portal-agent get secret watcher -o jsonpath='{.data.secret}')" ]] \
    && ok "watcher secret identical in asterius-platform and portal-agent" || ko "watcher secrets differ"
fi

# ---- Argo CD ----
ARGOCD_ADMIN="$(k -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
session="$(ing argocd.localtest.me /api/v1/session -H 'content-type: application/json' --data "$(jq -nc --arg p "$ARGOCD_ADMIN" '{username:"admin",password:$p}')" | jq -r '.token // empty')"
repo_state="$(ing argocd.localtest.me /api/v1/repositories -H "Authorization: Bearer $session" | jq -r '.items[]? | select(.repo | test("portal-resources")) | .connectionState.status')"
[[ "$repo_state" == Successful ]] && ok "Argo CD repository portal-resources: connection Successful" || ko "Argo CD repository portal-resources: '${repo_state:-missing}'"
app="$(k -n argocd get application asterius-root -o json 2>/dev/null)"
if [[ -n "$app" && "$(jq -r .spec.source.path <<<"$app")" == argocd ]]; then
  ok "Application asterius-root (path argocd/): sync=$(jq -r '.status.sync.status // "?"' <<<"$app") health=$(jq -r '.status.health.status // "?"' <<<"$app") $(jq -r '[.status.conditions[]?.message] | join("; ")' <<<"$app" | head -c 200)"
else ko "Application asterius-root missing or not on path argocd/"; fi
[[ "$(k -n argocd get cm argocd-cm -o jsonpath='{.data.timeout\.reconciliation}')" == 30s ]] && ok "argocd-cm timeout.reconciliation=30s" || ko "argocd-cm timeout.reconciliation"
n_health="$(k -n argocd get cm argocd-cm -o json | jq -r '.data["resource.customizations"] // ""' | grep -cE '^"(platform\.asterius\.io/Service|platform\.asterius\.io/\*|\*\.upbound\.io/\*|\*\.crossplane\.io/\*)":$')"
if $CP; then
  [[ "$n_health" -ge 4 ]] && ok "argocd-cm: $n_health Crossplane health checks (platform.asterius.io, *.upbound.io, *.crossplane.io)" || ko "argocd-cm health checks: $n_health"
else
  [[ "$n_health" == 0 ]] && ok "argocd-cm: no Crossplane health checks (lean)" || ko "argocd-cm: $n_health Crossplane health checks in the lean profile"
fi

# ---- Kubernetes Job invoker (asterius-jobs) ----
WORKER=system:serviceaccount:asterius-platform:asterius-platform-worker
[[ "$(k auth can-i create jobs.batch -n asterius-jobs --as "$WORKER" 2>/dev/null)" == yes ]] \
  && ok "portal worker can create Jobs in asterius-jobs" || ko "portal worker cannot create Jobs in asterius-jobs"
[[ "$(k auth can-i create jobs.batch -n default --as "$WORKER" 2>/dev/null)" == no ]] \
  && ok "portal worker cannot create Jobs outside asterius-jobs" || ko "portal worker can create Jobs in default"
[[ "$(k -n asterius-platform get cm asterius-platform-env -o jsonpath='{.data.KUBE_JOB_NAMESPACES}' 2>/dev/null)" == asterius-jobs ]] \
  && ok "portal KUBE_JOB_NAMESPACES=asterius-jobs" || ko "portal KUBE_JOB_NAMESPACES is not asterius-jobs"
k -n asterius-jobs get serviceaccount rotate-secret >/dev/null 2>&1 && ok "ServiceAccount asterius-jobs/rotate-secret" || ko "ServiceAccount asterius-jobs/rotate-secret missing"

# ---- in-cluster endpoints (contract) ----
k -n default get pod "$POD" >/dev/null 2>&1 || k -n default run "$POD" --image=curlimages/curl:8.17.0 --restart=Never --command -- sleep 3600 >/dev/null
k -n default wait pod/"$POD" --for=condition=Ready --timeout=120s >/dev/null
for url in http://asterius-platform.asterius-platform.svc:8080/healthz http://opa.asterius-platform.svc:8181/health \
  http://render.asterius-platform.svc:8080/healthz http://loki.observability.svc:3100/ready http://tempo.observability.svc:3200/ready \
  http://prometheus.observability.svc:9090/-/ready http://argocd-server.argocd.svc/healthz http://openbao.openbao.svc:8200/v1/sys/health; do
  code="$(incluster -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  [[ "$code" == 200 ]] && ok "$url → 200" || ko "$url → $code"
done
for hp in otel-collector.otel.svc:4317 otel-collector.otel.svc:4318 tempo.observability.svc:4317; do
  k -n default exec "$POD" -- sh -c "nc -z -w 5 ${hp%:*} ${hp#*:} 2>/dev/null || curl -s -m 5 -o /dev/null telnet://$hp" >/dev/null 2>&1 \
    && ok "$hp open" || ko "$hp closed"
done

# ---- OpenBao role asterius-jobs (ServiceAccount rotate-secret) ----
jwt="$(k -n asterius-jobs create token rotate-secret --duration=10m 2>/dev/null)"
login="$(jq -nc --arg j "$jwt" '{role:"asterius-jobs", jwt:$j}' | incluster_stdin -X POST --data @- http://openbao.openbao.svc:8200/v1/auth/kubernetes/login 2>/dev/null)"
jtok="$(jq -r '.auth.client_token // empty' <<<"$login" 2>/dev/null)"
unset jwt
if [[ -n "$jtok" ]]; then
  ok "OpenBao: rotate-secret logs in with role asterius-jobs (policies $(jq -r '.auth.policies | join(",")' <<<"$login"))"
  # The token goes through a curl config on stdin; the body (not secret) on the command line.
  bao_as_job() { local method="$1" path="$2"; shift 2; echo "header = \"X-Vault-Token: $jtok\"" \
    | incluster_stdin -K - -o /dev/null -w '%{http_code}' -X "$method" "$@" "http://openbao.openbao.svc:8200/v1/$path" 2>/dev/null; }
  code="$(bao_as_job POST secret/data/teams/_verify/kind --data '{"data":{"value":"verify"}}')"
  [[ "$code" =~ ^20[04]$ ]] && ok "role asterius-jobs writes secret/teams/_verify/kind → $code" || ko "role asterius-jobs write secret/teams/* → $code"
  code="$(bao_as_job POST secret/data/platform/_verify --data '{"data":{"value":"verify"}}')"
  [[ "$code" == 403 ]] && ok "role asterius-jobs is denied outside secret/teams/* (403)" || ko "role asterius-jobs write secret/platform/* → $code (expected 403)"
  code="$(bao_as_job GET secret/data/platform/ado)"
  [[ "$code" == 403 ]] && ok "role asterius-jobs cannot read secret/platform/ado (403)" || ko "role asterius-jobs read secret/platform/ado → $code (expected 403)"
  bao_root kv metadata delete -mount=secret teams/_verify/kind >/dev/null 2>&1
else
  ko "OpenBao: rotate-secret login with role asterius-jobs failed: $(jq -c '.errors // .' <<<"$login" 2>/dev/null | head -c 200)"
fi
unset jtok login

# ---- Loki OTLP with run_id ----
now_ns="$(date +%s%N)"
msg="kind-verify $now_ns"
otlp="$(jq -nc --arg t "$now_ns" --arg m "$msg" '{resourceLogs:[{resource:{attributes:[
  {key:"run_id",value:{stringValue:"test"}},{key:"service",value:{stringValue:"verify"}},{key:"source",value:{stringValue:"action-runner"}},
  {key:"namespace",value:{stringValue:"default"}},{key:"step",value:{stringValue:"loki-direct"}},{key:"service.name",value:{stringValue:"verify"}}]},
  scopeLogs:[{logRecords:[{timeUnixNano:$t,severityText:"INFO",body:{stringValue:$m}}]}]}]}')"
code="$(incluster -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data "$otlp" http://loki.observability.svc:3100/otlp/v1/logs)"
[[ "$code" =~ ^20[04]$ ]] && ok "Loki accepted an OTLP log (resource run_id=test) → $code" || ko "Loki OTLP push → $code"
# Through the collector: run_id as a *record* attribute (moved to the resource by groupbyattrs).
otlp2="$(jq -nc --arg t "$now_ns" --arg m "$msg via collector" '{resourceLogs:[{resource:{attributes:[{key:"service.name",value:{stringValue:"verify"}}]},
  scopeLogs:[{logRecords:[{timeUnixNano:$t,severityText:"INFO",body:{stringValue:$m},attributes:[
  {key:"run_id",value:{stringValue:"test"}},{key:"step",value:{stringValue:"collector"}},{key:"source",value:{stringValue:"action-runner"}}]}]}]}]}')"
code="$(incluster -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data "$otlp2" http://otel-collector.otel.svc:4318/v1/logs)"
[[ "$code" == 200 ]] && ok "OTel Collector accepted an OTLP log → $code" || ko "OTel Collector OTLP push → $code"
# A Job-invoker-like pod in asterius-jobs (label asterius.io/run-id): its stdout reaches Loki through otel-agent.
job_run="verify-$now_ns"
k -n asterius-jobs delete pod verify-job-log --ignore-not-found --wait=true >/dev/null 2>&1
k -n asterius-jobs run verify-job-log --image=curlimages/curl:8.17.0 --restart=Never --labels="asterius.io/run-id=$job_run" \
  --command -- sh -c "sleep 3; echo 'kind-verify job log $job_run'; sleep 5" >/dev/null
found=""; via=""; jobl=""
for _ in $(seq 1 30); do
  res="$(incluster -G http://loki.observability.svc:3100/loki/api/v1/query_range --data-urlencode 'query={run_id="test"}' \
    --data-urlencode "start=$(( now_ns - 600000000000 ))" --data-urlencode limit=100 2>/dev/null)"
  found="$(jq -r --arg m "$msg" '[.data.result[]?.values[]?[1] | select(. == $m)] | length' <<<"$res" 2>/dev/null)"
  via="$(jq -r --arg m "$msg via collector" '[.data.result[]?.values[]?[1] | select(. == $m)] | length' <<<"$res" 2>/dev/null)"
  resj="$(incluster -G http://loki.observability.svc:3100/loki/api/v1/query_range --data-urlencode "query={run_id=\"$job_run\", source=\"action-runner\"}" \
    --data-urlencode "start=$(( now_ns - 600000000000 ))" --data-urlencode limit=10 2>/dev/null)"
  jobl="$(jq -r '[.data.result[]?.values[]?[1] | select(test("kind-verify job log"))] | length' <<<"$resj" 2>/dev/null)"
  [[ "${found:-0}" -ge 1 && "${via:-0}" -ge 1 && "${jobl:-0}" -ge 1 ]] && break
  sleep 3
done
[[ "${found:-0}" -ge 1 ]] && ok 'Loki: {run_id="test"} returns the direct OTLP log' || ko 'Loki: {run_id="test"} did not return the direct log'
[[ "${via:-0}" -ge 1 ]] && ok 'Loki: {run_id="test"} returns the log sent through the collector' || ko 'Loki: collector log not found under {run_id="test"}'
[[ "${jobl:-0}" -ge 1 ]] && ok "Loki: {run_id=\"$job_run\", source=\"action-runner\"} returns the asterius-jobs pod log (otel-agent)" \
  || ko "Loki: asterius-jobs pod log not found under {run_id=\"$job_run\"}"
k -n asterius-jobs delete pod verify-job-log --ignore-not-found --wait=false >/dev/null 2>&1
labels="$(incluster http://loki.observability.svc:3100/loki/api/v1/labels | jq -r '.data | join(",")')"
ok "Loki labels: $labels"

# ---- Tempo ----
trace_id="$(openssl rand -hex 16)"; span_id="$(openssl rand -hex 8)"
otlpt="$(jq -nc --arg tr "$trace_id" --arg sp "$span_id" --arg s "$now_ns" --arg e "$(( now_ns + 1000000 ))" '{resourceSpans:[{resource:{attributes:[{key:"service.name",value:{stringValue:"verify"}}]},
  scopeSpans:[{spans:[{traceId:$tr,spanId:$sp,name:"verify",kind:1,startTimeUnixNano:$s,endTimeUnixNano:$e,attributes:[{key:"run_id",value:{stringValue:"test"}}]}]}]}]}')"
code="$(incluster -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data "$otlpt" http://otel-collector.otel.svc:4318/v1/traces)"
[[ "$code" == 200 ]] && ok "OTel Collector accepted an OTLP trace" || ko "OTLP trace push → $code"
tcode=""
for _ in $(seq 1 20); do tcode="$(incluster -o /dev/null -w '%{http_code}' "http://tempo.observability.svc:3200/api/traces/$trace_id")"; [[ "$tcode" == 200 ]] && break; sleep 3; done
[[ "$tcode" == 200 ]] && ok "Tempo ready and returns trace $trace_id (sent through the collector)" || ko "Tempo trace $trace_id → $tcode"

# ---- Prometheus remote write (collector) ----
otlpm="$(jq -nc --arg t "$now_ns" '{resourceMetrics:[{resource:{attributes:[{key:"service.name",value:{stringValue:"verify"}}]},scopeMetrics:[{metrics:[{name:"kind_verify_total",sum:{aggregationTemporality:2,isMonotonic:true,dataPoints:[{asInt:"1",timeUnixNano:$t}]}}]}]}]}')"
incluster -o /dev/null -H 'content-type: application/json' --data "$otlpm" http://otel-collector.otel.svc:4318/v1/metrics
pm=0
for _ in $(seq 1 20); do pm="$(incluster -G http://prometheus.observability.svc:9090/api/v1/query --data-urlencode 'query=kind_verify_total' | jq '.data.result | length')"; [[ "$pm" -ge 1 ]] && break; sleep 3; done
[[ "$pm" -ge 1 ]] && ok "Prometheus received kind_verify_total through remote write" || ko "Prometheus remote write: metric not found"

# ---- Grafana ----
GPW="$(k -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
for uid in prometheus loki tempo; do
  st="$(ing grafana.localtest.me "/api/datasources/uid/$uid/health" -u "admin:$GPW" | jq -r '.status // .message')"
  [[ "$st" == OK ]] && ok "Grafana datasource $uid: OK" || ko "Grafana datasource $uid: $st"
done

# ---- crossplane profile ----
if $CP; then
  for d in crossplane-system/crossplane gatekeeper-system/gatekeeper-controller-manager gatekeeper-system/gatekeeper-audit; do
    k -n "${d%/*}" rollout status deploy "${d#*/}" --timeout=10s >/dev/null 2>&1 && ok "Deployment $d ready" || ko "Deployment $d not ready"
  done
  [[ "$(k get validatingwebhookconfiguration gatekeeper-validating-webhook-configuration -o json 2>/dev/null | jq -r '[.webhooks[].rules[]?.operations[]?] | index("DELETE") != null')" == true ]] \
    && ok "Gatekeeper validates DELETE operations" || ko "Gatekeeper: DELETE operations not enabled"
fi

k -n default delete pod "$POD" --wait=false >/dev/null 2>&1
if [[ "$FAILED" == 0 ]]; then printf '\n\033[32mAll checks passed\033[0m\n'; else printf '\n\033[31m%s check(s) failed\033[0m\n' "$FAILED"; fi
exit "$FAILED"
