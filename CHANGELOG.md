# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.1.0
[1.0.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.0.0