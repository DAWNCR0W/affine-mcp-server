**Overview**
- Purpose: MCP server exposing AFFiNE GraphQL tools to manage workspaces, docs, search, comments, and history.
- Transport: WebSocket (default, port 7821) or stdio.
- Auth: Cookie-first (recommended). Optional personal access token (PAT) via GraphQL.
- Tools: workspaces, docs (list/get), search, recent, publish/revoke, comments (list/create/update/delete/resolve), histories (list/recover), current user, access tokens, and advanced apply-updates.

**Features**
- **Notion-like coverage**: Tools mirror common Notion MCP server flows where possible in AFFiNE.
- **GraphQL-first**: Uses `AFFINE_BASE_URL` + `/graphql` for queries/mutations.
- **Session auth**: Provide cookies via `AFFINE_COOKIE` or `AFFINE_HEADERS_JSON` (AFFiNE typically uses session cookies).
- **Dockerized**: Run with `docker compose` and connect over WebSocket.

**Requirements**
- Node.js 20+ (if running locally) or Docker.
- A reachable AFFiNE server URL (self-hosted). If your instance requires login, supply `AFFINE_COOKIE` from your browser session.

**Quick Start (Docker Compose)**
- Copy `.env.example` to `.env` and set values:
  - `AFFINE_BASE_URL`: Base URL of your AFFiNE server, e.g. `http://affine.local:3010`.
  - `AFFINE_COOKIE`: Session cookie string (e.g., `affine_session=<...>; affine_user_id=<...>`).
  - `AFFINE_HEADERS_JSON`: Optional JSON of extra headers to send.
  - `AFFINE_GRAPHQL_PATH`: Usually `/graphql`.
  - `AFFINE_WORKSPACE_ID`: Default workspace id (optional). Tools also accept explicit `workspaceId`.
  - `MCP_WS_PORT`: Host port to expose (default 7821).
- Build and run:
  - `docker compose up --build -d`
- The MCP server listens on `ws://localhost:${MCP_WS_PORT}` (default `ws://localhost:7821`).

**Tool Summary**
- `affine_list_workspaces`: No input. Returns workspaces.
- `affine_get_workspace`: `id`.
- `affine_list_docs`: `workspaceId?`, `first?`, `offset?`, `after?`.
- `affine_get_doc`: `docId`, `workspaceId?`.
- `affine_search_docs`: `keyword`, `limit?`, `workspaceId?`.
- `affine_recent_docs`: `first?`, `offset?`, `after?`, `workspaceId?`.
- `affine_publish_doc`: `docId`, `mode? (Page|Edgeless)`, `workspaceId?`.
- `affine_revoke_doc`: `docId`, `workspaceId?`.
- `affine_list_comments`: `docId`, `first?`, `offset?`, `after?`, `workspaceId?`.
- `affine_create_comment`: `docId`, `content`, `docTitle?`, `docMode?`, `mentions?`, `workspaceId?`.
- `affine_update_comment`: `id`, `content`.
- `affine_delete_comment`: `id`.
- `affine_resolve_comment`: `id`, `resolved`.
- `affine_list_histories`: `guid`, `take?`, `before?`, `workspaceId?`.
- `affine_recover_doc`: `guid`, `timestamp`, `workspaceId?`.
- `affine_current_user`: No input.
- `affine_list_access_tokens`: List personal access tokens (metadata only).
- `affine_generate_access_token`: Generate a PAT and return the token string.
- `affine_revoke_access_token`: Revoke a PAT by id.
- `affine_apply_doc_updates` (advanced): `docId`, `op`, `updates`, `workspaceId?`.

Notes:
- If `workspaceId` is omitted where optional, the server uses `AFFINE_WORKSPACE_ID` when set.
- Many AFFiNE mutations rely on user session cookies; supply `AFFINE_COOKIE` for authenticated operations.
- For raw doc content (binary, markdown, or CRDT diffs), AFFiNE exposes internal `/rpc` endpoints requiring an internal access token; this server does not call those by default.

**GraphQL Schema Alignment**
- Queries/mutations align with `packages/backend/server/src/schema.gql` in AFFiNE.
- Key operations used: `workspaces`, `workspace(id)`, `docs`, `doc`, `searchDocs`, `recentlyUpdatedDocs`, `publishDoc`, `revokePublicDoc`, `comments`, `createComment`, `updateComment`, `deleteComment`, `resolveComment`, `histories`, `recoverDoc`, `currentUser`, `accessTokens`, `generateUserAccessToken`, `revokeUserAccessToken`, `applyDocUpdates`.

**Authentication**
- Cookie (recommended)
  - In your browser after logging into AFFiNE, copy cookies `affine_session` and `affine_user_id`.
  - Put them into `.env` as: `AFFINE_COOKIE=affine_session=...; affine_user_id=...`.
