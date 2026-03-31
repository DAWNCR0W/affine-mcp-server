# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes yet.

## [1.11.2] - 2026-03-31

### Fixed
- `list_docs` now filters out deleted documents that briefly remain in GraphQL edges after workspace metadata has already dropped them.
- Completed the delete/list_docs hardening introduced in `v1.11.1` so the visible edge list, `totalCount`, and `endCursor` stay aligned after `delete_doc`.

### Tests
- Re-ran live delete/list regression coverage against Dockerized AFFiNE `0.26.4` with `tests/test-doc-discovery.mjs`.

## [1.11.1] - 2026-03-31

### Fixed
- `list_docs` now clamps stale `totalCount` metadata after `delete_doc` removes a document but AFFiNE GraphQL still reports the pre-delete count.
- `list_docs.pageInfo.endCursor` now aligns with the last returned edge cursor after delete-driven metadata drift.

### Tests
- Added live regression coverage for delete/list count correction in `tests/test-doc-discovery.mjs`.

## [1.11.0] - 2026-03-27

### Added
- Sidebar organize workflows:
  - `list_collections`
  - `get_collection`
  - `create_collection`
  - `update_collection`
  - `delete_collection`
  - `add_doc_to_collection`
  - `remove_doc_from_collection`
  - `list_organize_nodes`
  - `create_folder`
  - `rename_folder`
  - `delete_folder`
  - `move_organize_node`
  - `add_organize_link`
  - `delete_organize_link`
- Tool filtering controls:
  - `AFFINE_DISABLED_GROUPS`
  - `AFFINE_DISABLED_TOOLS`
- `delete_database_row` to remove existing rows from AFFiNE database blocks.

### Changed
- Tool surface expanded from 61 to 76 canonical tools.
- Markdown import now preserves inline rich-text marks in list items and table cells.
- CLI setup now supports non-interactive login with `affine-mcp login --url ... --token ... --workspace-id ... --force`.
- `affine-mcp status --json` now returns machine-readable connection details.
- `affine-mcp snippet all --env` now prints Claude, Cursor, and Codex setup in a single response.
- README and release-facing docs now describe organize tools, tool filtering, and the new database row delete workflow.

### Fixed
- Table-cell and list-item markdown imports no longer keep literal `**...**` markers when AFFiNE rich-text attributes should be written.

### Dependencies
- Refreshed GitHub Actions, runtime lockfile entries, and development tooling, including `actions/github-script`, `jose`, `@modelcontextprotocol/sdk`, `undici`, `yjs`, `typescript`, and `@types/node`.

## [1.10.1] - 2026-03-18

### Changed
- Refreshed packaged `README.md` and release metadata so the published v1.10.x docs match the shipped toolset.
- `.github/workflows/npm-publish.yml` now runs Docker-backed `npm run test:e2e` before `npm publish`.
- `CONTRIBUTING.md` now documents the release workflow and the `RELEASE_NOTES.md` source-of-truth convention.

## [1.10.0] - 2026-03-18

### Added
- Document discovery and navigation workflows:
  - `search_docs`
  - `get_doc_by_title`
  - `get_docs_by_tag`
  - `list_children`
  - `list_backlinks`
  - `get_orphan_docs`
  - `list_workspace_tree`
- Document utility workflows:
  - `batch_create_docs`
  - `create_doc_from_template`
  - `duplicate_doc`
  - `move_doc`
  - `cleanup_orphan_embeds`
  - `find_and_replace`
  - `update_doc_title`
- Optional OAuth-protected HTTP mode for remote MCP deployments.
- Focused HTTP transport regression coverage for bearer, OAuth, and email/password multi-session flows.

### Changed
- Toolset expanded from 47 to 61 canonical tools.
- CLI usability and setup guidance improved with richer diagnostics and ready-to-paste config snippets.
- `test:e2e` now validates HTTP email/password multi-session auth alongside bearer and OAuth HTTP coverage.

### Fixed
- `list_docs` titles are restored from workspace metadata snapshots.
- HTTP transport now preserves email/password credentials across fresh sessions so repeated Streamable HTTP connections can re-authenticate successfully.

## [1.9.0] - 2026-03-10

