# Getting Started

This guide is the fastest way to get AFFiNE MCP Server working and confirm that your MCP client can reach AFFiNE successfully.

## Choose a setup path

| Scenario | Recommended path |
| --- | --- |
| Local MCP client on your machine | Use the saved-config flow with `affine-mcp login` |
| AFFiNE Cloud | Use an API token |
| Self-hosted AFFiNE | Use an API token, or email/password if your instance allows it |
| Temporary usage without a global install | Use `npx` |
| Run the server in Docker | Use the GHCR image and HTTP transport |
| Remote MCP deployment | Skip to [configuration and deployment](configuration-and-deployment.md) |

## Path A: Saved config with interactive login

This is the recommended local setup because it keeps client config minimal and avoids repeated environment-variable configuration.

### 1. Install the CLI

```bash
npm i -g affine-mcp-server
affine-mcp --version
```

### 2. Save credentials

```bash
affine-mcp login
```

What happens:

- The CLI asks for your AFFiNE base URL
- For AFFiNE Cloud, it prompts for an API token
- For self-hosted AFFiNE, it can sign in with email/password and generate a token automatically
- The effective config is stored at `~/.config/affine-mcp/config`

### 3. Verify the saved config

```bash
affine-mcp status
affine-mcp doctor
```

### 4. Register the server with a client

Minimal stdio config:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp"
    }
  }
}
```

See [client setup](client-setup.md) for full client-specific snippets.

## Path B: Explicit environment variables

Use this path when you prefer stateless or container-friendly setup instead of a saved config file.

### Required variables

- `AFFINE_BASE_URL`
- One auth strategy:
  - `AFFINE_API_TOKEN`
  - `AFFINE_COOKIE`
  - `AFFINE_EMAIL` and `AFFINE_PASSWORD`

### Example: AFFiNE Cloud

```bash
export AFFINE_BASE_URL="https://app.affine.pro"
export AFFINE_API_TOKEN="ut_xxx"
affine-mcp status
```

### Example: self-hosted AFFiNE with email/password

```bash
export AFFINE_BASE_URL="https://your-affine.example.com"
export AFFINE_EMAIL="you@example.com"
export AFFINE_PASSWORD="secret"
affine-mcp status
```

For the full environment-variable reference, see [configuration and deployment](configuration-and-deployment.md#environment-variables).

## Path C: Run from the Docker image

Use this when:

- you want a containerized local or remote deployment
- you prefer an HTTP MCP endpoint over stdio
- you do not want to install Node.js on the target host

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

Quick verification:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

Client-side MCP config:

```json
{
  "mcpServers": {
    "affine": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-strong-secret"
      }
    }
  }
}
```

For OAuth mode, origin controls, and deployment hardening, continue with [configuration and deployment](configuration-and-deployment.md#docker).

## Path D: Run from a local clone

Use this when you want to inspect or modify the server locally.

```bash
git clone https://github.com/dawncr0w/affine-mcp-server.git
cd affine-mcp-server
npm install
npm run build
node dist/index.js
```

You can also expose a linked CLI locally:

```bash
npm link
affine-mcp --version
```

## Verify your setup

Use this sequence after any first-run setup:

```bash
affine-mcp status
affine-mcp show-config
affine-mcp doctor
```

If you are running the Docker image, also verify:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

Expected results:

- `status` confirms the active base URL, auth source, and connection result
- `show-config` prints the effective configuration with secrets redacted
- `doctor` checks config shape and connectivity and points to the failing layer
- `healthz` and `readyz` return successful probe responses when the HTTP server is healthy

If you are onboarding another client, these helpers can generate snippets from the current config:

```bash
affine-mcp snippet claude --env
affine-mcp snippet codex --env
affine-mcp snippet all --env
```

## Common first-run failures

### Cloudflare blocks email/password sign-in

AFFiNE Cloud (`app.affine.pro`) is behind Cloudflare. Programmatic requests to `/api/auth/sign-in` are blocked.

Use:

- `AFFINE_API_TOKEN`
- or `affine-mcp login`, which guides you toward the supported path

### Saved config exists, but the client cannot connect

Run:

```bash
affine-mcp status
affine-mcp doctor
```

Then verify that the client is invoking `affine-mcp` from the same environment where the config file exists.

### Workspace is missing

This server can access only server-backed AFFiNE workspaces.

It cannot access workspaces that exist only in browser local storage.

### "Method not found" when calling a tool

MCP tools are not JSON-RPC top-level method names. Use an MCP client that calls `tools/list` and `tools/call` instead of sending direct JSON-RPC methods such as `{"method":"list_workspaces"}`.

### Self-hosted email/password does not work

Confirm:

- your instance exposes the standard auth endpoints
- Cloudflare or another bot-protection layer is not blocking sign-in
- the credentials are valid

If in doubt, switch to an API token.
