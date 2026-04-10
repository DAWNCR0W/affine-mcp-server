# Client Setup

This guide provides copy-paste configuration for the most common MCP clients.

## Client matrix

| Client | Transport | Recommended auth | Best starting point |
| --- | --- | --- | --- |
| Claude Code | stdio | Saved config or API token | `affine-mcp login` + `command: "affine-mcp"` |
| Claude Desktop | stdio | Saved config or API token | Config JSON with `command: "affine-mcp"` |
| Codex CLI | stdio | Saved config or API token | `codex mcp add affine -- affine-mcp` |
| Cursor | stdio | Saved config or API token | `.cursor/mcp.json` |
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
        "AFFINE_API_TOKEN": "ut_xxx"
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
        "AFFINE_API_TOKEN": "ut_xxx"
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

With an API token:

```bash
codex mcp add affine \
  --env AFFINE_BASE_URL=https://app.affine.pro \
  --env AFFINE_API_TOKEN=ut_xxx \
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
        "AFFINE_API_TOKEN": "ut_xxx"
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
        "AFFINE_API_TOKEN": "ut_xxx"
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

## Setup tips

- Prefer `affine-mcp login` for local development
- Prefer `AFFINE_API_TOKEN` for AFFiNE Cloud
- Prefer tokens over passwords for automated environments
- If your shell treats `!` specially, wrap passwords in single quotes
- Use `affine-mcp doctor` whenever a client config looks correct but the connection still fails
