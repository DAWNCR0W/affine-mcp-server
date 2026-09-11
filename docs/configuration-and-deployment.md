# Configuration and Deployment

This guide covers configuration precedence, environment variables, auth strategy, Docker, HTTP mode, and least-privilege deployment patterns.

## Configuration precedence

The server resolves configuration in this order:

1. Environment variables
2. Saved config file at `$XDG_CONFIG_HOME/affine-mcp/config` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/affine-mcp/config`
3. Built-in defaults

The saved config file uses the same `KEY=value` names shown below. Environment variables always override saved values, and the CLI diagnostics report the source selected for each runtime option.

Authentication credentials are resolved as one source-scoped group. If the
environment provides any of `AFFINE_API_TOKEN`, `AFFINE_COOKIE`,
`AFFINE_EMAIL`, or `AFFINE_PASSWORD`, saved authentication credentials are not
mixed into that environment configuration. An `Authorization` or `Cookie`
entry in an environment-provided `AFFINE_HEADERS_JSON` also selects the
environment authentication group. Non-authentication headers from saved
configuration remain available when no environment `AFFINE_HEADERS_JSON`
replaces them.

Auth priority within the active configuration:

1. `AFFINE_API_TOKEN`
2. `AFFINE_COOKIE`
3. A Bearer `Authorization` header in `AFFINE_HEADERS_JSON`
4. A `Cookie` header in `AFFINE_HEADERS_JSON`
5. `AFFINE_EMAIL` and `AFFINE_PASSWORD`

This priority is applied only within the selected environment or saved-config
group. For example, environment email/password credentials take precedence
over an older saved API token or session cookie.

Header names are case-insensitive. The MCP runtime, `status`, `doctor`, and `show-config` use the same resolution, including header-only credentials. Diagnostic output redacts credential values.

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
| `AFFINE_CLIENT_VERSION` | No | `0.26.0` | AFFiNE web-client version sent as the `x-affine-version` header on GraphQL/REST requests. Servers that gate on client version reject sign-in with `403 UNSUPPORTED_CLIENT_VERSION` when it is too low; raise this if your deployment pins a higher minimum. Also used as the fallback default for `AFFINE_WS_CLIENT_VERSION` |
| `XDG_CONFIG_HOME` | No | `~/.config` | Changes the parent directory used for the saved `affine-mcp/config` file |

### Blob upload safeguards

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AFFINE_BLOB_UPLOAD_MAX_BYTES` | No | `26214400` (25 MiB) | Maximum decoded payload size accepted by `upload_blob` |
| `AFFINE_BLOB_UPLOAD_TIMEOUT_MS` | No | `30000` | Maximum time allowed for the multipart upload request |
| `AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES` | No | `1048576` (1 MiB) | Maximum AFFiNE response body size read after an upload |

`upload_blob` treats content as UTF-8 by default and preserves it exactly, including leading and trailing whitespace. Binary callers must pass `encoding: "base64"`; Base64 input is validated for canonical padding before it is decoded. ASCII whitespace inside explicit Base64 input is ignored.

### Upstream response safeguards

GraphQL, sign-in, workspace creation, and readiness requests keep their timeout
active until the complete response body is consumed. Non-upload response bodies
are limited to 16 MiB. `upload_blob` uses the separately configurable timeout
and response limit above.

### Authentication

| Variable | Use when | Notes |
| --- | --- | --- |
| `AFFINE_API_TOKEN` | A legacy or compatible AFFiNE deployment accepts GraphQL bearer tokens | AFFiNE 0.27+ removed the legacy personal-access-token API; this server cannot generate one |
| `AFFINE_COOKIE` | Reuse browser-authenticated state, including AFFiNE Cloud | Copy the complete Cookie request header only from a trusted local browser session |
| `AFFINE_EMAIL` | Self-hosted email/password sign-in | Recommended for current self-hosted AFFiNE; must be paired with `AFFINE_PASSWORD` |
| `AFFINE_PASSWORD` | Self-hosted email/password sign-in | Use a dedicated least-privilege account for unattended deployments |

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
| `AFFINE_MCP_HTTP_PROXY_URL` | No | `http://127.0.0.1:${PORT:-3000}/mcp` | Loopback Streamable HTTP endpoint used by `affine-mcp-http-proxy` |
| `AFFINE_MCP_HTTP_PROXY_TIMEOUT_MS` | No | `60000` | Deadline for the complete proxy response, including its body; integer from `100` to `300000` |
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
| `AFFINE_WS_CLIENT_VERSION` | No | `AFFINE_CLIENT_VERSION` (else `0.26.0`) | Environment-only AFFiNE client version sent during workspace socket connection; falls back to `AFFINE_CLIENT_VERSION` when unset |
| `AFFINE_WS_CONNECT_TIMEOUT_MS` | No | `10000` | Environment-only milliseconds to wait for a workspace socket connection |
| `AFFINE_WS_ACK_TIMEOUT_MS` | No | `10000` | Environment-only milliseconds to wait for a workspace socket acknowledgement |

