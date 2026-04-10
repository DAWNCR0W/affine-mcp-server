# Configuration and Deployment

This guide covers configuration precedence, environment variables, auth strategy, Docker, HTTP mode, and least-privilege deployment patterns.

## Configuration precedence

The server resolves configuration in this order:

1. Environment variables
2. Saved config file at `~/.config/affine-mcp/config`
3. Built-in defaults

Auth priority within the active configuration:

1. `AFFINE_API_TOKEN`
2. `AFFINE_COOKIE`
3. `AFFINE_EMAIL` and `AFFINE_PASSWORD`

## Environment variables

### Core configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AFFINE_BASE_URL` | Yes | None | Base URL for AFFiNE Cloud or self-hosted AFFiNE |
| `AFFINE_GRAPHQL_PATH` | No | `/graphql` | Override only if your AFFiNE deployment uses a custom GraphQL path |
| `AFFINE_WORKSPACE_ID` | No | Auto-detected when possible | Pins the active workspace |
| `AFFINE_LOGIN_AT_START` | No | async login behavior | Set to `sync` only when you must block startup on login |

### Authentication

| Variable | Use when | Notes |
| --- | --- | --- |
| `AFFINE_API_TOKEN` | Preferred for cloud and automation | Recommended default for stable operation |
| `AFFINE_COOKIE` | You must reuse browser-authenticated state | Copy only from a trusted local browser session |
| `AFFINE_EMAIL` | Self-hosted email/password sign-in | Must be paired with `AFFINE_PASSWORD` |
| `AFFINE_PASSWORD` | Self-hosted email/password sign-in | Avoid for automated public deployments |

### Tool filtering

| Variable | Purpose |
| --- | --- |
| `AFFINE_DISABLED_GROUPS` | Disable entire tool groups by comma-separated group name |
| `AFFINE_DISABLED_TOOLS` | Disable individual tools by exact canonical name |

### HTTP mode

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `MCP_TRANSPORT` | Yes for HTTP mode | stdio | Set to `http` |
| `PORT` | No | `3000` | Commonly injected by container platforms |
| `AFFINE_MCP_AUTH_MODE` | No | `bearer` | `bearer` or `oauth` |
| `AFFINE_MCP_HTTP_HOST` | No | platform default | Use `0.0.0.0` in containers |
| `AFFINE_MCP_HTTP_ALLOWED_ORIGINS` | No | none | Comma-separated list for browser clients |
| `AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS` | No | `false` | Testing only; rejected in OAuth mode |
| `AFFINE_MCP_HTTP_TOKEN` | Required in bearer mode | none | Shared bearer token for `/mcp`, `/sse`, and `/messages` |
| `AFFINE_MCP_PUBLIC_BASE_URL` | Required in OAuth mode | none | Public base URL for this MCP server |
| `AFFINE_OAUTH_ISSUER_URL` | Required in OAuth mode | none | OAuth issuer discovery URL |
| `AFFINE_OAUTH_SCOPES` | No | `mcp` | Scopes advertised for OAuth-protected access |

## Auth strategy matrix

| Environment | Recommended auth | Why |
| --- | --- | --- |
| AFFiNE Cloud + stdio | `AFFINE_API_TOKEN` or saved config from `affine-mcp login` | Cloud sign-in is blocked by Cloudflare |
| AFFiNE Cloud + HTTP | `AFFINE_API_TOKEN` + bearer or OAuth at the MCP layer | Stable and automation-friendly |
| Self-hosted + stdio | API token first, email/password second | Token reduces startup and sign-in failure modes |
| Self-hosted + HTTP | API token first, cookie or email/password only if necessary | Better for unattended deployments |

Important note for AFFiNE Cloud:

- Programmatic email/password sign-in to `/api/auth/sign-in` is not supported because Cloudflare blocks those requests

## Docker

Prebuilt images are published to GHCR:

- `ghcr.io/dawncr0w/affine-mcp-server:latest`
- `ghcr.io/dawncr0w/affine-mcp-server:1.12.0`

