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
   add the connector's redirect URI (Claude.ai: `https://claude.ai/api/mcp/auth_callback`; ChatGPT: the callback shown in
   its connector settings).
2. Add an **audience mapper** to that client (Client scopes -> `<client>-dedicated` -> Add mapper -> *Audience*): set
   *Included custom audience* to `https://<your-host>/api/mcp`, and enable *Add to access token*. Without it Keycloak issues
   tokens with `aud: account` and the platform refuses them. Alternatively add the client id to `MCP_OAUTH_AUDIENCES` and
   add an *Audience* mapper for that client id.
3. Optional: add the *Organization Membership* mapper (Keycloak 26) so the `organization` claim selects the organization.
4. In Claude.ai: Settings -> Connectors -> Add custom connector -> `https://<your-host>/api/mcp`. In ChatGPT: Settings ->
   Connectors -> create, MCP server URL `https://<your-host>/api/mcp`, authentication OAuth. Sign in with the Keycloak account
   you use on the platform.

Claude Code and scripts can keep using `--header "Authorization: Bearer ast_…"`.
