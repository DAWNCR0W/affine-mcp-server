# Release Notes - v1.0.0

## 🎉 First Stable Release!

The AFFiNE MCP Server is now production-ready with full support for self-hosted and cloud AFFiNE instances.

## ✨ Key Features

### 🔐 Flexible Authentication
- **Bearer Token** - Use personal access tokens
- **Session Cookies** - Leverage existing browser sessions  
- **Email/Password** - Direct authentication support

### 🛠️ Complete Tool Coverage (21 Tools)
- **Workspace Management** - List and manage workspaces
- **Document Operations** - Full CRUD operations on documents
- **Search & Discovery** - Search documents and view recent updates
- **Collaboration** - Complete comment system management
- **Version Control** - Document history and recovery
- **User Management** - Authentication and access token management

### 🚀 Easy Integration
- **Claude Desktop** support out of the box
- **Codebase CLI (codex)** configuration included
- **Docker** ready with docker-compose
- **Environment-based** configuration

## 📦 Installation

```bash
git clone https://github.com/dawncr0w/affine-mcp-server.git
cd affine-mcp-server
npm install
npm run build
```

## 🔧 Configuration

Create a `.env` file:
```env
AFFINE_BASE_URL=https://your-affine-instance.com
AFFINE_EMAIL=your@email.com
AFFINE_PASSWORD=your_password
```

## 🏃 Quick Start

```bash
npm start
```

Then add to your Claude Desktop config:
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

## 🧪 Tested With
- AFFiNE self-hosted instances
- MCP SDK 1.17.2
- Node.js 18+

## 🙏 Acknowledgments

Built for the [AFFiNE](https://affine.pro) community to enable AI-powered knowledge management.

## 📝 License

MIT License - See LICENSE file

## 🐛 Issues & Feedback

Please report issues at: https://github.com/dawncr0w/affine-mcp-server/issues

---

**Author**: dawncr0w
**Version**: 1.0.0
**Date**: December 8, 2024