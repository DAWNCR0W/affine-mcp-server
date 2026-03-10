# Release Notes

## Version 1.9.0 (2026-03-10)

### Highlights
- Added dedicated database schema discovery with `read_database_columns`, so empty AFFiNE databases are now self-describing.
- Added preset-backed `data_view` creation with kanban-oriented verification and richer exposed view metadata.
- Hardened test infrastructure with a self-bootstrapping comprehensive runner, focused supporting-tools coverage, and a more reliable end-to-end Docker pipeline.

### What Changed
- `src/tools/docs.ts`
  - Added `read_database_columns` for empty-database schema discovery.
  - Added preset-backed `data_view` creation and richer exposed view metadata for database views.
  - Added markdown callout import/export support through the document markdown pipeline.
- `tests/run-e2e.sh`, `tests/run-comprehensive.sh`
  - Isolated Docker-backed test stacks and staged startup/readiness checks for more reliable local and CI execution.
  - Seeded data-view state before Playwright so the full UI verification suite can run end to end.
- `tests/test-supporting-tools.mjs`, `tests/test-data-view.mjs`, `tests/test-markdown-roundtrip.mjs`
  - Added focused supporting-tools regression coverage.
  - Added data-view integration coverage and markdown callout round-trip coverage.
- `README.md`, `CHANGELOG.md`, `RELEASE_NOTES.md`, `tool-manifest.json`, `package.json`
  - Bumped release metadata to `1.9.0`.
  - Trimmed duplicated release history from the README and pointed readers to the dedicated release documents.

### Validation Evidence
- Release sanity gate passed:
  - `npm run ci`
- Live environment verification passed:
  - `npm run test:e2e`
  - `npm run test:comprehensive`
  - `npm run test:supporting-tools`
  - `npm run test:data-view`
  - `npm run test:data-view-ui`
  - `npm run test:markdown-roundtrip`

## Version 1.8.0 (2026-03-09)

### Highlights
- Added database cell read/write tools for AFFiNE databases, including Kanban stage sync workflows.
- Fixed row title persistence so `add_database_row` now renders Kanban card headers correctly when `title` / `Title` is provided.
- Added CLI version commands for direct and wrapped installs: `--version`, `-v`, and `version`.

### What Changed
- `src/tools/docs.ts`
  - Added `read_database_cells` to read database rows with per-column values and optional row/column filters.
  - Added `update_database_cell` and `update_database_row` for single-cell and batch row updates across supported database column types.
  - Fixed `add_database_row` so the built-in row paragraph text stays in sync with the logical title used by AFFiNE Kanban cards.
- `src/index.ts`, `tests/test-cli-version.mjs`
  - Added early CLI version handling for `--version`, `-v`, and `version`.
  - Added wrapper-argument coverage for `affine-mcp -- --version`.
- `package.json`, `tool-manifest.json`, `README.md`
  - Bumped package metadata to `1.8.0`.
  - Updated public docs and manifest metadata for the expanded tool surface and CLI version support.

### Validation Evidence
- Release sanity gate passed:
  - `npm run ci`
- CLI version regression coverage passed:
  - `npm run test:cli-version`
- Live database cell integration coverage passed against local Docker AFFiNE:
  - `. tests/generate-test-env.sh`
  - `docker compose -f docker/docker-compose.yml up -d`
  - `npm run test:db-cells`

## Version 1.7.2 (2026-03-04)

### Highlights
- Fixed tag visibility parity so tags persisted through MCP are now rendered correctly in AFFiNE Web/App UI.
- Added dedicated MCP + Playwright regression coverage for tag visibility.
- Hardened Docker E2E startup flow with retries and diagnostics to reduce transient CI failures.

### What Changed
- `src/tools/docs.ts`
  - Aligned tag persistence to AFFiNE canonical schema (`meta.properties.tags.options`) by storing option IDs.
  - Added backward-compatible normalization for legacy string tag entries.
  - Added tag label resolution for tag-facing outputs (`read_doc`, `list_docs`, `list_tags`, `list_docs_by_tag`, markdown export).
- `tests/test-tag-visibility.mjs`, `tests/playwright/verify-tag-visibility.pw.ts`
  - Added end-to-end regression path to create/apply tags via MCP and verify real UI visibility in AFFiNE.
- `tests/run-e2e.sh`, `tests/acquire-credentials.mjs`
  - Added configurable health-check and credential-acquisition retries.
  - Added Docker diagnostics dump (`docker compose ps/logs`) on bootstrap failure for actionable CI troubleshooting.