Example:

```bash
docker run -d \
  -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e AFFINE_BASE_URL=https://your-affine-instance.com \
  -e AFFINE_API_TOKEN=ut_your_token \
  -e AFFINE_MCP_AUTH_MODE=bearer \
  -e AFFINE_MCP_HTTP_TOKEN=your-strong-secret \
  ghcr.io/dawncr0w/affine-mcp-server:latest
```

Health endpoints:

- `/healthz`
- `/readyz`

## HTTP mode

HTTP mode exposes:

- `/mcp` - Streamable HTTP MCP endpoint
- `/sse` - SSE endpoint for older-compatible clients
- `/messages` - message endpoint for older-compatible clients
- `/healthz` - liveness probe
- `/readyz` - readiness probe

### Bearer mode

```bash
export MCP_TRANSPORT=http
export AFFINE_MCP_AUTH_MODE=bearer
export AFFINE_BASE_URL="https://app.affine.pro"
export AFFINE_API_TOKEN="ut_xxx"
export AFFINE_MCP_HTTP_HOST="0.0.0.0"
export AFFINE_MCP_HTTP_TOKEN="your-super-secret-token"
export PORT=3000

npm run start:http
```

Use bearer mode when:

- the client can inject a shared secret header
- you want the simplest remote deployment
- you do not need OAuth discovery and token validation

### OAuth mode

```bash
export MCP_TRANSPORT=http
export AFFINE_MCP_AUTH_MODE=oauth
export AFFINE_BASE_URL="https://app.affine.pro"
export AFFINE_API_TOKEN="your-affine-service-token"
export AFFINE_MCP_HTTP_HOST="0.0.0.0"
export AFFINE_MCP_PUBLIC_BASE_URL="https://mcp.yourdomain.com"
export AFFINE_OAUTH_ISSUER_URL="https://auth.yourdomain.com"
export AFFINE_OAUTH_SCOPES="mcp"
export PORT=3000

npm run start:http
```

OAuth mode behavior:

- exposes `/.well-known/oauth-protected-resource`
- returns `401` + `WWW-Authenticate` challenge for unauthenticated `/mcp` requests
- disables `AFFINE_MCP_HTTP_TOKEN` and `?token=`
- does not register `sign_in`
- still requires `AFFINE_API_TOKEN` so the server can call AFFiNE

## Least-privilege tool exposure

### Disable whole groups

Example:

```json
{
  "AFFINE_DISABLED_GROUPS": "comments,history,blobs,users"
}
```

Current group names:

- `workspaces`
- `docs`
- `comments`
- `history`
- `organize`
- `users`
- `access_tokens`
- `blobs`
- `notifications`

### Disable specific tools

Example:

```json
{
  "AFFINE_DISABLED_TOOLS": "delete_workspace,delete_doc"
}
```

Use tool-level filtering when you want a mostly complete tool surface but need to remove destructive operations.

## Deployment checklist

Before exposing the server remotely, confirm:

- `AFFINE_BASE_URL` is reachable from the MCP host
- `AFFINE_API_TOKEN` works through `affine-mcp status` or an equivalent health path
- `MCP_TRANSPORT=http` is set
- `AFFINE_MCP_AUTH_MODE` is correct for your client model
- `AFFINE_MCP_HTTP_HOST=0.0.0.0` is set in containerized deployments
- `AFFINE_MCP_HTTP_ALLOWED_ORIGINS` is set for browser-based clients
- `/healthz` and `/readyz` are wired into your platform checks
- destructive tools are filtered if your deployment should be read-only or constrained

## Troubleshooting pointers

- Cloudflare / sign-in failures: switch to an API token
- Startup timeouts: avoid `AFFINE_LOGIN_AT_START=sync` unless required
- Missing tools: confirm filtering variables are not removing them
- Browser CORS failures: verify `AFFINE_MCP_HTTP_ALLOWED_ORIGINS`
- OAuth failures: verify issuer discovery metadata and JWKS availability
