# Configuration and Deployment

This guide covers configuration precedence, environment variables, auth strategy, Docker, HTTP mode, and least-privilege deployment patterns.

## Configuration precedence

The server resolves configuration in this order:

1. Environment variables
2. Saved config file at `$XDG_CONFIG_HOME/affine-mcp/config` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/affine-mcp/config`
3. Built-in defaults

The saved config file uses the same `KEY=value` names shown below. Environment variables always override saved values, and the CLI diagnostics report the source selected for each runtime option.

Auth priority within the active configuration:

1. `AFFINE_API_TOKEN`
2. `AFFINE_COOKIE`
3. `AFFINE_EMAIL` and `AFFINE_PASSWORD`

Email/password authentication is process-scoped. Concurrent HTTP MCP sessions
share one sign-in attempt and the resulting cookie. In the default `async`
mode, transport startup is not blocked, but the first backend operation waits
for authentication to finish. A failed login is returned to every waiting
operation and is never retried as an unauthenticated request.

Bearer and cookie credentials are mutually exclusive on outbound requests.
Explicit `sign_in` replaces the current client credential with its session
cookie, while setting a bearer credential removes any cookie header.

## Environment variables

### Core configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AFFINE_BASE_URL` | No | `http://localhost:3010` | Base URL for AFFiNE Cloud or self-hosted AFFiNE; remote destinations must use HTTPS |
| `AFFINE_ALLOW_INSECURE_HTTP` | No | `false` | Explicitly allow a remote plain-HTTP AFFiNE URL on a trusted private network only |
| `AFFINE_GRAPHQL_PATH` | No | `/graphql` | Override only if your AFFiNE deployment uses a custom GraphQL path |
| `AFFINE_HEADERS_JSON` | No | none | JSON object of additional string headers sent to AFFiNE; built-in token/cookie auth takes priority |
| `AFFINE_WORKSPACE_ID` | No | Auto-detected when possible | Pins the active workspace |
| `AFFINE_LOGIN_AT_START` | No | `async` | `async` starts one shared login without blocking transport startup; `sync` requires login before startup |
| `XDG_CONFIG_HOME` | No | `~/.config` | Changes the parent directory used for the saved `affine-mcp/config` file |

