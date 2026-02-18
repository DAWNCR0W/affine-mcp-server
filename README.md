# AFFiNE MCP Server

A Model Context Protocol (MCP) server that integrates with AFFiNE (self‑hosted or cloud). It exposes AFFiNE workspaces and documents to AI assistants over stdio.

[![Version](https://img.shields.io/badge/version-1.5.0-blue)](https://github.com/dawncr0w/affine-mcp-server/releases)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.17.2-green)](https://github.com/modelcontextprotocol/typescript-sdk)
[![CI](https://github.com/dawncr0w/affine-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/dawncr0w/affine-mcp-server/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

<a href="https://glama.ai/mcp/servers/@DAWNCR0W/affine-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@DAWNCR0W/affine-mcp-server/badge" alt="AFFiNE Server MCP server" />
</a>

## Overview

- Purpose: Manage AFFiNE workspaces and documents through MCP
- Transport: stdio only (Claude Desktop / Codex compatible)
- Auth: Token, Cookie, or Email/Password (priority order)
- Tools: 32 focused tools with WebSocket-based document editing
- Status: Active
 
> New in v1.5.0: `append_block` now supports 30 verified block profiles, including database/edgeless (`frame`, `edgeless_text`, `surface_ref`, `note`) insertion paths. For stability on AFFiNE 0.26.x, `type=\"data_view\"` is currently mapped to a database block.

## Features

- Workspace: create (with initial doc), read, update, delete
- Documents: list/get/read/publish/revoke + create/append paragraph/delete (WebSocket‑based)
- Comments: full CRUD and resolve
- Version History: list
- Users & Tokens: current user, sign in, profile/settings, and personal access tokens
- Notifications: list and mark as read
- Blob storage: upload/delete/cleanup

## Requirements

- Node.js 18+
- An AFFiNE instance (self‑hosted or cloud)
- Valid AFFiNE credentials or access token

## Installation

```bash
# Global install (recommended)
npm i -g affine-mcp-server

# Or run ad‑hoc via npx (no install)
npx -y -p affine-mcp-server affine-mcp -- --version
```

The package installs a CLI named `affine-mcp` that runs the MCP server over stdio.

Note: From v1.2.2+ the CLI wrapper (`bin/affine-mcp`) ensures Node runs the ESM entrypoint, preventing shell from misinterpreting JS.

## Configuration

### Interactive login (recommended)

The easiest way to configure credentials:

```bash
npm i -g affine-mcp-server
affine-mcp login
```

This stores credentials in `~/.config/affine-mcp/config` (mode 600). The MCP server reads them automatically — no environment variables needed.

**AFFiNE Cloud** (`app.affine.pro`): you'll be prompted to paste an API token from Settings → Integrations → MCP Server.

**Self-hosted instances**: you can choose between email/password (recommended — auto-generates an API token) or pasting a token manually.

```
$ affine-mcp login
Affine MCP Server — Login

Affine URL [https://app.affine.pro]: https://my-affine.example.com

Auth method — [1] Email/password (recommended)  [2] Paste API token: 1
Email: user@example.com
Password: ****
Signing in...
✓ Signed in as: User Name <user@example.com>

Generating API token...
✓ Created token: ut_abc123... (name: affine-mcp-2026-02-18)

Detecting workspaces...
  Found 1 workspace: abc-def-123  (by User Name, 1 member, 2/10/2026)
  Auto-selected.

✓ Saved to /home/user/.config/affine-mcp/config (mode 600)
The MCP server will use these credentials automatically.
```

Other CLI commands:
- `affine-mcp status` — show current config and test connection
- `affine-mcp logout` — remove stored credentials

### Environment variables

You can also configure via environment variables (they override the config file):

- Required: `AFFINE_BASE_URL`
- Auth (choose one): `AFFINE_API_TOKEN` | `AFFINE_COOKIE` | `AFFINE_EMAIL` + `AFFINE_PASSWORD`
- Optional: `AFFINE_GRAPHQL_PATH` (default `/graphql`), `AFFINE_WORKSPACE_ID`, `AFFINE_LOGIN_AT_START` (`async` default, `sync` to block)

Authentication priority:
1) `AFFINE_API_TOKEN` → 2) `AFFINE_COOKIE` → 3) `AFFINE_EMAIL` + `AFFINE_PASSWORD`

> **Cloudflare note**: `AFFINE_EMAIL`/`AFFINE_PASSWORD` auth requires programmatic access to `/api/auth/sign-in`. AFFiNE Cloud (`app.affine.pro`) is behind Cloudflare, which blocks these requests. Use `AFFINE_API_TOKEN` for cloud, or use `affine-mcp login` which handles this automatically. Email/password works for self-hosted instances without Cloudflare.

## Quick Start

### Claude Code

After running `affine-mcp login`, add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp"
    }
  }
}
```

No `env` block needed — the server reads `~/.config/affine-mcp/config` automatically.

If you prefer explicit env vars instead of the config file:

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

### Claude Desktop

Add to your Claude Desktop configuration:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
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

Or with email/password for self-hosted instances (not supported on AFFiNE Cloud — see Cloudflare note above):

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp",
      "env": {
        "AFFINE_BASE_URL": "https://your-self-hosted-affine.com",
        "AFFINE_EMAIL": "you@example.com",
        "AFFINE_PASSWORD": "secret!",
        "AFFINE_LOGIN_AT_START": "async"
      }
    }
  }
}
```

