# AFFiNE MCP Server

A Model Context Protocol (MCP) server that integrates with AFFiNE (self‑hosted or cloud). It exposes AFFiNE workspaces and documents to AI assistants over stdio.

[![Version](https://img.shields.io/badge/version-1.2.1-blue)](https://github.com/dawncr0w/affine-mcp-server/releases)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.17.2-green)](https://github.com/modelcontextprotocol/typescript-sdk)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

## Overview

- Purpose: Manage AFFiNE workspaces and documents through MCP
- Transport: stdio only (Claude Desktop / Codex compatible)
- Auth: Token, Cookie, or Email/Password (priority order)
- Tools: 30+ tools plus WebSocket-based document editing
- Status: Production Ready (v1.2.1)
 
> New in v1.2.1: Email/Password login no longer blocks MCP startup. The server connects over stdio immediately and performs login asynchronously by default. Use `AFFINE_LOGIN_AT_START=sync` to restore the previous blocking behavior.

## Features

- Workspace: create (with initial doc), read, update, delete
- Documents: list/get/search/publish/revoke + create/append paragraph/delete (WebSocket‑based) — added in v1.2.0
- Comments: full CRUD and resolve
- Version History: list and recover
- Users & Tokens: profile/settings and personal access tokens
- Notifications: list and mark as read

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

> Available on npm: install in seconds with `npm i -g affine-mcp-server` and use `affine-mcp` anywhere. No manual build or path setup required.

## Configuration

Set environment variables (recommended) or create a `.env` file:

```env
# AFFiNE server URL (required)
AFFINE_BASE_URL=https://your-affine-instance.com

# Authentication (choose one method):
# 1) Bearer Token (highest priority)
AFFINE_API_TOKEN=your_personal_access_token
# 2) Session Cookie
AFFINE_COOKIE=affine_session=xxx; affine_csrf=yyy
# 3) Email/Password (fallback)
AFFINE_EMAIL=your@email.com
AFFINE_PASSWORD=your_password

# Optional settings
AFFINE_GRAPHQL_PATH=/graphql           # Default: /graphql
AFFINE_WORKSPACE_ID=workspace-uuid     # Default workspace for operations

# Startup auth behavior (optional)
# AFFINE_LOGIN_AT_START=async           # Default: async (don't block MCP handshake)
# AFFINE_LOGIN_AT_START=sync            # Block at startup to sign in with email/password
```

Authentication priority:
1) `AFFINE_API_TOKEN` → 2) `AFFINE_COOKIE` → 3) `AFFINE_EMAIL` + `AFFINE_PASSWORD`

## Quick Start

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
        "AFFINE_BASE_URL": "https://your-affine-instance.com",
        "AFFINE_EMAIL": "you@example.com",
        "AFFINE_PASSWORD": "secret!",
        "AFFINE_LOGIN_AT_START": "async"
      }
    }
  }
}
```

Tips
- Prefer `AFFINE_COOKIE` or `AFFINE_API_TOKEN` for zero‑latency startup.
- If your password contains `!` (zsh history expansion), wrap it in single quotes in shells or use the JSON config above.

### Codex CLI

Register the MCP server with Codex:

- Global install path (fastest)
  - `npm i -g affine-mcp-server`
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' --env AFFINE_LOGIN_AT_START=async -- affine-mcp`

- Use npx (no global install)
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' --env AFFINE_LOGIN_AT_START=async -- npx -y -p affine-mcp-server affine-mcp`

- Token or cookie (no startup login)
  - Token: `codex mcp add affine --env AFFINE_BASE_URL=https://... --env AFFINE_API_TOKEN=... -- affine-mcp`
  - Cookie: `codex mcp add affine --env AFFINE_BASE_URL=https://... --env "AFFINE_COOKIE=affine_session=...; affine_csrf=..." -- affine-mcp`

Notes
- MCP name: `affine`
- Command: `affine-mcp`
- Environment: `AFFINE_BASE_URL` + one auth method (`AFFINE_API_TOKEN` | `AFFINE_COOKIE` | `AFFINE_EMAIL`/`AFFINE_PASSWORD`)

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
- `search_docs` – search documents by keyword
- `recent_docs` – list recently updated documents
- `publish_doc` – make document public
- `revoke_doc` – revoke public access
- `create_doc` – create a new document (WebSocket)
- `append_paragraph` – append a paragraph block (WebSocket)
- `delete_doc` – delete a document (WebSocket)

### Comments
- `list_comments`, `create_comment`, `update_comment`, `delete_comment`, `resolve_comment`

### Version History
- `list_histories`, `recover_doc`

### Users & Tokens
- `current_user`, `sign_in`, `update_profile`, `update_settings`
- `list_access_tokens`, `generate_access_token`, `revoke_access_token`

### Notifications
- `list_notifications`, `read_notification`, `read_all_notifications`

### Blob Storage
- `upload_blob`, `delete_blob`, `cleanup_blobs`

### Advanced
- `apply_doc_updates` – apply CRDT updates to documents

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

## Troubleshooting

Authentication
- Email/Password: ensure your instance allows password auth and credentials are valid
- Cookie: copy cookies (e.g., `affine_session`, `affine_csrf`) from the browser DevTools after login
- Token: generate a personal access token; verify it hasn’t expired
- If using Email/Password and your MCP client shows a startup timeout, ensure `AFFINE_LOGIN_AT_START=async` (default) so login happens after the stdio handshake.

Connection
- Confirm `AFFINE_BASE_URL` is reachable
- GraphQL endpoint default is `/graphql`
- Check firewall/proxy rules; verify CORS if self‑hosted

## Security Considerations

- Never commit `.env` with secrets
- Prefer environment variables in production
- Rotate access tokens regularly
- Use HTTPS
- Store credentials in a secrets manager

## Version History

### 1.2.1 (2025‑09‑17)
- Default to asynchronous email/password login after MCP stdio handshake
- New `AFFINE_LOGIN_AT_START` env (`async` default, `sync` to block at startup)
- Expanded docs for Codex/Claude using npm, npx, and local clone

### 1.2.0 (2025‑09‑16)
- WebSocket-based document tools: `create_doc`, `append_paragraph`, `delete_doc` (create/edit/delete now supported)
- Tool aliases: both `affine_*` and non‑prefixed names
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
1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Ensure all tests pass
5. Submit a Pull Request

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
