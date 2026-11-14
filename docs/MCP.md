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
| `whoami` | The user, organization, role, teams and the agent acted as (if any). |
| `list_blueprints`, `search_catalog`, `get_entity` | Read the catalog (blueprint read rules apply). |
| `get_scorecards` | Scorecard results of an entity (level, pass/fail per rule). |
| `get_entity_docs` | The Markdown of an entity's `docs` property, fetched through the SSRF guard. |
| `get_dora_insights` | DORA metrics over a window (`days`, `team`, `service`), from what the caller may read. |
| `list_actions`, `trigger_action` | List and start the self-service actions the caller may run. |
| `list_runs`, `get_run` | Follow runs. |
| `list_approvals` | What waits for the caller's decision (people only: not offered to agents). |

Every tool is read-only except `trigger_action`. There is no tool to approve, reject or answer an input step.

## Agents

An **agent** is a registered, non-human principal of an organization (*Admin → Governance → Agents*, `PUT /api/v1/agents/:id`,
or `agents:` in the configuration files):

```yaml
agents:
  - identifier: release-bot
    title: Release bot
    ownerTeam: platform # its members (and the admins) issue its tokens and may act as it
    workflows: [create-release, rollback] # the only actions it sees, starts and whose runs it reads
    blueprints: [service, deployment] # the only blueprints it reads; ['*']: everything its user may read
    oauthClients: [claude-connector] # OAuth clients (azp / client_id) that are this agent
    enabled: true
```

An agent has no rights of its own: it acts through a user and **its permissions are the intersection of its allow-lists
and that user's rights**. It never uses administrator bypasses (an agent of an admin gets what the blueprint and
workflow rules grant), never approves, rejects or answers input steps, and on the REST API only reads the catalog and runs
and starts runs (`POST /api/v1/actions/:id/runs`); everything else is a 403. Disabling or deleting the agent stops its
tokens at once (deleting revokes them).

How a caller is identified as an agent, in order:

1. **An API token bound to the agent.** Issue it from *Agents → Tokens* or `POST /api/v1/agents/:id/tokens` (admins and
   owner-team members, from a signed-in session). The token acts as the person who issued it, or for admins as a service
   account (`userId`), narrowed by the agent. Use it as usual: `Authorization: Bearer ast_…`.
2. **An OAuth MCP client registered for the agent.** When the access token's `azp` (or `client_id`) claim is listed in an
   agent's `oauthClients`, every call of that client is that agent, whoever signs in. Register one client per agent in
   Keycloak (or your authorization server) for this.
3. **Self-selection on the MCP endpoint.** A person (session, personal token or OAuth token) adds
   `X-Asterius-Agent: <agent>` (or `?agent=<agent>` to the MCP URL, for clients that cannot set headers) to act as an agent
   they may use (admins and owner-team members). It can only narrow their rights; a credential bound to an agent cannot
   claim another one.

**Audit.** Audit entries and runs record the channel of the call (`ui` browser session, `api` API token, `mcp` MCP
endpoint, `workflow` AI agent step) and the agent: filter with `GET /api/v1/audit?agent=<id>` (`*`: any agent, `-`: none)
and `&channel=mcp`, `GET /api/v1/runs?agent=<id>`, or *Admin → Audit log → AI agent* and the agent's row actions. With
`AUDIT_HASH_CHAIN`, the hash (chain version 3) covers the channel and the agent.

## External MCP servers for AI agent steps

*Admin → Governance → MCP servers* (`PUT /api/v1/mcp-servers/:id`, or `mcpServers:` in the configuration files) registers
external MCP servers (Streamable HTTP). The **platform** is the client: calls go through its SSRF guard (`OUTBOUND_ALLOW` /
`OUTBOUND_DENY`), with the server's timeout, no redirects and no retries.

```yaml
mcpServers:
  - identifier: tickets
    title: Ticketing
    url: https://mcp.tickets.example.com/mcp
    auth: { type: bearer, token: '${secret:tickets-mcp-token}' } # bearer, header, basic or oauth2-client-credentials; references only
    tools: [search_issues, get_issue] # the only tools agent steps may call (at least one)
    timeoutSeconds: 30
```

An AI agent step uses them with the `mcp` tool and its own allow-list:

```yaml
steps:
  - id: triage
    type: agent
    prompt: Find the open incident tickets of {{ entity.identifier }}
    tools: [catalog, mcp]
    guardrails:
      mcpTools: [tickets/search_issues] # server/tool
      maxWrites: 5 # every MCP call counts, and is audited (agent.mcp_call)
```

Both allow-lists fail closed: `mcp` without `guardrails.mcpTools` is rejected when the workflow is saved; an unknown or
disabled server, or a tool the server's `tools` does not allow, fails the step before the model is called; a tool the
server does not offer is left out; the model can call nothing else. *Test* (`POST /api/v1/mcp-servers/:id/test`) connects,
lists the server's tools and shows which ones the allow-list lets through, without calling any.

This differs from the step's `mcpServers` field, which hands remote servers to the Claude API (Anthropic provider only,
called from Anthropic's side, per-step URL and token).

## Manual verification

Not testable without live accounts; check once per environment: Claude.ai custom connector and ChatGPT connector sign-in
against your Keycloak (redirect URI accepted, `aud` mapper works, token refresh after expiry), tool listing and a
read-only tool call, and that a user without catalog access sees only permitted entities through the connector. For
agents: a connector whose OAuth client is listed in an agent's `oauthClients` shows `agent` in `whoami` and only the
agent's workflows in `list_actions`; an external MCP server of a real vendor answers *Test* with its tool list.
