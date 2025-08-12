# AFFiNE MCP Server

A Model Context Protocol (MCP) server that provides seamless integration with self-hosted or cloud AFFiNE instances. This server enables AI assistants to interact with AFFiNE workspaces, documents, and collaboration features through a standardized interface.

## Overview

- **Purpose**: MCP server exposing AFFiNE GraphQL tools to manage workspaces, docs, search, comments, and history
- **Transport**: stdio (WebSocket support deprecated in MCP SDK 1.17+)
- **Auth**: Flexible authentication with Token, Cookie, or Email/Password
- **Tools**: 21 tools covering workspaces, documents, comments, history, user management, and more

## Features

- **Complete AFFiNE Coverage**: Tools mirror common Notion-like workflows in AFFiNE
- **GraphQL-first**: Uses `AFFINE_BASE_URL` + `/graphql` for all operations
- **Multiple Auth Methods**: Bearer tokens, session cookies, or email/password authentication
- **Production Ready**: Comprehensive error handling and extensive testing
- **Type Safe**: Built with TypeScript and Zod validation

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

# Transport settings
MCP_TRANSPORT=stdio  # Only stdio is supported in SDK 1.17+
```

### Authentication Priority

The server checks for authentication in this order:
1. **Bearer Token** (`AFFINE_API_TOKEN`) - Highest priority
2. **Cookie** (`AFFINE_COOKIE` or via `AFFINE_HEADERS_JSON`)
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

**macOS/Linux**: `~/.config/codebase/mcp_servers.json`
**Windows**: `%APPDATA%\codebase\mcp_servers.json`

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

Then use with codex:
```bash
# Start a chat session with AFFiNE MCP enabled
codex chat --mcp affine

# Or add to your project's .codebase/config.yaml
mcp_servers:
  - affine
```

### Standalone Testing

```bash
# Set environment variables in .env file
cp .env.example .env
# Edit .env with your settings

# Run the server
npm start
```

## Available Tools

### Workspace Management
- `affine_list_workspaces` - List all available workspaces
- `affine_get_workspace` - Get workspace details by ID

### Document Operations
- `affine_list_docs` - List documents with pagination (`workspaceId?`, `first?`, `offset?`, `after?`)
- `affine_get_doc` - Get document metadata (`docId`, `workspaceId?`)
- `affine_search_docs` - Search documents (`keyword`, `limit?`, `workspaceId?`)
- `affine_recent_docs` - List recently updated documents (`first?`, `offset?`, `after?`, `workspaceId?`)
- `affine_publish_doc` - Make document public (`docId`, `mode?`, `workspaceId?`)
- `affine_revoke_doc` - Revoke public access (`docId`, `workspaceId?`)

### Collaboration
- `affine_list_comments` - List document comments (`docId`, `first?`, `offset?`, `after?`, `workspaceId?`)
- `affine_create_comment` - Create new comment (`docId`, `content`, `mentions?`, `workspaceId?`)
- `affine_update_comment` - Update comment content (`id`, `content`)
- `affine_delete_comment` - Delete a comment (`id`)
- `affine_resolve_comment` - Resolve/unresolve comment (`id`, `resolved`)

### Version Control
- `affine_list_histories` - View document history (`guid`, `take?`, `before?`, `workspaceId?`)
- `affine_recover_doc` - Restore to previous version (`guid`, `timestamp`, `workspaceId?`)

### User & Authentication
- `affine_current_user` - Get current user information
- `affine_sign_in` - Sign in with email/password
- `affine_list_access_tokens` - List personal access tokens
- `affine_generate_access_token` - Create new access token (`name`, `expiresAt?`)
- `affine_revoke_access_token` - Revoke access token (`id`)

### Advanced
- `affine_apply_doc_updates` - Apply CRDT updates (`docId`, `op`, `updates`, `workspaceId?`)

## Development

```bash
# Run in development mode with auto-reload
npm run dev

# Build for production
npm run build

# Start the server
npm start
```

## Testing

Test the server with your AFFiNE instance:

```bash
# Test basic connectivity
npm start

# Use with MCP inspector or Claude Desktop to verify tools
```

## Docker Support

Build and run with Docker:

```bash
# Build the image
docker build -t affine-mcp-server .

# Run with environment variables
docker run -e AFFINE_BASE_URL=https://your-instance.com \
           -e AFFINE_EMAIL=your@email.com \
           -e AFFINE_PASSWORD=yourpassword \
           affine-mcp-server
```

Or use Docker Compose:

```bash
# Copy and configure .env
cp .env.example .env

# Start the service
docker compose up --build
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

- Verify `AFFINE_BASE_URL` is accessible (try `curl`)
- Check if GraphQL endpoint is at `/graphql` (default)
- Ensure no firewall/proxy blocking connections
- For self-hosted instances, verify CORS settings

### Error Handling

The server includes robust error handling:
- Authentication failures log warnings but continue
- Missing permissions return empty results gracefully
- Network errors are logged with full details
- GraphQL errors are caught and handled appropriately

## Security Considerations

- **Never commit `.env` files** containing credentials
- Use environment variables in production
- Rotate access tokens regularly
- Always use HTTPS for AFFiNE connections
- Store credentials in secure credential managers
- Limit token scope when possible

## Version History

### 1.0.0 (2024-12-08)
- Production-ready release
- Full MCP SDK 1.17.2 compatibility
- Complete authentication support (Token, Cookie, Email/Password)
- 21 tools covering all AFFiNE operations
- Comprehensive error handling and recovery
- Extensive testing with real AFFiNE instances
- Docker support

### 0.1.0 (2024-12-07)
- Initial development version
- Basic MCP server implementation
- Core workspace and document tools
- WebSocket transport (deprecated)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Add tests for new features
4. Ensure all tests pass (`npm test`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- Open an issue on [GitHub](https://github.com/dawncr0w/affine-mcp-server/issues)
- Check AFFiNE documentation at https://docs.affine.pro
- Join AFFiNE Discord at https://discord.gg/affine

## Author

**dawncr0w** - [GitHub](https://github.com/dawncr0w)

## Acknowledgments

- Built for the [AFFiNE](https://affine.pro) knowledge base platform
- Uses the [Model Context Protocol](https://modelcontextprotocol.io) specification
- Powered by [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)