### Added
- `read_database_columns` to expose database schema metadata for empty or sparsely populated AFFiNE databases.
- Preset-backed `data_view` creation for kanban-oriented AFFiNE database views.
- Focused supporting-tools regression coverage via `npm run test:supporting-tools`.
- Markdown callout round-trips for admonition-style import/export flows.

### Changed
- `test:comprehensive` now self-bootstraps a local Docker AFFiNE stack and provides a raw mode for pre-provisioned environments.
- `test:e2e` now isolates Docker stacks per run and seeds data-view state before Playwright verification.
- README release history was trimmed in favor of dedicated changelog and release-note sources.

### Fixed
- Empty database workflows no longer depend on existing rows to discover column names, IDs, types, and view mappings.
- Reduced Docker bootstrap flakiness in the E2E pipeline by isolating Compose projects and staging startup checks.
- Prevented the E2E Playwright suite from failing on missing `test-data-view-state.json` by adding the data-view setup phase.

## [1.8.0] - 2026-03-09

### Added
- Database cell workflows:
  - `read_database_cells`
  - `update_database_cell`
  - `update_database_row`
- CLI version commands:
  - `affine-mcp --version`
  - `affine-mcp -v`
  - `affine-mcp version`
- Focused regression runners:
  - `npm run test:db-cells`
  - `npm run test:cli-version`

### Changed
- Tool surface expanded from 43 to 46 canonical tools.
- Database workflows now support row title persistence and cell-level sync for Kanban-oriented databases.
- README and release documentation now describe the new database cell workflows and CLI version support.

### Fixed
- `add_database_row` now persists `title` / `Title` into the built-in row paragraph used by AFFiNE Kanban card headers.
- CLI version handling now exits early without starting the server, including forwarded wrapper args such as `affine-mcp -- --version`.

## [1.7.2] - 2026-03-04

### Added
- Tag visibility regression coverage in Docker E2E:
  - MCP setup scenario: `tests/test-tag-visibility.mjs`
  - Playwright UI verification: `tests/playwright/verify-tag-visibility.pw.ts`
- Docker E2E credential bootstrap retry controls:
  - `AFFINE_HEALTH_MAX_RETRIES`
  - `AFFINE_HEALTH_INTERVAL_MS`
  - `AFFINE_CREDENTIAL_ACQUIRE_RETRIES`
  - `AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS`

### Changed
- Tag persistence now aligns with AFFiNE tag option schema by storing canonical tag option IDs and normalizing legacy tag entries.
- Tag-facing tool outputs now resolve option IDs back to labels for stable UX parity (`read_doc`, `list_docs`, `list_tags`, `list_docs_by_tag`, markdown export).
- Docker E2E credential bootstrap now emits health-check configuration and retries credential acquisition before failing.

### Fixed
- Resolved issue where tags persisted via MCP were not visible in the AFFiNE UI.
- Reduced CI flakiness from transient AFFiNE container startup timing by adding retry and on-failure Docker diagnostics.

## [1.7.1] - 2026-03-03

### Changed
- MCP-created document block hierarchy now follows AFFiNE UI parity by writing `sys:parent` as `null` and relying on `sys:children` relationships.
- Placement resolution for `append_block` (`beforeBlockId` / `afterBlockId`) now resolves parent context from child links when `sys:parent` is null.
- Workspace bootstrap document blocks were aligned to the same null-parent shape for consistency.

### Fixed
- Resolved UI invisibility/inconsistency risk for MCP-created docs caused by parent linkage mismatch versus UI-created docs.
- Fixed callout rendering parity by creating/storing callout text in a child paragraph block so text is visible in AFFiNE UI.
- Added regression assertions in Docker E2E scripts to verify null-parent structure after `create_doc`, `append_paragraph`, and `create_doc_from_markdown`.

## [1.7.0] - 2026-02-27

### Added
- Optional HTTP deployment mode with Streamable HTTP endpoint `/mcp` and backward-compatible legacy endpoints (`/sse`, `/messages`) for remote MCP clients.
- New `start:http` npm script (`MCP_TRANSPORT=http node dist/index.js`) for one-command HTTP mode startup.
- HTTP runtime dependencies and typings for remote hosting (`express`, `cors`, `@types/express`, `@types/cors`).