### Validation Evidence
- Local end-to-end validation passed:
  - `bash tests/run-e2e.sh` (`6 passed` in Playwright verification)
- Release sanity gate passed:
  - `npm run ci`
- PR checks passed for the change set:
  - `validate`, `e2e`, and security checks on PR #46

## Version 1.7.1 (2026-03-03)

### Highlights
- Fixed MCP-created doc structure to match AFFiNE UI parent-link expectations.
- Fixed callout block text rendering so MCP-created callouts display content in AFFiNE UI.
- Added regression checks for document-visibility-sensitive creation paths.

### What Changed
- `src/tools/docs.ts`
  - `sys:parent` writes for MCP-created blocks were aligned to UI parity (`null`).
  - Placement context resolution now falls back to parent discovery from `sys:children` when parent fields are null.
  - Callout creation now emits a child paragraph block and stores text there for UI-compatible rendering.
- `src/tools/workspaces.ts`
  - Workspace bootstrap document blocks now use the same null-parent structure for consistency.
- `tests/test-database-creation.mjs`, `tests/test-bearer-auth.mjs`
  - Added explicit regression assertions for parent-shape parity after `create_doc`, `append_paragraph`, and `create_doc_from_markdown`.

### Validation Evidence
- Local Docker AFFiNE validation passed for one-document full block coverage:
  - Created one document and appended all currently supported MCP block types.
  - Verified the document appears in `/workspace/{workspaceId}/all`.
  - Verified direct document open path has no `Unexpected Application Error` / not-found state.
  - Verified callout marker text renders in UI after the structural fix.
- `npm run test:e2e` passed (`4 passed`) after the fix.
- `npm run test:comprehensive` passed (`calledTools: 43`, `failed: 0`).

## Version 1.7.0 (2026-02-27)

### Highlights
- Added remote-ready MCP HTTP hosting mode with Streamable HTTP protocol support on `/mcp`.
- Kept compatibility paths for older clients through legacy SSE endpoints (`/sse`, `/messages`).
- Hardened HTTP transport behavior for larger requests and broader Bearer token client compatibility.

### What Changed
- `src/index.ts`, `src/sse.ts`, `package.json`
  - Added transport switching via `MCP_TRANSPORT` with modes: `stdio` (default), `http`/`streamable`, and `sse` (legacy alias).
  - Added a dedicated HTTP startup script: `npm run start:http`.
  - Introduced a new HTTP runtime server with:
    - Streamable HTTP MCP endpoint: `/mcp`
    - Legacy SSE endpoints: `/sse`, `/messages`
    - Optional token guard via `AFFINE_MCP_HTTP_TOKEN`
    - Configurable CORS allowlist with explicit local-default behavior
    - Graceful shutdown handling for active MCP sessions.
- `src/sse.ts`
  - Applied explicit `50mb` JSON parsing on `/mcp` to handle larger tool payloads safely.
  - Updated Bearer auth parsing to accept case-insensitive scheme variants.
- `src/config.ts`, `src/ws.ts`, `src/tools/workspaces.ts`
  - Removed unused endpoint scaffolding and tightened header JSON parsing/validation.
  - Refactored WebSocket ack logic into shared timeout/error utilities.
  - Propagated workspace `avatar` into initial workspace Yjs metadata during workspace creation.
- `README.md`
  - Added remote deployment guidance (Docker/Render/Railway/VPS) and HTTP security recommendations.

### Validation Evidence
- `npm run ci` passed.
- `npm run test:e2e` passed:
  - Database creation flow passed.
  - Bearer-token MCP flow passed.
  - Playwright verification passed (`4 passed`).
- `npm run test:comprehensive` passed with:
  - `listedTools: 43`, `calledTools: 43`
  - `totalChecks: 51`, `passed: 51`, `failed: 0`, `blocked: 0`
  - Results file: `comprehensive-test-results-2026-02-27T01-17-21-949Z.json`.

## Version 1.6.0 (2026-02-24)

### Highlights
- Expanded the MCP surface from 32 to 43 tools with tag workflows, markdown roundtrip workflows, and direct database row/column editing tools.
- Added interactive CLI account setup and diagnostics commands (`login`, `status`, `logout`) with secure local config storage.
- Added Docker-based E2E verification (email/password + bearer token auth modes) and Playwright UI checks in CI.

