# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Open-source community health files: `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`.
- GitHub community templates: bug/feature issue templates and PR template.
- CI workflow (`.github/workflows/ci.yml`) and Dependabot config.
- Tool manifest (`tool-manifest.json`) and static verification script (`npm run test:tool-manifest`).

### Changed
- Tool surface simplified to 30 canonical tools with no duplicated alias names.
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
- Default startup authentication is now asynchronous when using email/password to avoid MCP stdio handshake timeouts. The new env `AFFINE_LOGIN_AT_START` controls behavior (`async` by default, `sync` to block at startup).
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

[1.2.2]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.2.2
[1.2.1]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.2.1
[1.2.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.2.0
[1.1.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.1.0
[1.0.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.0.0
[Unreleased]: https://github.com/dawncr0w/affine-mcp-server/compare/v1.2.2...HEAD