Tips
- Prefer `affine-mcp login` or `AFFINE_API_TOKEN` for zero‑latency startup.
- If your password contains `!` (zsh history expansion), wrap it in single quotes in shells or use the JSON config above.

### Codex CLI

Register the MCP server with Codex:

- With config file (after `affine-mcp login`):
  - `codex mcp add affine -- affine-mcp`

- With API token:
  - `codex mcp add affine --env AFFINE_BASE_URL=https://app.affine.pro --env AFFINE_API_TOKEN=ut_xxx -- affine-mcp`

- With email/password (self-hosted only):
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-self-hosted-affine.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' --env AFFINE_LOGIN_AT_START=async -- affine-mcp`

### Cursor

Cursor also supports MCP over stdio with `mcp.json`.

Project-local (`.cursor/mcp.json`) example:

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

If you prefer `npx`:

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

## Available Tools

### Workspace
- `list_workspaces` – list all workspaces
- `get_workspace` – get workspace details
- `create_workspace` – create workspace with initial document
- `update_workspace` – update workspace settings
- `delete_workspace` – delete workspace permanently

### Documents
- `list_docs` – list documents with pagination
- `get_doc` – get document metadata
- `read_doc` – read document block content and plain text snapshot (WebSocket)
- `publish_doc` – make document public
- `revoke_doc` – revoke public access
- `create_doc` – create a new document (WebSocket)
- `append_paragraph` – append a paragraph block (WebSocket)
- `append_block` – append canonical block types (text/list/code/media/embed/database/edgeless) with strict validation and placement control (`data_view` currently falls back to database)
- `delete_doc` – delete a document (WebSocket)

### Comments
- `list_comments`, `create_comment`, `update_comment`, `delete_comment`, `resolve_comment`

### Version History
- `list_histories`

### Users & Tokens
- `current_user`, `sign_in`, `update_profile`, `update_settings`
- `list_access_tokens`, `generate_access_token`, `revoke_access_token`

### Notifications
- `list_notifications`, `read_all_notifications`

### Blob Storage
- `upload_blob`, `delete_blob`, `cleanup_blobs`

## Use Locally (clone)

```bash
git clone https://github.com/dawncr0w/affine-mcp-server.git
cd affine-mcp-server
npm install
npm run build
# Run directly
node dist/index.js

# Or expose as a global CLI for Codex/Claude without publishing
npm link
# Now use `affine-mcp` like a global binary
```

## Quality Gates

```bash
npm run build
npm run test:tool-manifest
npm run pack:check
```

- `tool-manifest.json` is the source of truth for publicly exposed tool names.
- CI validates that `registerTool(...)` declarations match the manifest exactly.

## Troubleshooting

Authentication
- **Cloudflare (403 "Just a moment...")**: AFFiNE Cloud (`app.affine.pro`) uses Cloudflare protection, which blocks programmatic sign-in via `/api/auth/sign-in`. Use `AFFINE_API_TOKEN` instead, or run `affine-mcp login` which guides you through the right method automatically. Email/password auth only works for self-hosted instances.
- Email/Password: only works on self-hosted instances without Cloudflare. Ensure your instance allows password auth and credentials are valid.
- Cookie: copy cookies (e.g., `affine_session`, `affine_csrf`) from the browser DevTools after login
- Token: generate a personal access token; verify it hasn't expired. Run `affine-mcp status` to test.
- Startup timeouts: v1.2.2+ includes a CLI wrapper fix and default async login to avoid blocking the MCP handshake. Set `AFFINE_LOGIN_AT_START=sync` only if needed.

