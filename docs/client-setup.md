# Client Setup

This guide provides copy-paste configuration for the most common MCP clients.

## Client matrix

| Client | Transport | Recommended auth | Best starting point |
| --- | --- | --- | --- |
| Claude Code | stdio | Saved config | `affine-mcp login` + `command: "affine-mcp"` |
| Claude Desktop | stdio | Saved config or session cookie | Config JSON with `command: "affine-mcp"` |
| Codex CLI | stdio | Saved config or self-hosted email/password | `codex mcp add affine -- affine-mcp` |
| Cursor | stdio | Saved config or session cookie | `.cursor/mcp.json` |
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

Explicit environment variables:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp",
      "env": {
        "AFFINE_BASE_URL": "https://app.affine.pro",
        "AFFINE_COOKIE": "your-complete-cookie-request-header"
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
        "AFFINE_COOKIE": "your-complete-cookie-request-header"
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

## MCP Inspector

MCP Inspector does not automatically read Claude Desktop's server
configuration. Starting it with only `affine-mcp` launches a separate process
without the `AFFINE_*` environment variables from
`claude_desktop_config.json`.

To inspect the same `affine` server configuration on macOS, pass the Claude
Desktop config file explicitly:

```bash
npx @modelcontextprotocol/inspector \
  --config "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
  --server affine
```

On Linux, use `~/.config/Claude/claude_desktop_config.json`. On Windows, use
`%APPDATA%\Claude\claude_desktop_config.json`. The value passed to `--server`
must match the key under `mcpServers`.

Inspector also accepts individual server environment variables through
repeated `-e KEY=value` arguments. Prefer the config-file form for passwords
and other secrets so they are not copied into shell history.

## Codex CLI

With saved config:

```bash
codex mcp add affine -- affine-mcp
```

With an AFFiNE Cloud browser session:

```bash
codex mcp add affine \
  --env AFFINE_BASE_URL=https://app.affine.pro \
  --env 'AFFINE_COOKIE=your-complete-cookie-request-header' \
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
        "AFFINE_COOKIE": "your-complete-cookie-request-header"
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
        "AFFINE_COOKIE": "your-complete-cookie-request-header"
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

## Reuse a local HTTP listener from stdio clients

For multiple writing agents, start one authenticated HTTP MCP server as described
in the [private bridge setup](configuration-and-deployment.md#private-stdio-bridge-for-a-local-http-listener).
Configure each local stdio client to launch the proxy instead of a full server:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp-http-proxy",
      "env": {
        "AFFINE_MCP_HTTP_PROXY_URL": "http://127.0.0.1:3000/mcp"
      }
    }
  }
}
```

The proxy must inherit `AFFINE_MCP_HTTP_TOKEN` from the trusted host environment
that launches it. Keep the token out of command arguments and copied client
configuration. Each proxy creates its own session, while the listener coordinates writes across
all of them. Direct HTTP clients can share the same listener. Use the same
server version for the listener and proxies, and follow the
[concurrency contract](configuration-and-deployment.md#concurrent-writes) when
editing the same document. Starting a separate `affine-mcp` server for every
agent does not provide coordination between those processes.

## Setup tips

- Prefer `affine-mcp login` for local development
- Use a signed-in browser session cookie for AFFiNE Cloud
- Use a dedicated least-privilege account for automated self-hosted environments
- Use `AFFINE_API_TOKEN` only when the target deployment still accepts a compatible GraphQL bearer token
- If your shell treats `!` specially, wrap passwords in single quotes
- When using MCP Inspector, pass `--config` and `--server` or supply the required `AFFINE_*` values with `-e`
- Use `affine-mcp doctor` whenever a client config looks correct but the connection still fails
