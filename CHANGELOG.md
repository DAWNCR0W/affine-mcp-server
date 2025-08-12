# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-12-08

### Added
- Initial stable release
- Full MCP SDK 1.17.2 compatibility
- Complete authentication support:
  - Bearer Token authentication (highest priority)
  - Session Cookie authentication
  - Email/Password authentication (fallback)
- 21 comprehensive tools for AFFiNE operations:
  - Workspace management (list, get)
  - Document operations (list, get, search, recent, publish, revoke)
  - Comments system (list, create, update, delete, resolve)
  - Version history (list histories, recover documents)
  - User management (current user, sign in)
  - Access tokens (list, generate, revoke)
  - Advanced CRDT updates
- Robust error handling for GraphQL operations
- Graceful fallback for missing permissions
- Docker support with Dockerfile and docker-compose.yml
- Comprehensive documentation and examples
- Support for Claude Desktop and Codebase CLI (codex)

### Fixed
- MCP SDK compatibility issues (migrated from 0.3.1 to 1.17.2)
- WebSocket transport removal (deprecated in newer SDK)
- GraphQL error handling for search and access token operations
- Authentication priority and error reporting

### Security
- Secure credential handling with environment variables
- Support for multiple authentication methods
- Automatic session management

## [0.1.0] - 2024-12-07

### Added
- Initial development version
- Basic MCP server implementation  
- Core workspace and document tools
- WebSocket transport support (later deprecated)
- Basic GraphQL client implementation

[1.0.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v1.0.0
[0.1.0]: https://github.com/dawncr0w/affine-mcp-server/releases/tag/v0.1.0