### What Changed
- `src/tools/docs.ts`
  - Added tag operations: `list_tags`, `list_docs_by_tag`, `create_tag`, `add_tag_to_doc`, `remove_tag_from_doc`.
  - Added markdown conversion workflows: `export_doc_markdown`, `create_doc_from_markdown`, `append_markdown`, `replace_doc_with_markdown`.
  - Added database workflow tools: `add_database_column`, `add_database_row`.
  - Enriched `list_docs` output with `node.tags`.
- `src/cli.ts`, `src/config.ts`, `src/index.ts`
  - Added CLI subcommands and config-file lifecycle (`~/.config/affine-mcp/config`).
  - Switched runtime version metadata to a single `VERSION` source derived from `package.json`.
- `src/graphqlClient.ts`, `src/ws.ts`, `src/auth.ts`
  - Added stricter timeout/error handling, sanitized non-JSON response reporting, and bearer header support for WebSocket joins.
  - Added cookie/header safety guards against CR/LF injection.
- `src/tools/workspaces.ts`, `src/tools/blobStorage.ts`
  - Replaced ad-hoc `(gql as any)` access with typed `GraphQLClient` getters and consistent bearer/cookie propagation.
- `test-comprehensive.mjs`
  - Extended the integration matrix to validate tag and markdown workflows end-to-end.
- `package.json`, `package-lock.json`
  - Added dedicated test commands (`test:e2e`, `test:db-create`, `test:bearer`, `test:playwright`) and required dependencies for markdown parsing and Playwright.
- `tests/*`, `docker/*`, `.github/workflows/e2e.yml`
  - Added reproducible local+CI E2E pipeline for AFFiNE startup, MCP workflows, and UI verification.
- `.gitignore`
  - Added ignore entries for generated E2E state files and Playwright outputs.

### Validation Evidence
- `npm run ci` passed (`npm run build` + `npm run test:tool-manifest` + `npm run pack:check`).
- `npm run test:tool-manifest` reported `ok: true`, `count: 43`, `version: 1.6.0`.
- `npm pack --dry-run` produced `affine-mcp-server-1.6.0.tgz` (dry-run artifact).

## Version 1.5.0 (2026-02-13)

### Highlights
- Completed `append_block` expansion Step1~Step4 with live AFFINE server validation.
- Added database/edgeless append support: `database`, `data_view`, `surface_ref`, `frame`, `edgeless_text`, `note`.
- Hardened validation/parent resolution rules to match AFFINE block container constraints.

### What Changed
- `src/tools/docs.ts`
  - Expanded canonical append types and strict input validation schema.
  - Added surface auto-resolution and parent-type guardrails for page/note/surface paths.
  - Switched Step4 block payload internals to Yjs-native values to prevent runtime write failures.
  - Added `data_view -> database` safety fallback to avoid AFFiNE 0.26.x runtime crashes on raw `affine:data-view` blocks.
- `scripts/test-append-block-expansion.mjs`
  - Added Step4 integration cases and runtime placeholder chaining (`__FRAME_ID__`).
  - Increased end-to-end append verification to 30 cases.
- Runtime/manifest version metadata updated to `1.5.0`.

### Validation Evidence
- `APPEND_BLOCK_PROFILE=step1 node scripts/test-append-block-expansion.mjs` passed (10/10).
- `APPEND_BLOCK_PROFILE=step2 node scripts/test-append-block-expansion.mjs` passed (16/16).
- `APPEND_BLOCK_PROFILE=step3 node scripts/test-append-block-expansion.mjs` passed (24/24).
- `APPEND_BLOCK_PROFILE=step4 node scripts/test-append-block-expansion.mjs` passed (30/30).
- `npm run ci` passed.
- `npm run test:comprehensive` passed with 32/32 tools called and 38/38 checks passed.

## Version 1.4.0 (2026-02-13)

### Highlights
- Added `read_doc` to read actual document content (block snapshot + plain text), not only metadata.
- Added integration guides and troubleshooting for Cursor MCP setup and JSON-RPC method usage.
- Clarified local-storage workspace limitation (server APIs can access only server-backed workspaces).

### What Changed
- New tool: `read_doc` in `src/tools/docs.ts` with WebSocket snapshot parsing and block traversal.
- Tool manifest and comprehensive tests updated for 32-tool surface validation.
- Runtime server version metadata updated to `1.4.0`.

### Validation Evidence
- `npm run ci` passed.
- `npm run test:comprehensive` passed against local AFFINE server with 32/32 tools called and 38/38 checks passed.

## Version 1.3.0 (2026-02-13)

### Highlights
- Added slash-command style block insertion with `append_block` (`heading/list/todo/code/divider/quote`).
- Simplified public MCP tool surface to 31 canonical tools by removing duplicated aliases and unstable low-value tools.
- Added release quality gates: CI workflow, tool manifest parity verification, and package dry-run checks.

