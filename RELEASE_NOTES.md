# Release Notes

## Version 1.2.0 (2025-09-16) 🚀

### 🎉 Highlights
- Document creation, editing, and deletion via WebSocket updates
- One-line install + run from npm: `npm i -g affine-mcp-server` → `affine-mcp`

### ✨ What's New
- `create_doc` – create a new doc (page/surface/note/paragraph minimal structure)
- `append_paragraph` – append a paragraph block (simple editing example)
- `delete_doc` – delete a doc and remove it from workspace list
- 접두사/무접두사 도구명 모두 지원(`affine_*` 및 non-prefixed)

### 🔧 Technical Improvements
- NodeNext ESM 해상도 적용(상대 경로 `.js` 임포트 안정화)
- MCP 응답 포맷 유틸로 SDK 타입 정합성 개선
- `bin` 제공: `affine-mcp` (stdio 전용)

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