## Auth strategy matrix

| Environment | Recommended auth | Why |
| --- | --- | --- |
| AFFiNE Cloud + stdio | Browser session cookie or saved config from `affine-mcp login` | Cloud programmatic sign-in is blocked by Cloudflare |
| AFFiNE Cloud + HTTP | Browser session cookie plus bearer or OAuth at the MCP layer | MCP caller auth and AFFiNE backend auth remain separate |
| Self-hosted + stdio | Email/password or a session cookie | Supported by current AFFiNE without the removed token API |
| Self-hosted + HTTP | Dedicated-account email/password or a session cookie | Suitable for shared backend service identity deployments |

Important note for AFFiNE Cloud:

- Programmatic email/password sign-in to `/api/auth/sign-in` is not supported because Cloudflare blocks those requests
- AFFiNE's built-in MCP credentials authenticate its own workspace-scoped MCP endpoint and are not interchangeable with this external server's GraphQL credentials

## Docker

Prebuilt images are published to GHCR:

- `ghcr.io/dawncr0w/affine-mcp-server:latest`
- `ghcr.io/dawncr0w/affine-mcp-server:3.0.0`

Example:

```bash
docker run -d \
  -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e AFFINE_BASE_URL=https://your-affine-instance.com \
  -e AFFINE_EMAIL=you@example.com \
  -e AFFINE_PASSWORD=your-password \
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

### Concurrent writes

Run one HTTP MCP server and point every writing client at that listener. Clients
that require stdio can each run the existing `affine-mcp-http-proxy` bridge; see
[client setup](client-setup.md#reuse-a-local-http-listener-from-stdio-clients).
All sessions in that server share a FIFO queue per AFFiNE workspace. The queue
covers the entire tool operation, including loading snapshots, validation,
workspace metadata changes, and persistence. `read_doc` uses the same queue so
its content and revision follow earlier coordinated writes. Different
workspaces can run concurrently.

This boundary is one MCP server process. Separate full stdio servers, multiple
HTTP replicas, and the native AFFiNE editor do not share this queue. Route all
coordinated writers through one listener; session affinity alone is insufficient
when writers for a workspace can reach different replicas. Yjs still merges
external updates, but the upstream push API provides no compare-and-swap or
cross-process isolation. Composite operations are serialized, not database
transactions: existing partial/uncertain-write responses still apply.

For edits derived from a previous read, pass `read_doc.revision` as
`expectedRevision` on a document content mutation, such as block, table,
database, mindmap, title, Markdown, or document deletion tools. Supported tools
advertise the optional field in `tools/list`:

```json
{
  "name": "update_block",
  "arguments": {
    "workspaceId": "workspace-id",
    "docId": "document-id",
    "blockId": "paragraph-id",
    "text": "Revised text",
    "expectedRevision": "<64-character revision returned by read_doc>"
  }
}
```

The comparison occurs inside the workspace queue before the tool runs. A
mismatch returns `isError: true`, code `STALE_DOCUMENT_REVISION`, and
`retryable: false`, with the expected/current revision in `details`. Read again
and reconcile the edit before resubmitting. The token covers the primary
document's full Yjs state, including deletions, and its presence in the workspace
document registry. Removing that entry invalidates old tokens even if AFFiNE
retains the deleted content snapshot. The token does not cover workspace
tags, folders, collections, or other documents touched by a composite tool.
Workspace metadata, comments, custom properties, publication, and document
hierarchy tools are still serialized but do not advertise this content token.
It is a content precondition within the shared server, not upstream CAS.
Without `expectedRevision`, explicit replacements apply in queue order and a
later replacement can intentionally supersede earlier text. A missing document
has `revision: null` and cannot satisfy a supplied revision.

The queue permits at most 100 waiting calls per workspace and waits at most
60 seconds before execution starts. Queue overflow or timeout reports a
structured error without invoking the tool. Cancellation removes a waiting
call; an already executing call retains its slot until it settles, even if its
caller disconnects. If an active request loses its response, read back before
retrying because persistence may already have succeeded.

### Bearer mode

```bash
export MCP_TRANSPORT=http
export AFFINE_MCP_AUTH_MODE=bearer
export AFFINE_BASE_URL="https://your-self-hosted-affine.example.com"
export AFFINE_EMAIL="service-account@example.com"
export AFFINE_PASSWORD="your-service-account-password"
export AFFINE_MCP_HTTP_HOST="0.0.0.0"
export AFFINE_MCP_HTTP_TOKEN="your-super-secret-token"
export PORT=3000