### Blob upload safeguards

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AFFINE_BLOB_UPLOAD_MAX_BYTES` | No | `26214400` (25 MiB) | Maximum decoded payload size accepted by `upload_blob` |
| `AFFINE_BLOB_UPLOAD_TIMEOUT_MS` | No | `30000` | Maximum time allowed for the multipart upload request |
| `AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES` | No | `1048576` (1 MiB) | Maximum AFFiNE response body size read after an upload |

`upload_blob` treats content as UTF-8 by default and preserves it exactly, including leading and trailing whitespace. Binary callers must pass `encoding: "base64"`; Base64 input is validated for canonical padding before it is decoded. ASCII whitespace inside explicit Base64 input is ignored.

### Authentication

| Variable | Use when | Notes |
| --- | --- | --- |
| `AFFINE_COOKIE` | Current AFFiNE Cloud with the full server toolset | Use `affine-mcp login`; treat it as a password-equivalent secret |
| `AFFINE_API_TOKEN` | Your instance has already issued a legacy GraphQL access token | `aff_mcp_v1` credentials are not GraphQL tokens and are rejected |
| `AFFINE_EMAIL` | Self-hosted email/password sign-in | Must be paired with `AFFINE_PASSWORD` |
| `AFFINE_PASSWORD` | Self-hosted email/password sign-in | Avoid for automated public deployments |

### Tool filtering

| Variable | Purpose |
| --- | --- |
| `AFFINE_TOOL_PROFILE` | Environment-only predefined tool surface profile (`full`, `read_only`, `core`, `authoring`) |
| `AFFINE_DISABLED_GROUPS` | Environment-only comma-separated tool groups to disable |
| `AFFINE_DISABLED_TOOLS` | Environment-only exact canonical tool names to disable |

### HTTP mode

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `MCP_TRANSPORT` | No | `stdio` | Set to `http`; `streamable` and legacy `sse` are accepted aliases |
| `PORT` | No | `3000` | Commonly injected by container platforms |
| `AFFINE_MCP_AUTH_MODE` | No | `bearer` | `bearer` or `oauth` |
| `AFFINE_MCP_HTTP_HOST` | No | `127.0.0.1` | Use `0.0.0.0` in containers; non-loopback bearer listeners require authentication |
| `AFFINE_MCP_HTTP_ALLOWED_ORIGINS` | No | none | Comma-separated list for browser clients |
| `AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS` | No | `false` | Testing only; rejected in OAuth mode |
| `AFFINE_MCP_HTTP_TOKEN` | Required for non-loopback bearer mode | none | Shared bearer token for `/mcp`, `/sse`, and `/messages` |
| `AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED` | No | `false` | Unsafe opt-in for an unauthenticated non-loopback bearer-mode listener |
| `AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN` | No | `false` | Deprecated compatibility mode for `?token=` clients; prefer the `Authorization` header |
| `AFFINE_MCP_HTTP_BODY_LIMIT` | No | `4mb` | Maximum JSON request body size; accepts bytes, `kb`, or `mb` from `1kb` through `64mb` |
| `AFFINE_MCP_HTTP_MAX_SESSIONS` | No | `32` | Maximum combined Streamable HTTP and legacy SSE sessions |
| `AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS` | No | `1800000` | Close sessions that receive no MCP activity for this duration |
| `AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS` | No | `10000` | Deadline before remaining HTTP connections are forcibly closed |
| `AFFINE_MCP_PUBLIC_BASE_URL` | Required in OAuth mode | none | Public base URL for this MCP server |
| `AFFINE_OAUTH_ISSUER_URL` | Required in OAuth mode | none | OAuth issuer discovery URL |
| `AFFINE_OAUTH_SCOPES` | No | `mcp` | Scopes advertised for OAuth-protected access |
| `AFFINE_OAUTH_CLOCK_SKEW_SECONDS` | No | `60` | Positive integer tolerance for OAuth token timestamps |
| `AFFINE_OAUTH_ALLOW_SERVICE_WRITES` | No | `false` | Explicitly acknowledge write-capable tools using the shared AFFiNE service identity |

### WebSocket compatibility

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AFFINE_WS_CLIENT_VERSION` | No | `0.26.0` | Environment-only AFFiNE client version sent during workspace socket connection |
| `AFFINE_WS_CONNECT_TIMEOUT_MS` | No | `10000` | Environment-only milliseconds to wait for a workspace socket connection |
| `AFFINE_WS_ACK_TIMEOUT_MS` | No | `10000` | Environment-only milliseconds to wait for a workspace socket acknowledgement |

## Auth strategy matrix

| Environment | Recommended auth | Why |
| --- | --- | --- |
| AFFiNE Cloud + stdio | Saved browser session from `affine-mcp login` | Enables the full GraphQL/WebSocket-backed toolset despite Cloudflare blocking programmatic sign-in |
| AFFiNE Cloud + bearer HTTP | `AFFINE_COOKIE` for AFFiNE plus `AFFINE_MCP_HTTP_TOKEN` for MCP clients | Works today, but requires secure session rotation |
| AFFiNE Cloud + OAuth HTTP | Existing legacy GraphQL service token | OAuth mode currently requires a non-cookie AFFiNE service credential; `aff_mcp_v1` is incompatible |
| Self-hosted + stdio | Email/password session or browser cookie; legacy GraphQL token if available | Use the credential type the instance supports |
| Self-hosted + HTTP | Dedicated-account cookie or legacy GraphQL service token | Avoid personal account credentials for unattended deployments |

Important note for AFFiNE Cloud:

- Programmatic email/password sign-in to `/api/auth/sign-in` is not supported because Cloudflare blocks those requests
- Current `aff_mcp_v1.<id>.<secret>` values authorize AFFiNE's native workspace MCP endpoint only; they cannot authenticate this server's GraphQL or WebSocket calls

## Docker

Prebuilt images are published to GHCR:

- `ghcr.io/dawncr0w/affine-mcp-server:latest`
- `ghcr.io/dawncr0w/affine-mcp-server:2.5.0`

Example:

```bash
docker run -d \
  -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e AFFINE_BASE_URL=https://app.affine.pro \
  -e 'AFFINE_COOKIE=affine_session=your-session-id' \
  -e AFFINE_MCP_AUTH_MODE=bearer \
  -e AFFINE_MCP_HTTP_TOKEN=your-strong-secret \
  ghcr.io/dawncr0w/affine-mcp-server:latest
```

