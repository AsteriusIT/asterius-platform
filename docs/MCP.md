# MCP server and OAuth 2.1

`POST /api/mcp` (also `/api/v1/mcp`) is a Streamable HTTP MCP server. Callers authenticate with either:

- an **API token** (`Authorization: Bearer ast_…`), unchanged; it fixes the organization;
- an **OIDC access token** (JWT) issued by a trusted authorization server (MCP authorization spec 2025-06-18). This is
  what remote clients such as Claude.ai and ChatGPT connectors use.

## How it works

- `GET /.well-known/oauth-protected-resource` (and `…/api/mcp`, `…/api/v1/mcp`) returns RFC 9728 metadata:
  `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]`, `scopes_supported`, `resource_documentation`.
- An unauthenticated call gets `401` with
  `WWW-Authenticate: Bearer realm="asterius-platform", resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/api/mcp"`.
  The client discovers the authorization server from it, registers (dynamic client registration) or uses its configured
  client, and runs the authorization-code flow with PKCE.
- The advertised authorization server is the Keycloak realm (`KEYCLOAK_URL` + `KEYCLOAK_REALM`), else `OIDC_ISSUER`, else
  the first of `MCP_OAUTH_ISSUERS`. All of them are trusted for incoming tokens.
- Access tokens are verified: signature (issuer JWKS), `iss`, `exp` and `aud`. The audience must contain the resource URL
  (`<PUBLIC_URL>/api/mcp` or `/api/v1/mcp`) or one of `MCP_OAUTH_AUDIENCES`.
- The token is mapped to an **existing** user, exactly as sign-in keys them: Keycloak `sub` (provider `keycloak`), or
  `issuer|sub` for OIDC. Unknown or disabled users are rejected: nothing is provisioned. People must have signed in once.
- Organization: the `X-Asterius-Org` header, else the first organization of the token's `organization` claim (Keycloak
  Organizations) the user belongs to, else their last organization.

## Configuration

| Key (Helm value) | Purpose |
| --- | --- |
| `MCP_OAUTH_ISSUERS` (`mcp.oauthIssuers`) | Extra trusted issuers (comma-separated), besides the Keycloak realm and `OIDC_ISSUER`. |
| `MCP_OAUTH_AUDIENCES` (`mcp.oauthAudiences`) | Accepted `aud` values besides the resource URL, e.g. the connector's client id. |
| `MCP_OAUTH_SCOPES` (`mcp.oauthScopes`) | Scopes advertised in the metadata (default `openid profile email`). |

`PUBLIC_URL` must be the externally reachable URL: it builds the resource identifier.

## Connecting Claude.ai or ChatGPT with Keycloak

1. In the Keycloak realm, create a client for the connector (or let the client register itself if you allow dynamic client
   registration). Use the standard flow with PKCE (public client, or confidential if the connector supports a secret) and
   add the connector's redirect URI:
   - **Claude** (claude.ai web, Desktop, mobile, Cowork): `https://claude.ai/api/mcp/auth_callback`, documented at
     claude.com/docs/connectors/building/authentication. Claude Code uses a loopback redirect on a random port
     (`http://localhost:<port>/callback`, `http://127.0.0.1:<port>/callback`): match it ignoring the port. Claude registers via
     DCR or a Client ID Metadata Document; it always sends PKCE S256 and needs the authorization server reachable from
     `160.79.104.0/21`.
   - **ChatGPT**: `https://chatgpt.com/connector_platform_oauth_redirect` (stable) or the callback-ID-specific
     `https://chatgpt.com/connector/oauth/{callback_id}`, per developers.openai.com/apps-sdk/build/auth; use the exact URI
     shown on the connector's management page. ChatGPT supports CIMD (`https://chatgpt.com/oauth/client.json`) and DCR.
   These values come from the vendors' documentation at the time of writing and can change: check the client's current
   documentation if sign-in fails with a redirect mismatch.
2. Add an **audience mapper** to that client (Client scopes -> `<client>-dedicated` -> Add mapper -> *Audience*): set
   *Included custom audience* to `https://<your-host>/api/mcp`, and enable *Add to access token*. Without it Keycloak issues
   tokens with `aud: account` and the platform refuses them. Alternatively add the client id to `MCP_OAUTH_AUDIENCES` and
   add an *Audience* mapper for that client id.
3. Optional: add the *Organization Membership* mapper (Keycloak 26) so the `organization` claim selects the organization.
4. In Claude.ai: Settings -> Connectors -> Add custom connector -> `https://<your-host>/api/mcp`. In ChatGPT: Settings ->
   Connectors -> create, MCP server URL `https://<your-host>/api/mcp`, authentication OAuth. Sign in with the Keycloak account
   you use on the platform.

Claude Code and scripts can keep using `--header "Authorization: Bearer ast_…"`.

## Tools

| Tool | What it does |
| --- | --- |
| `whoami` | The user, organization, role and teams, and the restrictions of the API token of the call (if any). |
| `list_blueprints`, `search_catalog`, `get_entity` | Read the catalog (blueprint read rules apply). |
| `get_scorecards` | Scorecard results of an entity (level, pass/fail per rule). |
| `get_entity_docs` | The Markdown of an entity's `docs` property, fetched through the SSRF guard. |
| `get_dora_insights` | DORA metrics over a window (`days`, `team`, `service`), from what the caller may read. |
| `list_initiatives` | Scorecard initiatives with their status and progress. |
| `list_actions`, `trigger_action` | List and start the self-service actions the caller may run. |
| `list_runs`, `get_run` | Follow runs. |
| `list_approvals` | What waits for the caller's decision. |

