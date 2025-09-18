# Release Notes

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