Health endpoints:

- `/healthz`
- `/readyz`

## HTTP mode

HTTP mode exposes:

- `/mcp` - Streamable HTTP MCP endpoint protected by the configured MCP auth mode
- `/sse` - SSE endpoint for older-compatible clients protected by the configured MCP auth mode
- `/messages` - message endpoint for older-compatible clients protected by the configured MCP auth mode
- `/healthz` - unauthenticated process liveness probe for trusted platform checks
- `/readyz` - unauthenticated readiness probe that checks OAuth discovery when enabled and the exact configured AFFiNE GraphQL endpoint

`/readyz` returns `503` with the failing component when the configured AFFiNE GraphQL endpoint is unavailable. Keep both diagnostic routes private to your load balancer or trusted monitoring network.

### Runtime limits and shutdown

The HTTP transport limits JSON request bodies and the number of active sessions
to prevent accidental resource exhaustion. Both Streamable HTTP and legacy SSE
sessions count toward `AFFINE_MCP_HTTP_MAX_SESSIONS`. New sessions receive a
`503` response with `Retry-After` when the limit is reached. Existing session
traffic refreshes its idle deadline, and inactive sessions are closed after
`AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS`.

On `SIGINT` or `SIGTERM`, the server stops accepting connections and closes MCP
transports concurrently. If a connection prevents graceful shutdown beyond
`AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS`, the remaining HTTP connections are
forcibly closed. Invalid runtime limit values and listen errors fail startup
instead of leaving a partially running process.

### Bearer mode

```bash
export MCP_TRANSPORT=http
export AFFINE_MCP_AUTH_MODE=bearer
export AFFINE_BASE_URL="https://app.affine.pro"
export AFFINE_COOKIE="affine_session=your-session-id"
export AFFINE_MCP_HTTP_HOST="0.0.0.0"
export AFFINE_MCP_HTTP_TOKEN="your-super-secret-token"
export PORT=3000

npm run start:http
```

Use bearer mode when:

- the client can inject a shared secret header
- you want the simplest remote deployment
- you do not need OAuth discovery and token validation

Bearer tokens must be sent with `Authorization: Bearer <token>`. Query-string
tokens are rejected by default because URLs can be retained in access logs,
browser history, and monitoring systems. Legacy clients can temporarily opt in
with `AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN=true`, but this mode is deprecated.