### What Changed
- New tool: `append_block` implemented in `/src/tools/docs.ts`, aligned with AFFiNE block model (`affine:*` + `prop:type`).
- Test hardening: `test-comprehensive.mjs` now validates runtime tools against `tool-manifest.json` and executes the new block types.
- Packaging/CI: `npm run ci`, `npm run test:tool-manifest`, `npm run pack:check`; publish workflow now runs full validation.
- Open-source readiness: added `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, issue templates, and PR template.

### Validation Evidence
- `npm run ci` passed.
- `npm run test:comprehensive` passed with 31/31 tools invoked, 37/37 checks passed, blocked=0, failed=0.

## Version 1.2.2 (2025-09-18)

### Highlights
- Robust CLI wrapper (`bin/affine-mcp`) ensures Node executes the ESM entrypoint, fixing shell mis-execution that caused startup errors/timeouts in some environments.

### What Changed
- Docs: `.env` usage removed; prefer environment variables via shell or app config (Codex/Claude config examples updated).
- Maintains 1.2.1 behavior: email/password login is asynchronous by default.

### Usage Snippets
- Codex (global install):
  - `npm i -g affine-mcp-server`
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' -- affine-mcp`
- Codex (npx):
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' -- npx -y -p affine-mcp-server affine-mcp`
- Claude Desktop:
  - `{"mcpServers":{"affine":{"command":"affine-mcp","env":{"AFFINE_BASE_URL":"https://...","AFFINE_EMAIL":"you@example.com","AFFINE_PASSWORD":"secret!"}}}}`

---

## Version 1.2.1 (2025-09-17)

### Highlights
- Prevent MCP startup timeouts: email/password login now defaults to asynchronous after the stdio handshake.
- New env toggle: set `AFFINE_LOGIN_AT_START=sync` only when startup must block.
- Documentation overhaul for Codex and Claude with npm, npx, and local clone usage.

### What Changed
- Startup auth flow no longer blocks MCP initialization; handshake happens immediately.
- Cleaned up repository artifacts not needed for distribution.

### Usage Snippets
- Codex (global install):
  - `npm i -g affine-mcp-server`
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' -- affine-mcp`
- Codex (npx):
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' -- npx -y -p affine-mcp-server affine-mcp`
- Claude Desktop:
  - `{"mcpServers":{"affine":{"command":"affine-mcp","env":{"AFFINE_BASE_URL":"https://...","AFFINE_EMAIL":"you@example.com","AFFINE_PASSWORD":"secret!"}}}}`
- Local clone:
  - `git clone ... && cd affine-mcp-server && npm i && npm run build && node dist/index.js`

---

## Version 1.2.0 (2025-09-16) 🚀

### 🎉 Highlights
- Document creation, editing, and deletion via WebSocket updates
- One-line install + run from npm: `npm i -g affine-mcp-server` → `affine-mcp`

### ✨ What's New
- `create_doc` – create a new doc (page/surface/note/paragraph minimal structure)
- `append_paragraph` – append a paragraph block (simple editing example)
- `delete_doc` – delete a doc and remove it from workspace list
- Supports both prefixed/non-prefixed tool names (`affine_*` and non-prefixed)

### 🔧 Technical Improvements
- Applied NodeNext ESM resolution (stabilized relative `.js` imports)
- Improved SDK type consistency with MCP response format utilities
- Provided `bin`: `affine-mcp` (stdio only)

### 🧰 Usage (Claude / Codex)
- Claude Desktop: `command: "affine-mcp"`, `env: { AFFINE_* }`
- Codex: register MCP as a command (`affine-mcp`) and pass env (`AFFINE_*`)

### ⚠️ Notes
- Document editing syncs via WebSocket (`space:*`) events, not GraphQL
- Auth required: `AFFINE_COOKIE` recommended (or `AFFINE_API_TOKEN`, `AFFINE_EMAIL`/`AFFINE_PASSWORD`)

---

## Version 1.1.0 (2025-08-12)

### Major Achievement
- Workspace creation (with initial document) fixed and UI-accessible

### Added/Changed
- 30+ tools; simplified tool names; authentication/error handling improved

---

## Version 1.0.0 (2025-08-12)

### Initial Release
- Core AFFiNE tools + full MCP SDK 1.17.2 compatibility

---

Author: dawncr0w  
License: MIT  
Repository: https://github.com/dawncr0w/affine-mcp-server
