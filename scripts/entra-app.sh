#!/usr/bin/env bash
# Create (or update) the Entra ID app registration used for Asterius Platform SSO, and write its settings to .env.
#
#   scripts/entra-app.sh                                   # local dev: http://localhost:5173
#   PUBLIC_URL=https://platform.example.com scripts/entra-app.sh   # add a production redirect URI
#
# Idempotent: re-running adds missing redirect URIs and keeps the existing client secret,
# unless ROTATE_SECRET=1 (a new 1-year secret is created and written to the env file).
#
# Variables: APP_NAME ("Asterius Platform"), PUBLIC_URL (http://localhost:5173), ENV_FILE (.env),
#            ROTATE_SECRET (0), ASSIGNMENT_REQUIRED (0 — set 1 to allow only users/groups assigned to the app)
set -euo pipefail

APP_NAME="${APP_NAME:-Asterius Platform}"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:5173}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
REDIRECT_URI="${PUBLIC_URL%/}/api/auth/entra/callback"
GRAPH=00000003-0000-0000-c000-000000000000
# Delegated Microsoft Graph scopes: openid, profile, email, User.Read
SCOPES="37f7f235-527c-4136-accd-4a02d197296e=Scope 14dad69e-099b-42c9-810b-d002981feec1=Scope 64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0=Scope e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope"

command -v az >/dev/null || { echo "✗ Azure CLI is required" >&2; exit 1; }
TENANT_ID="$(az account show --query tenantId -o tsv)"
echo "→ tenant $(az account show --query tenantDisplayName -o tsv) ($TENANT_ID)"

APP_ID="$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)"
if [ -z "$APP_ID" ]; then
  echo "→ creating app registration \"$APP_NAME\""
  APP_ID="$(az ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "$REDIRECT_URI" --web-home-page-url "$PUBLIC_URL" --query appId -o tsv)"
  NEW_APP=1
else
  echo "✓ app registration exists ($APP_ID)"
  CURRENT="$(az ad app show --id "$APP_ID" --query "web.redirectUris" -o tsv)"
  if ! grep -qxF "$REDIRECT_URI" <<<"$CURRENT"; then
    echo "→ adding redirect URI $REDIRECT_URI"
    # shellcheck disable=SC2086
    az ad app update --id "$APP_ID" --web-redirect-uris $CURRENT "$REDIRECT_URI"
  fi
  NEW_APP=0
fi

# Security-group object ids in the ID token: map Entra groups to platform teams and to the admin role.
az ad app update --id "$APP_ID" --set groupMembershipClaims=SecurityGroup >/dev/null

# Service principal (enterprise application) in the tenant.
az ad sp show --id "$APP_ID" >/dev/null 2>&1 || { echo "→ creating service principal"; az ad sp create --id "$APP_ID" >/dev/null; }

if [ "$NEW_APP" = 1 ]; then
  echo "→ requesting Graph permissions: openid profile email User.Read"
  # shellcheck disable=SC2086
  az ad app permission add --id "$APP_ID" --api "$GRAPH" --api-permissions $SCOPES >/dev/null 2>&1 || true
  # Admin consent avoids a consent prompt per user; it needs an admin role and is optional.
  if az ad app permission admin-consent --id "$APP_ID" >/dev/null 2>&1; then echo "✓ admin consent granted"
  else echo "• admin consent not granted (needs an admin) — users will be asked to consent on first sign-in"; fi
fi

# Optional, needs a tenant admin: GroupMember.Read.All (application) lets the platform resolve group overage (>200
# groups) at sign-in and re-sync roles/teams of signed-in users (ENTRA_RESYNC_MINUTES). Without it, users with
# more than 200 groups cannot sign in (the platform fails closed instead of treating them as group-less).
echo "• for group overage / periodic re-sync grant the application permission GroupMember.Read.All (Graph) with admin consent"

if [ "${ASSIGNMENT_REQUIRED:-0}" = 1 ]; then
  az ad sp update --id "$APP_ID" --set appRoleAssignmentRequired=true >/dev/null
  echo "✓ only users/groups assigned to the enterprise application can sign in"
fi

set_env() { # set_env KEY VALUE — replace or append, without printing the value
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import sys, re, os
path, key, value = sys.argv[1:4]
lines = open(path).read().splitlines() if os.path.exists(path) else []
pat = re.compile(rf'^\s*#?\s*{re.escape(key)}=')
out, done = [], False
for l in lines:
    if pat.match(l) and not done:
        out.append(f'{key}={value}'); done = True
    elif pat.match(l) and l.lstrip().startswith('#'):
        continue
    else:
        out.append(l)
if not done: out.append(f'{key}={value}')
open(path, 'w').write('\n'.join(out) + '\n')
PY
}

touch "$ENV_FILE"
if [ "$NEW_APP" = 1 ] || [ "${ROTATE_SECRET:-0}" = 1 ] || ! grep -qE '^ENTRA_CLIENT_SECRET=.+' "$ENV_FILE"; then
  echo "→ creating a client secret (valid 1 year)"
  SECRET="$(az ad app credential reset --id "$APP_ID" --display-name "asterius-platform-$(date +%Y%m%d)" --years 1 --append --query password -o tsv 2>/dev/null)"
  set_env ENTRA_CLIENT_SECRET "$SECRET"
  unset SECRET
fi
set_env AUTH_PROVIDERS "entra"
set_env ENTRA_TENANT_ID "$TENANT_ID"
set_env ENTRA_CLIENT_ID "$APP_ID"
grep -qE '^PUBLIC_URL=.+' "$ENV_FILE" || set_env PUBLIC_URL "$PUBLIC_URL"
chmod 600 "$ENV_FILE"

echo "✓ done — $ENV_FILE now has AUTH_PROVIDERS, ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET"
echo "  Redirect URI: $REDIRECT_URI"
echo "  Portal: https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/$APP_ID"
