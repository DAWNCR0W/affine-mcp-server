# Release Notes

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
- Maintains 1.2.1 behavior: email/password login is asynchronous by default (`AFFINE_LOGIN_AT_START=async`).

### Usage Snippets
- Codex (global install):
  - `npm i -g affine-mcp-server`
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' --env AFFINE_LOGIN_AT_START=async -- affine-mcp`
- Codex (npx):
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' --env AFFINE_LOGIN_AT_START=async -- npx -y -p affine-mcp-server affine-mcp`
- Claude Desktop:
  - `{"mcpServers":{"affine":{"command":"affine-mcp","env":{"AFFINE_BASE_URL":"https://...","AFFINE_EMAIL":"you@example.com","AFFINE_PASSWORD":"secret!","AFFINE_LOGIN_AT_START":"async"}}}}`

---

## Version 1.2.1 (2025-09-17)

### Highlights
- Prevent MCP startup timeouts: email/password login now defaults to asynchronous after the stdio handshake.
- New env toggle: `AFFINE_LOGIN_AT_START=async|sync` (default: `async`).
- Documentation overhaul for Codex and Claude with npm, npx, and local clone usage.

### What Changed
- Startup auth flow no longer blocks MCP initialization; handshake happens immediately.
- Cleaned up repository artifacts not needed for distribution.

### Usage Snippets
- Codex (global install):
  - `npm i -g affine-mcp-server`
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' --env AFFINE_LOGIN_AT_START=async -- affine-mcp`
- Codex (npx):
  - `codex mcp add affine --env AFFINE_BASE_URL=https://your-affine-instance.com --env 'AFFINE_EMAIL=you@example.com' --env 'AFFINE_PASSWORD=secret!' --env AFFINE_LOGIN_AT_START=async -- npx -y -p affine-mcp-server affine-mcp`
- Claude Desktop:
  - `{"mcpServers":{"affine":{"command":"affine-mcp","env":{"AFFINE_BASE_URL":"https://...","AFFINE_EMAIL":"you@example.com","AFFINE_PASSWORD":"secret!","AFFINE_LOGIN_AT_START":"async"}}}}`
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