Every tool is read-only except `trigger_action`. There is no tool to approve, reject or answer an input step.

## Agents

The platform has no agent registry: an AI agent is an ordinary caller. **Use a service account with a
workflow-restricted token.**

1. *Admin → Users & service accounts → Service account* (`POST /api/v1/service-accounts`): a non-human member of the
   organization, with the role and teams that give it the catalog rights it needs (keep it a `member`).
2. Give its token a **`workflows`** allow-list (*Restrict to workflows* in the form; `workflows: [create-release, rollback]`
   in the API, also on `POST /api/v1/tokens` for a personal token):

```bash
curl -X POST https://platform.example.com/api/v1/service-accounts -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "name": "release-bot", "teams": ["platform"], "workflows": ["create-release", "rollback"] }'
```

A token with `workflows`:

- lists and starts only those workflows (`GET /api/v1/actions`, `POST /api/v1/actions/:id/runs`, `list_actions`,
  `trigger_action`), on top of what the workflow's own `allowed` rule grants its user;
- reads only the runs of those workflows (`GET /api/v1/runs`, `get_run`, `list_runs`, run charts);
- cannot approve, reject or answer an input step, whatever its user could decide;
- cannot create other tokens.

`workflows` narrows a token like its other restrictions do, and combines with them: `ipAllow` always applies, `scopes`
(`catalog:read`, `runs:trigger`…) and `blueprints` apply on the REST API, and the rights of the service account (role,
teams, blueprint permissions) bound everything. Absent or empty: no restriction. Revoke the token (or disable the
account) to stop the agent. As before, the MCP endpoint refuses a token restricted to `blueprints` and a token whose
`scopes` lack `admin`: for an MCP client, restrict the token with `workflows` and give the service account only the
role and teams it needs.

Per-agent OAuth clients, tool catalogs and identity brokering belong to your MCP / AI gateway; the portal restricts what
its own tokens may do.

**Audit.** Audit entries and runs record the **channel** of the call: `ui` (browser session), `api` (API token), `mcp`
(this endpoint), `workflow` (a tool call of an AI agent step). Filter with `GET /api/v1/audit?channel=mcp`,
`GET /api/v1/runs?channel=mcp`, *Admin → Audit log → Channel* (column *Via*) and the channel filter of the runs list; CSV /
NDJSON exports and the SIEM stream carry `channel`. The actor is the service account, so `?actor=` finds one agent. With
`AUDIT_HASH_CHAIN`, the hash (chain version 3) covers the channel.

## External MCP tools for AI agent steps

The platform has no MCP server registry either: **point a connection at your MCP gateway** (or at a single MCP server).
*Admin → Connections → New → MCP gateway or server* (built-in connector `mcp`, or `connections:` in the configuration
files):

```yaml
connections:
  - identifier: mcp-gateway
    title: MCP gateway
    connector: mcp
    fields: { baseUrl: https://mcp-gateway.example.com/mcp, timeoutSeconds: 30 } # the Streamable HTTP endpoint
    auth: { type: bearer, token: '${secret:mcp-gateway-token}' } # bearer, header (X-API-Key) or oauth2-client-credentials; references only
    access: read-write # MCP tools can change things
    allowed: { workflows: [triage-incident], teams: [] } # who may use it (empty: any workflow)
```

It is a connection like the others: credentials are secret references, `allowed` workflows / teams apply, changes are
audited, *Test* sends the MCP `initialize` request, and it cannot be deleted while a workflow uses it. The **platform** is
the MCP client: calls go through its SSRF guard (`OUTBOUND_ALLOW` / `OUTBOUND_DENY`), with the connection's timeout, no
redirects and no retries.

An AI agent step reaches it with the `mcp` tool, its connection and its own allow-list of tools:

```yaml
steps:
  - id: triage
    type: agent
    prompt: Find the open incident tickets of {{ entity.identifier }}
    tools: [catalog, mcp]
    mcp: { connection: mcp-gateway }
    guardrails:
      mcpTools: [search_issues, get_issue] # tool names as the gateway lists them: the only ones offered to the model
      maxWrites: 5 # every MCP call counts, and is audited (agent.mcp_call, target mcp-gateway/search_issues)
```

It fails closed. When the workflow is saved: `mcp` without `mcp.connection` or without `guardrails.mcpTools`, an unknown
connection, a connection of another connector, a read-only one or one that does not allow the workflow is rejected. When
the step runs, before the model is called: a connection the run may not use (its `allowed` workflows / teams, its access)
or an allow-listed tool the server does not offer fails the step. The model can call nothing outside
`guardrails.mcpTools`. Which tools exist, and what each agent may reach behind the gateway, is the gateway's business.

This differs from the step's `mcpServers` field, which hands remote servers to the Claude API (Anthropic provider only,
called from Anthropic's side, per-step URL and token).

## Manual verification

Not testable without live accounts; check once per environment: Claude.ai custom connector and ChatGPT connector sign-in
against your Keycloak (redirect URI accepted, `aud` mapper works, token refresh after expiry), tool listing and a
read-only tool call, and that a user without catalog access sees only permitted entities through the connector. For
agents: a service account token with `workflows` shows them in `whoami` and only those workflows in `list_actions`; a
connection to your real MCP gateway answers *Test* and an AI agent step lists and calls an allow-listed tool through it.