npm run start:http
```

### Private stdio bridge for a local HTTP listener

When a managed host already runs the HTTP transport, use
`affine-mcp-http-proxy` for a local stdio client instead of starting another
full MCP server process. The bridge forwards one stdio session to the existing
loopback `/mcp` listener and sends `DELETE /mcp` when stdin closes.

It requires `AFFINE_MCP_HTTP_TOKEN` in its inherited environment. Keep that
token in the host/container environment: do not put it in a command line or
copy it to the client. `AFFINE_MCP_HTTP_PROXY_URL` defaults to
`http://127.0.0.1:${PORT:-3000}/mcp` and accepts loopback URLs only.

The default HTTP connection assumes a trusted host or container where untrusted
processes cannot replace the listener or claim its port. Loopback limits network
reachability; it does not authenticate the listener to the bridge. On a shared
host with untrusted processes, use an `https://` loopback endpoint with a trusted
certificate and an authenticated TLS terminator, or isolate the bridge and
listener together. Do not disable TLS certificate verification.

The bridge reinitializes an expired HTTP session only when the listener explicitly
rejects its session ID before dispatch. It never retries an ambiguous request
after a network failure or timeout, which avoids duplicating document writes.
Email/password login failures can recover on a later request after a five-second
cooldown; concurrent sessions share the same login attempt.
Sessions established with email/password renew before cookie expiry, or after
twelve hours when the server omits an expiry. Explicit cookies and bearer tokens
remain managed by the caller.

```bash
affine-mcp-http-proxy
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
export AFFINE_BASE_URL="https://your-self-hosted-affine.example.com"
export AFFINE_EMAIL="service-account@example.com"
export AFFINE_PASSWORD="your-service-account-password"
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
- still requires backend service credentials so the server can call AFFiNE: email/password, a session cookie, or a compatible bearer token
- authenticates callers at the MCP boundary but does not delegate their identity to AFFiNE; every request uses the same configured backend service identity
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

`replace_doc_with_markdown` removes the existing main-note content and is classified as destructive. It is available in `full`, but excluded from `core`, `authoring`, and deployments with `AFFINE_DISABLED_GROUPS=destructive`. Use `append_markdown` or `update_block` for incremental edits in those profiles.

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

Use tool-level filtering when you want a mostly complete tool surface but need to remove specific destructive or administrative operations.

Every registered tool must also be present in the canonical tool surface and `tool-manifest.json`. The server refuses to start when a tool is registered without that metadata, including when the `full` profile is selected.

## Deployment checklist

Before exposing the server remotely, confirm:

- `AFFINE_BASE_URL` is reachable from the MCP host
- the configured AFFiNE backend credentials work through `affine-mcp status` or an equivalent health path
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

- Cloudflare / sign-in failures: use a signed-in browser session cookie
- Startup timeouts: avoid `AFFINE_LOGIN_AT_START=sync` unless required
- Missing tools: confirm filtering variables are not removing them
- Browser CORS failures: verify `AFFINE_MCP_HTTP_ALLOWED_ORIGINS`
- OAuth failures: verify issuer discovery metadata and JWKS availability
- Custom GraphQL deployments: run `affine-mcp show-config --json` and confirm `graphqlEndpoint`, then run `affine-mcp doctor --json`
- `doctor` also rejects an unprotected non-loopback HTTP bind and validates OAuth transport, discovery metadata, and JWKS reachability
- Invalid transport, port, origin, or boolean values now fail at startup instead of silently falling back
- Remote plain-HTTP AFFiNE URL rejected: use HTTPS, or set `AFFINE_ALLOW_INSECURE_HTTP=true` only for a trusted private network
- Non-loopback bearer listener rejected: set `AFFINE_MCP_HTTP_TOKEN` or configure OAuth
