# AFFiNE MCP Server

A Model Context Protocol (MCP) server that provides seamless integration with self-hosted or cloud AFFiNE instances. This server enables AI assistants to interact with AFFiNE workspaces and documents through a standardized interface.

[![Version](https://img.shields.io/badge/version-1.1.0-blue)](https://github.com/dawncr0w/affine-mcp-server/releases)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.17.2-green)](https://github.com/modelcontextprotocol/typescript-sdk)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

## Overview

- **Purpose**: MCP server for managing AFFiNE workspaces and documents
- **Transport**: stdio only (required for Claude Desktop and CLI integration)
- **Auth**: Flexible authentication with Token, Cookie, or Email/Password
- **Tools**: 30+ production-tested tools for comprehensive AFFiNE management
- **Status**: 🚀 Production Ready (v1.1.0)

## Features

- **Workspace Management**: Create workspaces with initial documents (UI accessible)
- **Document Operations**: List, search, and manage documents
- **User Management**: Authentication and profile management
- **Comments System**: Full comment CRUD operations
- **Version History**: Document history and recovery
- **Notifications**: Read and manage notifications

## Requirements

- Node.js 18+ (for running the server)
- AFFiNE instance (self-hosted or cloud)
- Valid AFFiNE credentials or access token

## Installation

```bash
# Clone the repository
git clone https://github.com/dawncr0w/affine-mcp-server.git
cd affine-mcp-server

# Install dependencies
npm install

# Build the TypeScript code
npm run build
```

## Configuration

Create a `.env` file in the project root:

```env
# AFFiNE server URL (required)
AFFINE_BASE_URL=https://your-affine-instance.com

# Authentication (choose one method):

# Option 1: Bearer Token (highest priority)
AFFINE_API_TOKEN=your_personal_access_token

# Option 2: Session Cookie
AFFINE_COOKIE=affine_session=xxx; affine_csrf=yyy

# Option 3: Email/Password (fallback)
AFFINE_EMAIL=your@email.com
AFFINE_PASSWORD=your_password

# Optional settings
AFFINE_GRAPHQL_PATH=/graphql  # Default: /graphql
AFFINE_WORKSPACE_ID=workspace-uuid  # Default workspace for operations
```

### Authentication Priority

The server checks for authentication in this order:
1. **Bearer Token** (`AFFINE_API_TOKEN`) - Highest priority
2. **Cookie** (`AFFINE_COOKIE`)
3. **Email/Password** (`AFFINE_EMAIL` + `AFFINE_PASSWORD`) - Fallback

## Quick Start

### With Claude Desktop

Add to your Claude Desktop configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "affine": {
      "command": "node",
      "args": ["/path/to/affine-mcp-server/dist/index.js"],
      "env": {
        "AFFINE_BASE_URL": "https://your-affine-instance.com",
        "AFFINE_EMAIL": "your@email.com",
        "AFFINE_PASSWORD": "your_password"
      }
    }
  }
}
```

### With Codebase CLI (codex)

Add to your Codebase CLI configuration:

```json
{
  "affine": {
    "command": "node",
    "args": ["/path/to/affine-mcp-server/dist/index.js"],
    "env": {
      "AFFINE_BASE_URL": "https://your-affine-instance.com",
      "AFFINE_EMAIL": "your@email.com", 
      "AFFINE_PASSWORD": "your_password"
    }
  }
}
```

## Available Tools

### Workspace Management (5 tools)
- `list_workspaces` - List all accessible workspaces
- `get_workspace` - Get workspace details
- `create_workspace` - Create workspace with initial document ✅
- `update_workspace` - Update workspace settings
- `delete_workspace` - Delete workspace permanently

### Document Operations (6 tools)
- `list_docs` - List documents with pagination
- `get_doc` - Get document metadata
- `search_docs` - Search documents by keyword
- `recent_docs` - List recently updated documents
- `publish_doc` - Make document public
- `revoke_doc` - Revoke public access

### Comments (5 tools)
- `list_comments` - List document comments
- `create_comment` - Create new comment
- `update_comment` - Update comment content
- `delete_comment` - Delete a comment
- `resolve_comment` - Resolve/unresolve comment

### Version History (2 tools)
- `list_histories` - View document history
- `recover_doc` - Restore to previous version

### User Management (4 tools)
- `current_user` - Get current user information
- `sign_in` - Sign in with email/password
- `update_profile` - Update user profile
- `update_settings` - Update user settings

### Access Tokens (3 tools)
- `list_access_tokens` - List personal access tokens
- `generate_access_token` - Create new access token
- `revoke_access_token` - Revoke access token

### Notifications (3 tools)
- `list_notifications` - Get notifications
- `read_notification` - Mark notification read
- `read_all_notifications` - Mark all notifications read

### Blob Storage (3 tools)
- `upload_blob` - Upload file/blob
- `delete_blob` - Delete blob
- `cleanup_blobs` - Cleanup deleted blobs

### Advanced (1 tool)
- `apply_doc_updates` - Apply CRDT updates to documents

## Testing

```bash
# Run comprehensive tests
node test-comprehensive.mjs

# Test workspace creation
node test-fixed-workspace.mjs
```

## Troubleshooting

### Authentication Issues

1. **Email/Password fails**: 
   - Ensure your AFFiNE instance allows password authentication
   - Check network connectivity to the AFFiNE server
   - Verify credentials are correct

2. **Cookie authentication**: 
   - Extract cookies from browser DevTools Network tab
   - Look for `affine_session` cookie after logging in
   - Include all relevant cookies in `AFFINE_COOKIE`

3. **Token authentication**: 
   - Generate token from AFFiNE user settings
   - Ensure token hasn't expired
   - Use the full token string in `AFFINE_API_TOKEN`

### Connection Issues

- Verify `AFFINE_BASE_URL` is accessible
- Check if GraphQL endpoint is at `/graphql` (default)
- Ensure no firewall/proxy blocking connections
- For self-hosted instances, verify CORS settings

## Security Considerations

- **Never commit `.env` files** containing credentials
- Use environment variables in production
- Rotate access tokens regularly
- Always use HTTPS for AFFiNE connections
- Store credentials in secure credential managers

## Version History

### 1.1.0 (2025-08-12)
- ✅ Fixed workspace creation with initial documents
- Added 30+ tools for comprehensive AFFiNE management
- Workspace creation now accessible in UI
- Improved error handling and authentication
- Simplified tool names for better usability

### 1.0.0 (2025-08-12)
- Initial stable release
- Basic workspace and document operations
- Full authentication support

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Ensure all tests pass
5. Submit a Pull Request

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