In bearer mode, a non-loopback listener such as `0.0.0.0`, `::`, a LAN address,
or a hostname requires `AFFINE_MCP_HTTP_TOKEN`. Startup fails when the token is
missing. `AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit unsafe
escape hatch for isolated private networks and must not be used on an
internet-reachable listener. Loopback listeners remain available without MCP
authentication for local development.

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
- cannot use `AFFINE_COOKIE` as that service credential in the current OAuth implementation
- cannot use an `aff_mcp_v1` credential because it does not authenticate AFFiNE GraphQL/WebSocket APIs
- authenticates callers at the MCP boundary but does not delegate their identity to AFFiNE; every request uses the same `AFFINE_API_TOKEN` service identity
- defaults `AFFINE_TOOL_PROFILE` to `read_only` when no profile is configured
- refuses any write-capable tool surface unless `AFFINE_OAUTH_ALLOW_SERVICE_WRITES=true` is also set

To allow service-account writes, configure both controls explicitly:

```bash
export AFFINE_TOOL_PROFILE="authoring"
export AFFINE_OAUTH_ALLOW_SERVICE_WRITES="true"
```

This grants every OAuth caller accepted by the configured issuer the same AFFiNE mutation permissions. Use separate deployments or backend credentials when callers require different AFFiNE authorization boundaries.

## Least-privilege tool exposure

### Use a tool profile

Profiles are the easiest way to reduce the MCP tool surface without listing every tool by name.

Example:

```json
{
  "AFFINE_TOOL_PROFILE": "core"
}
```

Available profiles:

- `full`: expose the complete public tool surface; this is the default outside OAuth mode
- `read_only`: expose discovery, reading, export, fidelity, and inspection tools, plus `sign_in`
- `core`: expose the compact everyday surface for workspace/doc discovery, basic document authoring, tags, and database row/schema edits; omits admin tools, cleanup tools, experimental organize tools, and destructive tools
- `authoring`: expose non-destructive creation and editing tools, including semantic pages, native templates, database composition, and edgeless canvas authoring; omits admin, cleanup, destructive, and experimental organize tools

Profile, group, and tool names are validated at startup. An unknown value stops the server instead of falling back to a broader tool surface. This prevents a configuration typo from silently enabling tools that an operator intended to hide.

### Disable whole groups

Example:

```json
{
  "AFFINE_DISABLED_GROUPS": "comments,history,blobs,users"
}
```

Current group names:

- `workspaces`
- `workspaces.read`
- `workspaces.write`
- `docs`
- `docs.read`
- `docs.write`
- `docs.markdown`
- `docs.tags`
- `docs.tree`
- `docs.export`
- `docs.semantic`
- `docs.template`
- `docs.database`
- `docs.edgeless`
- `docs.surface`
- `docs.intent`
- `docs.share`
- `comments`
- `comments.read`
- `comments.write`
- `history`
- `history.read`
- `organize`
- `organize.read`
- `organize.write`
- `organize.collections`
- `organize.folders`
- `users`
- `users.read`
- `users.write`
- `users.auth`
- `access_tokens`
- `access_tokens.read`
- `access_tokens.write`
- `blobs`
- `blobs.write`
- `notifications`
- `notifications.read`
- `notifications.write`
- `admin`
- `auth`
- `cleanup`
- `destructive`
- `experimental`
- `read`
- `write`

### Disable specific tools

Example:

```json
{
  "AFFINE_DISABLED_TOOLS": "delete_workspace,delete_doc"
}
```

Use tool-level filtering when you want a mostly complete tool surface but need to remove specific operations such as destructive actions or administrative access-token tools.

Every registered tool must also be present in the canonical tool surface and `tool-manifest.json`. The server refuses to start when a tool is registered without that metadata, including when the `full` profile is selected.

## Deployment checklist

Before exposing the server remotely, confirm:

- `AFFINE_BASE_URL` is reachable from the MCP host
- the configured `AFFINE_COOKIE` or legacy `AFFINE_API_TOKEN` works through `affine-mcp status` or an equivalent health path
- `MCP_TRANSPORT=http` is set
- `AFFINE_MCP_AUTH_MODE` is correct for your client model
- `AFFINE_MCP_HTTP_HOST=0.0.0.0` is set in containerized deployments
- HTTPS or TLS termination is in front of any non-local HTTP deployment
- bearer mode uses a long random `AFFINE_MCP_HTTP_TOKEN`, or OAuth is configured for multi-user access
- clients send bearer credentials in the `Authorization` header rather than the URL
- `AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED` and `AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN` are not enabled
- `AFFINE_MCP_HTTP_ALLOWED_ORIGINS` is set for browser-based clients
- `AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS` is not enabled outside local testing
- `/healthz` and `/readyz` are wired into your platform checks
- destructive tools are filtered if your deployment should be read-only or constrained

## Troubleshooting pointers

- Cloudflare / sign-in failures: run `affine-mcp login` and choose browser session login
- `aff_mcp_v1` rejection: use a browser session for this server, or point the credential directly at AFFiNE's smaller native workspace MCP endpoint instead
- Startup timeouts: avoid `AFFINE_LOGIN_AT_START=sync` unless required
- Missing tools: confirm filtering variables are not removing them
- Browser CORS failures: verify `AFFINE_MCP_HTTP_ALLOWED_ORIGINS`
- OAuth failures: verify issuer discovery metadata and JWKS availability
- Custom GraphQL deployments: run `affine-mcp show-config --json` and confirm `graphqlEndpoint`, then run `affine-mcp doctor --json`
- `doctor` also rejects an unprotected non-loopback HTTP bind and validates OAuth transport, discovery metadata, and JWKS reachability
- Invalid transport, port, origin, or boolean values now fail at startup instead of silently falling back
- Remote plain-HTTP AFFiNE URL rejected: use HTTPS, or set `AFFINE_ALLOW_INSECURE_HTTP=true` only for a trusted private network
- Non-loopback bearer listener rejected: set `AFFINE_MCP_HTTP_TOKEN` or configure OAuth