- Personal Access Token (optional)
  - Generate via GraphQL while authenticated with cookies:
    - Mutation: `generateUserAccessToken(input: { name, expiresAt? })`.
    - Example curl:
      - `curl -X POST "$AFFINE_BASE_URL/graphql" \
        -H "Content-Type: application/json" \
        -H "Cookie: affine_session=...; affine_user_id=..." \
        -d '{"query":"mutation($input:GenerateAccessTokenInput!){ generateUserAccessToken(input:$input){ id name token expiresAt } }","variables":{"input":{"name":"mcp","expiresAt":null}}}'`
  - If you prefer Bearer auth, set `AFFINE_API_TOKEN` with the returned `token` (cookie auth remains fully supported).
 - Email/Password (self-hosted)
  - You can configure `AFFINE_EMAIL` and `AFFINE_PASSWORD` in `.env`. On start, the server attempts to sign in against `POST /api/auth/sign-in` and stores the returned session cookies in-memory.
  - Or call the tool `affine_sign_in` with `{ email, password }` to sign in at runtime. After success, subsequent tools use the session.

**Local Dev (Node)**
- Install deps: `npm ci`
- Run in watch mode (stdio): `npm run dev`
- Build: `npm run build`
- Start (stdio): `npm start`
- Switch transport: set `MCP_TRANSPORT=stdio` for stdio mode, or `ws` for WebSocket (`MCP_WS_PORT` controls port).

**Connecting from MCP Clients**
- WebSocket (recommended with Docker):
  - Example client config:
    - Name: `affine`
    - URL: `ws://localhost:7821`
    - No command is needed; the container hosts the server.
- Stdio (runs as a child process):
  - Command: `node`
  - Args: `["dist/index.js"]`
  - Env:
    - `AFFINE_BASE_URL`, `AFFINE_COOKIE` (or `AFFINE_API_TOKEN`), `AFFINE_WORKSPACE_ID` as needed.
    - `MCP_TRANSPORT=stdio`

Codex CLI example (WebSocket):
- Add an MCP server entry pointing to `ws://localhost:7821`.

Codex CLI example (stdio):
- Add an MCP server entry with `command: "node"`, `args: ["dist/index.js"]` and the env variables above.

**Security**
- Treat `AFFINE_API_TOKEN` as sensitive. Use `.env` or secrets management; do not commit tokens.
- Prefer cookie-based auth: Use `AFFINE_COOKIE` from a logged-in browser session if your AFFiNE instance is private.
- When exposing WebSocket ports, consider network access controls if AFFiNE data is private.

**Limitations**
- AFFiNE’s schema may vary; this server targets `packages/backend/server` GraphQL.
- Document creation and low-level content edits are CRDT-driven and not fully exposed via public GraphQL. Use `affine_apply_doc_updates` only if you know how to generate Yjs updates.

**Codex CLI Integration**
- WebSocket
  - Ensure the server is running (Docker or Node with `MCP_TRANSPORT=ws`).
  - Add an MCP server entry in your Codex CLI config (example JSON):
    - `{ "mcpServers": { "affine": { "type": "websocket", "url": "ws://localhost:7821" } } }`
  - Auth stays in the server’s environment (e.g., container env). No extra client setup needed.
- Stdio
  - Build: `npm run build`
  - Configure Codex CLI to launch the process with env:
    - `{ "mcpServers": { "affine": { "type": "stdio", "command": "node", "args": ["dist/index.js"], "cwd": "/absolute/path/to/affine-mcp-server", "env": { "AFFINE_BASE_URL": "http://localhost:3000", "AFFINE_COOKIE": "affine_session=...; affine_user_id=...", "MCP_TRANSPORT": "stdio" } } } }`

**Claude CLI Integration**
- WebSocket
  - Run the server and expose `ws://localhost:7821`.
  - Create or edit your MCP servers config (e.g., `~/.config/claude/mcp.json` on Linux, `~/Library/Application Support/Claude/mcp.json` on macOS):
    - `{
         "mcpServers": {
           "affine": {
             "transport": { "type": "websocket", "url": "ws://localhost:7821" }
           }
         }
       }`
- Stdio
  - Let Claude launch the process with env:
    - `{
         "mcpServers": {
           "affine": {
             "transport": {
               "type": "stdio",
               "command": "node",
               "args": ["dist/index.js"],
               "cwd": "/absolute/path/to/affine-mcp-server"
             },
             "env": {
               "AFFINE_BASE_URL": "http://localhost:3000",
               "AFFINE_COOKIE": "affine_session=...; affine_user_id=...",
               "MCP_TRANSPORT": "stdio"
             }
           }
         }
       }`

Note: Config schema/paths can vary between client versions. Refer to each client’s MCP docs for the latest details.

**License**
- MIT License. See the LICENSE file in this directory.
