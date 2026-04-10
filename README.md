# AFFiNE MCP Server

A Model Context Protocol (MCP) server that integrates with AFFiNE (self‑hosted or cloud). It exposes AFFiNE workspaces and documents to AI assistants over stdio (default) or HTTP (`/mcp`).

[![Version](https://img.shields.io/badge/version-1.12.0-blue)](https://github.com/dawncr0w/affine-mcp-server/releases)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.17.2-green)](https://github.com/modelcontextprotocol/typescript-sdk)
[![CI](https://github.com/dawncr0w/affine-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/dawncr0w/affine-mcp-server/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

<a href="https://glama.ai/mcp/servers/@DAWNCR0W/affine-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@DAWNCR0W/affine-mcp-server/badge" alt="AFFiNE Server MCP server" />
</a>

## Overview

- Purpose: Manage AFFiNE workspaces and documents through MCP
- Transport: stdio (default) and optional HTTP (`/mcp`) for remote MCP deployments
- Auth: Token, Cookie, or Email/Password (priority order)
- Tools: 76 focused tools with WebSocket-based document editing
- Status: Active
 
> New in v1.12.0: Added linked documents on database rows, restored MCP CRUD for rows created in the AFFiNE UI, fixed self-hosted table exports, and documented GHCR Docker releases.

## Features

- Workspace: create (with initial doc), read, update, delete
- Documents: list/get/read/publish/revoke + create/append/replace/delete + markdown import/export + tags (WebSocket‑based)
- Sidebar data: collections, folders, and organize links for AFFiNE workspace trees
- Database workflows: create database blocks, inspect schema, add/update/delete rows, and read or update cell values via MCP tools
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
- `affine-mcp --help` / `-h` / `help` — show command help
- `affine-mcp status` — show current config and test connection
- `affine-mcp status --json` — machine-readable status output
- `affine-mcp doctor` — run config and connectivity diagnostics
- `affine-mcp show-config` — print the effective config with secrets redacted
- `affine-mcp config-path` — print the config file path
- `affine-mcp snippet <claude|cursor|codex|all> [--env]` — print ready-to-paste client configuration snippets
- `affine-mcp logout` — remove stored credentials
- `affine-mcp --version` / `-v` / `version` — print the installed CLI version and exit

Non-interactive login helpers:
- `affine-mcp login --url <url> --token <token> --workspace-id <id> --force`

### Environment variables

You can also configure via environment variables (they override the config file):

- Required: `AFFINE_BASE_URL`
- Auth (choose one): `AFFINE_API_TOKEN` | `AFFINE_COOKIE` | `AFFINE_EMAIL` + `AFFINE_PASSWORD`
- Optional: `AFFINE_GRAPHQL_PATH` (default `/graphql`), `AFFINE_WORKSPACE_ID`, `AFFINE_LOGIN_AT_START` (set `sync` only when you must block startup)
- Tool filtering: `AFFINE_DISABLED_GROUPS`, `AFFINE_DISABLED_TOOLS` (see [Filtering Exposed Tools](#filtering-exposed-tools))

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
        "AFFINE_PASSWORD": "secret!"
      }
    }
  }
}
```

Tips
- Prefer `affine-mcp login` or `AFFINE_API_TOKEN` for zero‑latency startup.
- If your password contains `!` (zsh history expansion), wrap it in single quotes in shells or use the JSON config above.
- `affine-mcp doctor` is the fastest way to confirm that your saved config still works.
- `affine-mcp snippet claude --env` and `affine-mcp snippet codex --env` can generate ready-to-paste client setup from your current config.
- `affine-mcp snippet all --env` prints Claude, Cursor, and Codex setup in one shot.

### Codex CLI

Register the MCP server with Codex:

- With config file (after `affine-mcp login`):
  - `codex mcp add affine -- affine-mcp`

- With API token:
  - `codex mcp add affine --env AFFINE_BASE_URL=https://app.affine.pro --env AFFINE_API_TOKEN=ut_xxx -- affine-mcp`

- With email/password (self-hosted only):
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-self-hosted-affine.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' -- affine-mcp`

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

### Docker

Pre-built multi-arch images (`linux/amd64`, `linux/arm64`) are published to the GitHub Container Registry on every release tag:

```
ghcr.io/dawncr0w/affine-mcp-server:latest      # latest release
ghcr.io/dawncr0w/affine-mcp-server:1.12.0      # specific version
```

Quick start:

```bash
docker run -d \
  -p 3000:3000 \
  -e AFFINE_BASE_URL=https://your-affine-instance.com \
  -e AFFINE_API_TOKEN=ut_your_token \
  -e AFFINE_MCP_HTTP_TOKEN=your-strong-secret \
  ghcr.io/dawncr0w/affine-mcp-server:latest
```

Then add to your MCP client config:

```json
{
  "mcpServers": {
    "affine": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer your-strong-secret" }
    }
  }
}
```

The container runs as a non-root user and exposes `/healthz` and `/readyz` for liveness/readiness probes.

### Remote Server

If you want to host the server remotely (e.g., using Render, Railway, Docker, or a VPS) and connect via HTTP MCP (Streamable HTTP on `/mcp`) instead of local `stdio`, run the server in HTTP mode.

#### Environment variables (HTTP mode)

Required:
- `MCP_TRANSPORT=http`
- `AFFINE_BASE_URL` (example: `https://app.affine.pro`)
- `AFFINE_MCP_AUTH_MODE=bearer` (default) or `AFFINE_MCP_AUTH_MODE=oauth`

Bearer mode backend auth:
- `AFFINE_API_TOKEN` (recommended), or `AFFINE_COOKIE`, or `AFFINE_EMAIL` + `AFFINE_PASSWORD`

OAuth mode backend auth:
- `AFFINE_API_TOKEN` (required service credential for AFFiNE backend access)

Recommended for remote/public deployments:
- `AFFINE_MCP_HTTP_HOST=0.0.0.0`
- `AFFINE_MCP_HTTP_ALLOWED_ORIGINS=<comma-separated-origins>` (for browser clients)

Optional:
- `PORT` (defaults to `3000`; many platforms like Render inject this automatically)
- `AFFINE_WORKSPACE_ID`
- `AFFINE_GRAPHQL_PATH` (defaults to `/graphql`)
- `AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS=true` (testing only)

Bearer-mode only:
- `AFFINE_MCP_HTTP_TOKEN=<strong-random-token>` (protects `/mcp`, `/sse`, `/messages`)

OAuth-mode only:
- `AFFINE_MCP_PUBLIC_BASE_URL=https://mcp.yourdomain.com`
- `AFFINE_OAUTH_ISSUER_URL=https://auth.yourdomain.com`
- `AFFINE_OAUTH_SCOPES=mcp` (defaults to `mcp`)

#### HTTP auth modes

`AFFINE_MCP_AUTH_MODE=bearer` keeps the current static bearer-token behavior.

```bash
export MCP_TRANSPORT=http
export AFFINE_MCP_AUTH_MODE=bearer
export AFFINE_API_TOKEN="your_token..."
export AFFINE_MCP_HTTP_HOST="0.0.0.0"
export AFFINE_MCP_HTTP_TOKEN="your-super-secret-token"
export PORT=3000

npm run start:http
```

`AFFINE_MCP_AUTH_MODE=oauth` turns the MCP endpoint into an OAuth-protected resource for web MCP clients. In this mode:
- the server exposes `/.well-known/oauth-protected-resource`
- unauthenticated `/mcp` requests return `401` with a `WWW-Authenticate` challenge
- `AFFINE_MCP_HTTP_TOKEN` and `?token=` are disabled
- `sign_in` is not registered
- `AFFINE_API_TOKEN` is still required so the server can call AFFiNE as a service credential

```bash
export MCP_TRANSPORT=http
export AFFINE_MCP_AUTH_MODE=oauth
export AFFINE_API_TOKEN="your-affine-service-token"
export AFFINE_MCP_HTTP_HOST="0.0.0.0"
export AFFINE_MCP_PUBLIC_BASE_URL="https://mcp.yourdomain.com"
export AFFINE_OAUTH_ISSUER_URL="https://auth.yourdomain.com"
export AFFINE_OAUTH_SCOPES="mcp"
export PORT=3000

npm run start:http
```

Notes for OAuth mode:
- use HTTPS for non-local deployments
- `AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS=true` is rejected in OAuth mode
- tokens are validated against the issuer discovery metadata and JWKS
- the protected resource metadata is also served at `/.well-known/oauth-protected-resource/mcp` for path-specific discovery
- `GET /healthz` and `GET /readyz` are available for deployment diagnostics

#### Recommended presets

Local testing (HTTP mode):
- `MCP_TRANSPORT=http`
- `AFFINE_MCP_AUTH_MODE=bearer`
- `AFFINE_MCP_HTTP_HOST=127.0.0.1`
- `AFFINE_MCP_HTTP_TOKEN=<token>` (recommended even locally)
- `AFFINE_MCP_HTTP_ALLOWED_ORIGINS=http://localhost:3000` (if testing from a browser app)

Docker / container runtime:
- `MCP_TRANSPORT=http`
- `AFFINE_MCP_AUTH_MODE=bearer`
- `AFFINE_MCP_HTTP_HOST=0.0.0.0`
- `PORT=3000` (or container/platform port)
- `AFFINE_MCP_HTTP_TOKEN=<strong-token>`
- `AFFINE_MCP_HTTP_ALLOWED_ORIGINS=<your app origin(s)>`

Render / Railway / VPS (public endpoint):
- `MCP_TRANSPORT=http`
- `AFFINE_MCP_AUTH_MODE=bearer` or `oauth`
- `AFFINE_MCP_HTTP_HOST=0.0.0.0`
- `AFFINE_MCP_HTTP_TOKEN=<strong-token>` (bearer mode)
- `AFFINE_MCP_PUBLIC_BASE_URL=<public base URL>` (OAuth mode)
- `AFFINE_OAUTH_ISSUER_URL=<issuer URL>` (OAuth mode)
- `AFFINE_MCP_HTTP_ALLOWED_ORIGINS=<your client origin(s)>`

Endpoints currently available:
- `/mcp` - MCP server (Streamable HTTP)
- `/sse` - SSE endpoint (old protocol compatible)
- `/messages` - Messages endpoint (old protocol compatible)
- `/healthz` - HTTP liveness probe
- `/readyz` - HTTP readiness probe


## Available Tools

### Workspace
- `list_workspaces` – list all workspaces
- `get_workspace` – get workspace details
- `create_workspace` – create workspace with initial document
- `update_workspace` – update workspace settings
- `delete_workspace` – delete workspace permanently
- `list_workspace_tree` – return the workspace document hierarchy as a tree
- `get_orphan_docs` – find documents that are not linked from any parent doc in the sidebar tree

### Organization
- `list_collections` – list workspace collections
- `get_collection` – get a collection by id
- `create_collection` – create a collection
- `update_collection` – rename a collection
- `delete_collection` – delete a collection
- `add_doc_to_collection` – add a document to a collection allow-list
- `remove_doc_from_collection` – remove a document from a collection allow-list
- `list_organize_nodes` – experimental organize/folder tree dump
- `create_folder` – experimental root or nested folder creation
- `rename_folder` – experimental folder rename
- `delete_folder` – experimental recursive folder delete
- `move_organize_node` – experimental folder/link move
- `add_organize_link` – experimental doc/tag/collection link under a folder
- `delete_organize_link` – experimental doc/tag/collection link delete


### Documents
- `list_docs` – list documents with pagination (includes `node.tags`)
- `list_tags` – list all tags in a workspace
- `search_docs` – fast title search with substring/prefix/exact matching, optional tag filtering, and updatedAt sorting
- `list_docs_by_tag` – list documents that contain the requested tag
- `get_docs_by_tag` – discover documents by case-insensitive tag substring and return `availableTags` when nothing matches
- `get_doc` – get document metadata
- `get_doc_by_title` – find a document by title and return its Markdown content
- `read_doc` – read document block content and plain text snapshot (WebSocket)
- `export_doc_markdown` – export document content as markdown
- `publish_doc` – make document public
- `revoke_doc` – revoke public access
- `create_doc` – create a new document (WebSocket)
- `create_doc_from_markdown` – create a document from markdown content
- `create_doc_from_template` – clone a template doc, substitute `{{variables}}`, and optionally link it under a parent doc
- `duplicate_doc` – clone a document into a new doc, optionally under a parent doc
- `create_tag` – create a reusable workspace-level tag
- `add_tag_to_doc` – attach a tag to a document
- `remove_tag_from_doc` – detach a tag from a document
- `update_doc_title` – rename a document in both workspace metadata and the internal page block
- `append_paragraph` – append a paragraph block (WebSocket)
- `append_block` – append canonical block types (text/list/code/media/embed/database/edgeless) with strict validation and placement control (`viewMode=kanban` enables preset-backed data views; `data_view` defaults to kanban)
- `create_semantic_page` – create an AFFiNE-native page with an intentional section skeleton and native block composition
- `append_semantic_section` – append a semantic section to an existing page by heading title
- `move_doc` – move a document in the sidebar by relinking it under a different parent
- `batch_create_docs` – create up to 20 documents in a single call
- `add_database_column` – add a column to a database block (`rich-text`, `select`, `multi-select`, `number`, `checkbox`, `link`, `date`)
- `add_database_row` – add a row to a database block with values mapped by column name/ID (`title` / `Title` updates the built-in row title)
- `delete_database_row` – delete a row from a database block by row block id
- `read_database_columns` – read database schema metadata including column IDs/types, select options, and table view column mappings
- `read_database_cells` – read row titles plus decoded database cell values with optional row / column filters
- `update_database_cell` – update a single database cell or the built-in row title (`createOption` defaults to `true` for select fields)
- `update_database_row` – batch update multiple cells on a database row (`createOption` defaults to `true` for select fields)
- `append_markdown` – append markdown content to an existing document
- `replace_doc_with_markdown` – replace the main note content with markdown content
- `list_children` – list the direct child docs linked from a document
- `list_backlinks` – list the parent/reference docs that link to a document
- `cleanup_orphan_embeds` – remove linked-doc embeds that point to missing docs
- `find_and_replace` – preview or apply text replacement across a document
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

## Filtering Exposed Tools

Optional environment variables to narrow the exposed surface. 

### Group-level — `AFFINE_DISABLED_GROUPS`

| Group name | Tools included |
|---|---|
| `workspaces` | `list_workspaces`, `get_workspace`, `create_workspace`, `update_workspace`, `delete_workspace` |
| `docs` | `list_docs`, `read_doc`, `search_docs`, `create_doc`, `create_semantic_page`, `append_semantic_section`, `create_doc_from_markdown`, `create_doc_from_template`, `duplicate_doc`, `append_paragraph`, `append_block`, `append_markdown`, `replace_doc_with_markdown`, `delete_doc`, `publish_doc`, `revoke_doc`, `list_tags`, `list_docs_by_tag`, `create_tag`, `add_tag_to_doc`, `remove_tag_from_doc`, `list_workspace_tree`, `get_orphan_docs`, `list_children`, `update_doc_title`, `get_doc_by_title`, `get_docs_by_tag`, `list_backlinks`, `move_doc`, `batch_create_docs`, `cleanup_orphan_embeds`, `find_and_replace`, `add_database_column`, `add_database_row`, `delete_database_row`, `read_database_columns`, `read_database_cells`, `update_database_cell`, `update_database_row` |
| `comments` | `list_comments`, `create_comment`, `update_comment`, `delete_comment`, `resolve_comment` |
| `history` | `list_histories` |
| `organize` | `list_collections`, `get_collection`, `create_collection`, `update_collection`, `delete_collection`, `add_doc_to_collection`, `remove_doc_from_collection`, `list_organize_nodes`, `create_folder`, `rename_folder`, `delete_folder`, `move_organize_node`, `add_organize_link`, `delete_organize_link` |
| `users` | `current_user`, `sign_in`, `update_profile`, `update_settings` |
| `access_tokens` | `list_access_tokens`, `generate_access_token`, `revoke_access_token` |
| `blobs` | `upload_blob`, `delete_blob`, `cleanup_blobs` |
| `notifications` | `list_notifications`, `read_all_notifications` |

```json
"env": {
  "AFFINE_DISABLED_GROUPS": "comments,history,blobs,users"
}
```

### Tool-level — `AFFINE_DISABLED_TOOLS`

Disables individual tools by exact name (comma-separated). 

```json
"env": {
  "AFFINE_DISABLED_TOOLS": "delete_workspace,delete_doc"
}
```

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
- For full tool-surface verification, run `npm run test:comprehensive` (self-bootstraps a local Docker AFFiNE stack).
- For pre-provisioned environments, use `npm run test:comprehensive:raw`.
- For full environment verification, run `npm run test:e2e` (Docker + MCP + Playwright).
- Additional focused runners: `npm run test:db-create`, `npm run test:db-cells`, `npm run test:db-schema`, `npm run test:supporting-tools`, `npm run test:organize`, `npm run test:bearer`, `npm run test:http-email-password`, `npm run test:http-bearer`, `npm run test:oauth-http`, `npm run test:doc-discovery`, `npm run test:cli-version`, `npm run test:cli-commands`, `npm run test:cli-live`, `npm run test:tool-filtering`, `npm run test:markdown-rich-text-import`, `npm run test:playwright`.

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

## Release Notes

- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Release notes: [RELEASE_NOTES.md](RELEASE_NOTES.md)
- GitHub Releases: [Releases](https://github.com/dawncr0w/affine-mcp-server/releases)

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
