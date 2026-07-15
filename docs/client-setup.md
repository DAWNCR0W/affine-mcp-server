# Client Setup

This guide provides copy-paste configuration for the most common MCP clients.

## Client matrix

| Client | Transport | Recommended auth | Best starting point |
| --- | --- | --- | --- |
| Claude Code | stdio | Saved config | `affine-mcp login` + `command: "affine-mcp"` |
| Claude Desktop | stdio | Saved config | Config JSON with `command: "affine-mcp"` |
| Codex CLI | stdio | Saved config | `codex mcp add affine -- affine-mcp` |
| Cursor | stdio | Saved config | `.cursor/mcp.json` |
| Remote HTTP MCP clients | HTTP | Bearer token or OAuth | See [configuration and deployment](configuration-and-deployment.md#http-mode) |

## Claude Code

Project-local `.mcp.json`:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp"
    }
  }
}
```

Explicit environment variables (prefer saved config locally):

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp",
      "env": {
        "AFFINE_BASE_URL": "https://app.affine.pro",
        "AFFINE_COOKIE": "affine_session=your-session-id"
      }
    }
  }
}
```

## Claude Desktop

Typical config paths:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp",
      "env": {
        "AFFINE_BASE_URL": "https://app.affine.pro",
        "AFFINE_COOKIE": "affine_session=your-session-id"
      }
    }
  }
}
```

Self-hosted email/password example:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp",
      "env": {
        "AFFINE_BASE_URL": "https://your-self-hosted-affine.com",
        "AFFINE_EMAIL": "you@example.com",
        "AFFINE_PASSWORD": "secret"
      }
    }
  }
}
```

## Codex CLI

With saved config:

```bash
codex mcp add affine -- affine-mcp
```

With a browser session cookie:

```bash
codex mcp add affine \
  --env AFFINE_BASE_URL=https://app.affine.pro \
  --env 'AFFINE_COOKIE=affine_session=your-session-id' \
  -- affine-mcp
```

With self-hosted email/password:

```bash
codex mcp add affine \
  --env AFFINE_BASE_URL=https://your-self-hosted-affine.com \
  --env 'AFFINE_EMAIL=you@example.com' \
  --env 'AFFINE_PASSWORD=secret' \
  -- affine-mcp
```

## Cursor

Project-local `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp",
      "env": {
        "AFFINE_BASE_URL": "https://app.affine.pro",
        "AFFINE_COOKIE": "affine_session=your-session-id"
      }
    }
  }
}
```

`npx` variant:

```json
{
  "mcpServers": {
    "affine": {
      "command": "npx",
      "args": ["-y", "-p", "affine-mcp-server", "affine-mcp"],
      "env": {
        "AFFINE_BASE_URL": "https://app.affine.pro",
        "AFFINE_COOKIE": "affine_session=your-session-id"
      }
    }
  }
}
```

## Remote HTTP MCP clients

If your client connects to MCP over HTTP instead of stdio, configure the server first by following [configuration and deployment](configuration-and-deployment.md#http-mode).

If you want the fastest containerized setup, start with the Docker quick start in [getting started](getting-started.md#path-c-run-from-the-docker-image).

Typical bearer-mode client config:

```json
{
  "mcpServers": {
    "affine": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-strong-secret"
      }
    }
  }
}
```

Always send the MCP bearer token in the `Authorization` header. The server
rejects `?token=` by default because URL credentials can leak through logs and
browser history.

## Setup tips

- Prefer `affine-mcp login` for AFFiNE Cloud and local development; then keep client config to `command: "affine-mcp"`
- Treat `AFFINE_COOKIE` as a password-equivalent secret and rerun login when the session expires or is revoked
- Do not use an `aff_mcp_v1` credential here; it is scoped to AFFiNE's native workspace MCP and cannot authenticate this server's full GraphQL/WebSocket toolset
- Use explicit `AFFINE_COOKIE` only for controlled automation; environment and client configuration can expose it more broadly than the mode-`600` saved config
- If your shell treats `!` specially, wrap passwords in single quotes
- Use `affine-mcp doctor` whenever a client config looks correct but the connection still fails
