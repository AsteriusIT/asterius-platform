#!/usr/bin/env bash
# Applies every example of examples/ with the real Terraform CLI against ASTERIUS_ENDPOINT / ASTERIUS_TOKEN (e.g. the
# server of scripts/local-server.sh), through a dev_overrides block on a freshly built provider:
#   apply → plan is empty → data sources → import of every resource → plan is empty → destroy.
# TF (default: terraform) may name `tofu`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TF="${TF:-terraform}"
: "${ASTERIUS_ENDPOINT:?set ASTERIUS_ENDPOINT}" "${ASTERIUS_TOKEN:?set ASTERIUS_TOKEN}"

WORK="$(mktemp -d)"
# On failure, destroy what was created (best effort) so that the next run starts clean.
cleanup() {
  if [[ -f "$WORK/config/terraform.tfstate" ]]; then
    (cd "$WORK/config" && "$TF" destroy -input=false -auto-approve -no-color >/dev/null 2>&1) || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/bin" "$WORK/config"
(cd "$ROOT" && GOTOOLCHAIN=local go build -o "$WORK/bin/terraform-provider-asterius" .)
cat >"$WORK/terraformrc" <<EOF
provider_installation {
  dev_overrides {
    "asteriusit/asterius" = "$WORK/bin"
  }
  direct {}
}
EOF
export TF_CLI_CONFIG_FILE="$WORK/terraformrc"
export TF_IN_AUTOMATION=1
export TF_VAR_ingest_token="example-token-0123456789-abcdefghijklmnop"

cd "$WORK/config"
cat >providers.tf <<'EOF'
terraform {
  required_providers {
    asterius = { source = "asteriusit/asterius" }
  }
}
provider "asterius" {}
EOF
for f in "$ROOT"/examples/resources/*/resource.tf; do
  cp "$f" "$(basename "$(dirname "$f")").tf"
done

step() { echo "--- $*" >&2; }
expect_empty_plan() {
  local code=0
  "$TF" plan -input=false -detailed-exitcode -no-color >"$WORK/plan.txt" || code=$?
  if [[ $code -ne 0 ]]; then
    cat "$WORK/plan.txt" >&2
    echo "expected an empty plan ($1), exit code $code" >&2
    exit 1
  fi
}

step "apply"
"$TF" apply -input=false -auto-approve -no-color >/dev/null
step "plan after apply is empty"
expect_empty_plan "after apply"

step "data sources"
for f in "$ROOT"/examples/data-sources/*/data-source.tf; do
  cp "$f" "data-$(basename "$(dirname "$f")").tf"
done
"$TF" apply -input=false -auto-approve -no-color >/dev/null
"$TF" output -json | grep -q '"gold"' || { echo "data source outputs:" >&2; "$TF" output >&2; exit 1; }

step "import of every resource"
mapfile -t addresses < <("$TF" state list | grep -v '^data\.')
declare -A ids
for a in "${addresses[@]}"; do
  ids[$a]="$("$TF" state show -no-color "$a" | awk '$1 == "id" { gsub(/"/, "", $3); print $3; exit }')"
done
for a in "${addresses[@]}"; do
  "$TF" state rm "$a" >/dev/null
  "$TF" import -input=false -no-color "$a" "${ids[$a]}" >/dev/null
done
# Imported JSON documents carry the server's defaults and secret values are not imported: one apply converges.
"$TF" apply -input=false -auto-approve -no-color >/dev/null
expect_empty_plan "after import"

step "destroy"
"$TF" destroy -input=false -auto-approve -no-color >/dev/null
[[ -z "$("$TF" state list)" ]] || { echo "resources left in the state" >&2; exit 1; }
echo "examples: ok (${#addresses[@]} resources)" >&2