### Changed
- `MCP_TRANSPORT` now supports `stdio` (default), `http`/`streamable`, and legacy alias `sse`.
- Added HTTP deployment environment controls: `AFFINE_MCP_HTTP_HOST`, `AFFINE_MCP_HTTP_TOKEN`, `AFFINE_MCP_HTTP_ALLOWED_ORIGINS`, `AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS`.
- WebSocket ack flow was simplified with shared timeout/error handling utilities.
- Workspace bootstrap now propagates the optional `avatar` argument into initial workspace metadata.
- README and remote deployment guidance expanded with security defaults and hosting presets.

### Fixed
- `/mcp` now consistently applies the 50MB JSON parser for large MCP payloads.
- HTTP bearer authentication now accepts case-insensitive scheme variants (`Bearer` / `bearer`).
- Removed dead config/type scaffolding and tightened internal config parsing for header JSON.

## [1.6.0] - 2026-02-24

### Added
- 11 new document workflow tools: `list_tags`, `list_docs_by_tag`, `create_tag`, `add_tag_to_doc`, `remove_tag_from_doc`, `export_doc_markdown`, `create_doc_from_markdown`, `append_markdown`, `replace_doc_with_markdown`, `add_database_column`, `add_database_row`.
- Interactive CLI subcommands: `affine-mcp login`, `affine-mcp status`, `affine-mcp logout`.
- End-to-end verification pipeline with Docker and Playwright (`tests/run-e2e.sh`, `.github/workflows/e2e.yml`).
- New npm test commands: `test:e2e`, `test:db-create`, `test:bearer`, `test:playwright`.

### Changed
- Tool surface expanded from 32 to 43 canonical tools.
- Runtime server version now resolves from `package.json` through `src/config.ts` (`VERSION`) and is reused by runtime/CLI user-agent headers.
- Authentication/bootstrap flow supports config-file fallback (`~/.config/affine-mcp/config`) and Bearer headers across GraphQL/WebSocket paths.
- `list_docs` now enriches each document node with tags from workspace metadata snapshots.
- Added markdown and E2E test dependencies in package metadata (`markdown-it`, `@types/markdown-it`, `@playwright/test`).
- `workspaces` and `blobStorage` tools now use typed `GraphQLClient` accessors and shared bearer/cookie propagation.
- `test-comprehensive.mjs` now asserts tag workflows and markdown roundtrip workflows.

### Fixed
- Hardened GraphQL/auth error handling for redirects, non-JSON responses, and timeout boundaries.
- Added CR/LF guardrails for cookie/header handling to prevent header-injection edge cases.
- Added `.gitignore` rules for generated E2E and Playwright artifacts.

## [1.5.0] - 2026-02-13

### Added
- `append_block` Step4 types: `database`, `data_view`, `surface_ref`, `frame`, `edgeless_text`, `note`.
- Local integration coverage for all append profiles (`step1`..`step4`) in `scripts/test-append-block-expansion.mjs`.

### Changed
- `append_block` canonical type set expanded to 30 verified cases with stricter field validation and parent-container checks.
- Step4 creation payloads now use Yjs-native value types (`Y.Map`/`Y.Array`) to avoid runtime serialization failures.

### Fixed
- Resolved `Unexpected content type` failures while appending database/edgeless blocks.
- Aligned `surface_ref` caption validation with block creation behavior.
- Prevented AFFiNE UI runtime crashes from `type=data_view` by mapping it to stable `affine:database` output.

## [1.4.0] - 2026-02-13

### Added
- `read_doc` tool to read document block snapshots and plain text via WebSocket.

### Changed
- README now includes Cursor MCP setup examples and explicit troubleshooting for `Method not found` JSON-RPC misuse.
- README now documents that browser local-storage workspaces are not accessible via server APIs.

### Fixed
- Runtime MCP server metadata version in `src/index.ts` updated to `1.4.0`.

## [1.3.0] - 2026-02-13

### Added
- Open-source community health files: `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`.
- GitHub community templates: bug/feature issue templates and PR template.
- CI workflow (`.github/workflows/ci.yml`) and Dependabot config.
- Tool manifest (`tool-manifest.json`) and static verification script (`npm run test:tool-manifest`).

### Changed
- Tool surface simplified to 31 canonical tools with no duplicated alias names.
- Comprehensive integration test script now validates runtime tool list against `tool-manifest.json`.
- Package metadata improved (`bugs`, `homepage`) and new quality scripts (`npm run ci`, `npm run pack:check`).

