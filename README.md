[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/dawncr0w-affine-mcp-server-badge.png)](https://mseep.ai/app/dawncr0w-affine-mcp-server)

# AFFiNE MCP Server

A Model Context Protocol (MCP) server for AFFiNE. It exposes AFFiNE workspaces and documents to AI assistants over stdio (default) or HTTP (`/mcp`) and supports both AFFiNE Cloud and self-hosted deployments.

[![Version](https://img.shields.io/badge/version-1.13.0-blue)](https://github.com/dawncr0w/affine-mcp-server/releases)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.17.2-green)](https://github.com/modelcontextprotocol/typescript-sdk)
[![CI](https://github.com/dawncr0w/affine-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/dawncr0w/affine-mcp-server/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

<a href="https://glama.ai/mcp/servers/@DAWNCR0W/affine-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@DAWNCR0W/affine-mcp-server/badge" alt="AFFiNE Server MCP server" />
</a>

## Table of Contents

- [Overview](#overview)
- [Choose Your Path](#choose-your-path)
- [Quick Start](#quick-start)
- [Compatibility Matrix](#compatibility-matrix)
- [Tool Surface](#tool-surface)
- [Documentation Map](#documentation-map)
- [Verify Your Setup](#verify-your-setup)
- [Security and Scope](#security-and-scope)
- [Development](#development)
- [Release Notes](#release-notes)
- [License](#license)
- [Support](#support)

## Overview

AFFiNE MCP Server is designed for three common scenarios:

- Run a local stdio MCP server for Claude Code, Codex CLI, Cursor, or Claude Desktop
- Expose a remote HTTP MCP endpoint for hosted or browser-connected clients
- Automate AFFiNE workspace, document, database, organization, and comment workflows through a stable MCP tool surface

Highlights:

- Supports AFFiNE Cloud and self-hosted AFFiNE instances
- Supports stdio and HTTP transports
- Supports token, cookie, and email/password authentication
- Exposes 87 canonical MCP tools backed by AFFiNE GraphQL and WebSocket APIs
- Includes semantic page composition, native template instantiation, database intent composition, capability and fidelity reporting, and workspace blueprint helpers
- Includes Docker images, health probes, and end-to-end test coverage

Scope boundaries:

- This server can access only server-backed AFFiNE workspaces
- Browser-local workspaces stored only in local storage are not available through AFFiNE server APIs
- AFFiNE Cloud requires API-token-based access for MCP usage; programmatic email/password sign-in is blocked by Cloudflare

> New in v1.13.0: Added high-level semantic page, native template, fidelity, and workspace blueprint workflows, plus structured receipts and productized setup docs.

## Choose Your Path

| Goal | Start here |
| --- | --- |
| Set up a local stdio server with the least friction | [docs/getting-started.md](docs/getting-started.md) |
| Run the server in Docker or another OCI runtime | [docs/getting-started.md#path-c-run-from-the-docker-image](docs/getting-started.md#path-c-run-from-the-docker-image) |
| Configure Claude Code, Claude Desktop, Codex CLI, or Cursor | [docs/client-setup.md](docs/client-setup.md) |
| Run the server remotely over HTTP or behind OAuth | [docs/configuration-and-deployment.md](docs/configuration-and-deployment.md) |
| Lock down tool exposure for least-privilege deployments | [docs/configuration-and-deployment.md#least-privilege-tool-exposure](docs/configuration-and-deployment.md#least-privilege-tool-exposure) |
| Learn common AFFiNE workflows and tool sequences | [docs/workflow-recipes.md](docs/workflow-recipes.md) |
| Browse the tool catalog by domain | [docs/tool-reference.md](docs/tool-reference.md) |

## Quick Start

### 1. Install the CLI

```bash
npm i -g affine-mcp-server
affine-mcp --version
```

You can also run the package ad hoc:

```bash
npx -y -p affine-mcp-server affine-mcp -- --version
```

### 2. Or run the server in Docker

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

Then point your client at:

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

For Docker, health checks, and remote deployment details, see [docs/configuration-and-deployment.md#docker](docs/configuration-and-deployment.md#docker).

### 3. Save credentials with interactive login

```bash
affine-mcp login
```

This stores credentials in `~/.config/affine-mcp/config` with mode `600`.

- For AFFiNE Cloud, use an API token from `Settings -> Integrations -> MCP Server`
- For self-hosted AFFiNE, you can use either an API token or email/password

### 4. Register the server with your client

Claude Code project config:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp"
    }
  }
}
```

Codex CLI:

```bash
codex mcp add affine -- affine-mcp
```

More client-specific setup is in [docs/client-setup.md](docs/client-setup.md).

### 5. Verify the connection

```bash
affine-mcp status
affine-mcp doctor
```

If you want to expose the server remotely over HTTP instead of stdio, start with [docs/configuration-and-deployment.md](docs/configuration-and-deployment.md).

## Compatibility Matrix

| Target | Transport | Recommended auth | Recommended path |
| --- | --- | --- | --- |
| Claude Code | stdio | Saved config or API token | [docs/client-setup.md#claude-code](docs/client-setup.md#claude-code) |
| Claude Desktop | stdio | Saved config or API token | [docs/client-setup.md#claude-desktop](docs/client-setup.md#claude-desktop) |
| Codex CLI | stdio | Saved config or API token | [docs/client-setup.md#codex-cli](docs/client-setup.md#codex-cli) |
| Cursor | stdio | Saved config or API token | [docs/client-setup.md#cursor](docs/client-setup.md#cursor) |
| Containerized remote deployment | HTTP | Bearer token or OAuth | [docs/getting-started.md#path-c-run-from-the-docker-image](docs/getting-started.md#path-c-run-from-the-docker-image) |
| Remote MCP clients | HTTP | Bearer token or OAuth | [docs/configuration-and-deployment.md#http-mode](docs/configuration-and-deployment.md#http-mode) |
| AFFiNE Cloud | stdio or HTTP | API token | [docs/configuration-and-deployment.md#auth-strategy-matrix](docs/configuration-and-deployment.md#auth-strategy-matrix) |
| Self-hosted AFFiNE | stdio or HTTP | API token, cookie, or email/password | [docs/configuration-and-deployment.md#auth-strategy-matrix](docs/configuration-and-deployment.md#auth-strategy-matrix) |

## Tool Surface

`tool-manifest.json` is the source of truth for canonical tool names. The MCP server exposes those tools through `tools/list` and `tools/call`.

Domains:

- Workspace: create, inspect, update, delete, and traverse workspaces
- Organization: collections, collection-rule sync, workspace blueprints, and experimental organize or folder helpers
- Documents: search, read, create, publish, move, tag, import/export, semantic composition, template inspection and native instantiation, capability and fidelity reporting, and text mutation
- Databases: create columns, add rows, update cells, inspect schema, and compose database structures from intent
- Comments: list, create, update, delete, resolve, and list unresolved threads
- History: version history listing
- Users and tokens: current user, sign-in, profile/settings, personal access tokens
- Notifications: list and mark notifications as read
- Blob storage: upload, delete, and cleanup blobs

For the grouped catalog, notes, and operational caveats, see [docs/tool-reference.md](docs/tool-reference.md).

## Documentation Map

| Document | Purpose |
| --- | --- |
| [docs/getting-started.md](docs/getting-started.md) | First-run setup paths and verification |
| [docs/client-setup.md](docs/client-setup.md) | Client-specific configuration snippets and tips |
| [docs/configuration-and-deployment.md](docs/configuration-and-deployment.md) | Environment variables, auth modes, Docker, HTTP mode, and deployment guidance |
| [docs/workflow-recipes.md](docs/workflow-recipes.md) | End-to-end workflows and example tool sequences |
| [docs/tool-reference.md](docs/tool-reference.md) | Tool catalog grouped by domain |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor workflow |
| [SECURITY.md](SECURITY.md) | Security reporting |

## Verify Your Setup

Useful CLI commands:

- `affine-mcp status` - test the effective configuration
- `affine-mcp status --json` - machine-readable status output
- `affine-mcp doctor` - diagnose config and connectivity issues
- `affine-mcp show-config` - print the effective config with secrets redacted
- `affine-mcp config-path` - print the config file path
- `affine-mcp snippet <claude|cursor|codex|all> [--env]` - generate ready-to-paste client config
- `affine-mcp logout` - remove stored credentials

For common failures, see:

- [docs/getting-started.md#common-first-run-failures](docs/getting-started.md#common-first-run-failures)
- [docs/configuration-and-deployment.md#deployment-checklist](docs/configuration-and-deployment.md#deployment-checklist)

## Security and Scope

- Never commit secrets or long-lived tokens
- Prefer API tokens over cookies or passwords in production
- Use HTTPS for non-local deployments
- Rotate access tokens regularly
- Restrict exposed tools with `AFFINE_DISABLED_GROUPS` and `AFFINE_DISABLED_TOOLS` for least-privilege setups
- Use `/healthz` and `/readyz` when running the HTTP server behind a container platform or load balancer

## Development

Run the main quality gates before opening a PR:

```bash
npm run build
npm run test:tool-manifest
npm run pack:check
```

Additional validation:

- `npm run test:comprehensive` boots a local Docker AFFiNE stack and validates the tool surface
- `npm run test:e2e` runs Docker, MCP, and Playwright together
- `npm run test:playwright` runs the Playwright suite only
- Focused runners for the new high-level tool surface include `npm run test:create-placement`, `npm run test:capabilities-fidelity`, `npm run test:native-template`, `node tests/test-database-intent.mjs`, `node tests/test-semantic-page-composer.mjs`, `node tests/test-structured-receipts.mjs`, `node tests/test-organize-tools.mjs`, and `node tests/test-supporting-tools.mjs`

Local clone flow:

```bash
git clone https://github.com/dawncr0w/affine-mcp-server.git
cd affine-mcp-server
npm install
npm run build
node dist/index.js
```

## Release Notes

- [CHANGELOG.md](CHANGELOG.md)
- [RELEASE_NOTES.md](RELEASE_NOTES.md)
- [GitHub Releases](https://github.com/dawncr0w/affine-mcp-server/releases)

## License

MIT License - see [LICENSE](LICENSE).

## Support

- Open an issue on [GitHub](https://github.com/dawncr0w/affine-mcp-server/issues)
- Review AFFiNE product documentation at [docs.affine.pro](https://docs.affine.pro)

## Acknowledgments

- Built for the [AFFiNE](https://affine.pro) knowledge base platform
- Uses the [Model Context Protocol](https://modelcontextprotocol.io) specification
- Powered by [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