Connection
- Confirm `AFFINE_BASE_URL` is reachable
- GraphQL endpoint default is `/graphql`
- Check firewall/proxy rules; verify CORS if self‑hosted

Method not found
- MCP tool names (for example `list_workspaces`) are not JSON-RPC top-level method names.
- Use an MCP client (`tools/list`, `tools/call`) instead of sending direct JSON-RPC calls like `{\"method\":\"list_workspaces\"}`.
- From v1.3.0, only canonical tool names are exposed (legacy `affine_*` aliases were removed).

Workspace visibility
- This MCP server can access server-backed workspaces only (AFFiNE cloud/self-hosted).
- Browser local-storage workspaces are client-side data, so they are not visible via server GraphQL/WebSocket APIs.

## Security Considerations

- Never commit `.env` with secrets
- Prefer environment variables in production
- Rotate access tokens regularly
- Use HTTPS
- Store credentials in a secrets manager

## Version History

### 1.5.0 (2026‑02‑13)
- Expanded `append_block` from Step1 to Step4 profiles: canonical text/list/code/divider/callout/latex/table/bookmark/media/embed plus `database`, `data_view`, `surface_ref`, `frame`, `edgeless_text`, `note` (`data_view` currently mapped to database for stability)
- Added strict field validation and canonical parent enforcement for page/note/surface containers
- Added local integration runner coverage for all 30 append_block cases against a live AFFINE server

### 1.4.0 (2026‑02‑13)
- Added `read_doc` for reading document block snapshot + plain text
- Added Cursor setup examples and troubleshooting notes for JSON-RPC method usage
- Added explicit local-storage workspace limitation notes

### 1.3.0 (2026‑02‑13)
- Added `append_block` for slash-command style editing (`heading/list/todo/code/divider/quote`)
- Tool surface simplified to 31 canonical tools (duplicate aliases removed)
- Added CI + manifest parity verification (`npm run test:tool-manifest`, `npm run ci`)
- Added open-source community health docs and issue/PR templates

### 1.2.2 (2025‑09‑18)
- CLI wrapper added to ensure Node runs ESM entry (`bin/affine-mcp`), preventing shell mis-execution
- Docs cleaned: use env vars via shell/app config; `.env` file no longer recommended
- MCP startup behavior unchanged from 1.2.1 (async login by default)

### 1.2.1 (2025‑09‑17)
- Default to asynchronous email/password login after MCP stdio handshake
- New `AFFINE_LOGIN_AT_START` env (`async` default, `sync` to block at startup)
- Expanded docs for Codex/Claude using npm, npx, and local clone

### 1.2.0 (2025‑09‑16)
- WebSocket-based document tools: `create_doc`, `append_paragraph`, `delete_doc` (create/edit/delete now supported)
- Tool aliases introduced at the time (`affine_*` + non-prefixed names). They were removed later to reduce duplication.
- ESM resolution: NodeNext; improved build stability
- CLI binary: `affine-mcp` for easy `npm i -g` usage

### 1.1.0 (2025‑08‑12)
- Fixed workspace creation with initial documents (UI accessible)
- 30+ tools, simplified tool names
- Improved error handling and authentication

### 1.0.0 (2025‑08‑12)
- Initial stable release
- Basic workspace and document operations
- Full authentication support

## Contributing

Contributions are welcome!
1. Read `CONTRIBUTING.md`
2. Run `npm run ci` locally before opening PR
3. Keep tool changes synced with `tool-manifest.json`
4. Use issue/PR templates in `.github/`

## Community Health

- Code of Conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
- Contributing guide: `CONTRIBUTING.md`

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- Open an issue on [GitHub](https://github.com/dawncr0w/affine-mcp-server/issues)
- Check AFFiNE documentation at https://docs.affine.pro

## Author

**dawncr0w** - [GitHub](https://github.com/dawncr0w)

## Acknowledgments

- Built for the [AFFiNE](https://affine.pro) knowledge base platform
- Uses the [Model Context Protocol](https://modelcontextprotocol.io) specification
- Powered by [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