### Removed
- Duplicated alias tools (`affine_*`) and low-value/unstable tools from default surface.
- Deprecated `src/tools/updates.ts` and legacy workspace fixed alias tooling.

## [1.2.2] - 2025-09-18

### Fixed
- CLI binary now runs through Node via `bin/affine-mcp`, preventing shells from misinterpreting ESM JS files and avoiding false startup timeouts.

### Changed
- Documentation: removed `.env`-based configuration guidance; recommend environment variables via shell or app configuration.
- Version badges and examples refreshed; clarified non-blocking login default.

## [1.2.1] - 2025-09-17

### Changed
- Default startup authentication is now asynchronous when using email/password to avoid MCP stdio handshake timeouts. Use `AFFINE_LOGIN_AT_START=sync` only when blocking startup is required.
- Docs fully refreshed: clear instructions for Codex CLI and Claude Desktop using npm, npx, and local clone workflows.

### Added
- README examples for `codex mcp add` with `affine-mcp` and with `npx -p affine-mcp-server affine-mcp`.
- Local clone usage guide and `npm link` workflow.

### Removed
- Unnecessary repo artifacts (e.g., `.env.example`, `.dockerignore`).

## [1.2.0] - 2025-09-16

### 🚀 Major
Document create/edit/delete is now supported. These are synchronized to real AFFiNE docs via WebSocket (Yjs) updates. Tools: `create_doc`, `append_paragraph`, `delete_doc`.

### Added
- WebSocket-based document tools: `create_doc`, `append_paragraph`, `delete_doc`
- CLI binary `affine-mcp` for stdio MCP integration (Claude / Codex)
- Tool aliases: support both prefixed (`affine_*`) and non-prefixed names
- Published on npm with a one-line global install: `npm i -g affine-mcp-server`

### Changed
- TypeScript ESM resolution switched to NodeNext for stable `.js` imports in TS
- Docs updated for npm publish and Codex usage

### Fixed
- Unified MCP return types with helper to satisfy SDK type constraints

## [1.1.0] - 2025-08-12

### 🎯 Key Achievement
- **FIXED**: Critical workspace creation issue - workspaces are now fully accessible in UI
- Successfully creates workspaces with initial documents using Yjs CRDT structure

### Added
- ✨ Workspace creation with initial document support
- 📦 Blob storage management tools (3 tools)
- 🔔 Notification management tools (3 tools)
- 👤 User CRUD operations (4 tools)
- 🧪 Comprehensive test suite

### Changed
- 🎯 Simplified tool names (removed `affine_` prefix)
- 📁 Consolidated workspace tools into single module
- 🔧 Improved authentication with fallback chain
- 📝 Enhanced error messages and validation
- ⚡ Streamlined codebase structure

### Fixed
- 🐛 Workspace creation now works correctly with UI
- 🐛 Document metadata properly structured
- 🐛 Authentication flow issues resolved
- 🐛 GraphQL query structures corrected

### Removed
- ❌ Experimental tools (not production ready)
- ❌ Docker support (incompatible with stdio)
- ❌ Non-working realtime tools
- ❌ Redundant CRUD duplicates

### Technical Details
- Uses Yjs CRDT for document structure
- BlockSuite-compatible document format
- WebSocket support for sync operations
- 30+ verified working tools

## [1.0.0] - 2025-08-12

### Added
- Initial stable release
- 21 core tools for AFFiNE operations
- Full MCP SDK 1.17.2 compatibility
- Complete authentication support (Token, Cookie, Email/Password)
- GraphQL API integration
- Comprehensive documentation

### Features
- Workspace management
- Document operations
- Comments system
- Version history
- User management
- Access tokens

[1.11.2]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.11.2
[1.11.1]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.11.1
[1.11.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.11.0
[1.10.1]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.10.1
[1.10.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.10.0
[1.9.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.9.0
[1.8.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.8.0
[1.7.2]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.7.2
[1.7.1]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.7.1
[1.7.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.7.0
[1.2.2]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.2.2
[1.2.1]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.2.1
[1.2.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.2.0
[1.1.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.1.0
[1.0.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.0.0
[1.5.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.5.0
[1.4.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.4.0
[1.3.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.3.0
[1.6.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.6.0
[Unreleased]: https://github.com/dawncr0w/affine-mcp-server/compare/v1.11.2...HEAD
