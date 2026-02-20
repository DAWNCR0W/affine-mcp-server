import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, VERSION } from "./config.js";
import { GraphQLClient } from "./graphqlClient.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerDocTools } from "./tools/docs.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerUserTools } from "./tools/user.js";
import { registerUserCRUDTools } from "./tools/userCRUD.js";
import { registerAccessTokenTools } from "./tools/accessTokens.js";
import { registerBlobTools } from "./tools/blobStorage.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { loginWithPassword } from "./auth.js";
import { registerAuthTools } from "./tools/auth.js";
import { runCli } from "./cli.js";

// CLI subcommands: affine-mcp login|status|logout
const subcommand = process.argv[2];
if (subcommand && await runCli(subcommand)) {
  process.exit(0);
}

// MCP server mode (default)
const config = loadConfig();

// Startup diagnostics (visible in Claude Code MCP server logs via stderr)
import { existsSync } from "fs";
import { CONFIG_FILE } from "./config.js";
console.error(`[affine-mcp] Config: ${CONFIG_FILE} (${existsSync(CONFIG_FILE) ? 'found' : 'missing'})`);
console.error(`[affine-mcp] Endpoint: ${config.baseUrl}${config.graphqlPath}`);
const hasAuth = !!(config.apiToken || config.cookie || (config.email && config.password));
console.error(`[affine-mcp] Auth: ${hasAuth ? 'configured' : 'not configured'}`);
if (hasAuth && config.baseUrl.startsWith("http://")
    && !config.baseUrl.includes("localhost")
    && !config.baseUrl.includes("127.0.0.1")) {
  console.error("WARNING: Credentials configured over plain HTTP. Use HTTPS for remote servers.");
}
console.error(`[affine-mcp] Workspace: ${config.defaultWorkspaceId ? 'set' : '(none)'}`);

async function buildServer() {
  const server = new McpServer({ name: "affine-mcp", version: VERSION });

  // Initialize GraphQL client with authentication
  const gql = new GraphQLClient({
    endpoint: `${config.baseUrl}${config.graphqlPath}`,
    headers: config.headers,
    bearer: config.apiToken
  });

  // Try email/password authentication if no other auth method is configured.
  // To avoid startup timeouts in MCP clients, default to async login after the stdio handshake.
  if (!gql.isAuthenticated() && config.email && config.password) {
    const mode = (process.env.AFFINE_LOGIN_AT_START || "async").toLowerCase();
    if (mode === "sync") {
      console.error("No token/cookie; performing synchronous email/password authentication at startup...");
      try {
        const { cookieHeader } = await loginWithPassword(config.baseUrl, config.email, config.password);
        gql.setCookie(cookieHeader);
        console.error("Successfully authenticated with email/password");
      } catch (e) {
        console.error("Failed to authenticate with email/password:", e);
        console.error("WARNING: Continuing without authentication - some operations may fail");
      } finally {
        // Clear credentials from memory after authentication attempt
        config.password = undefined;
        config.email = undefined;
      }
    } else {
      console.error("No token/cookie; deferring email/password authentication (async after connect)...");
      // Capture credentials before clearing — async login needs them.
      const loginEmail = config.email!;
      const loginPassword = config.password!;
      config.password = undefined;
      config.email = undefined;
      // Fire-and-forget async login so stdio handshake is not delayed.
      (async () => {
        try {
          const { cookieHeader } = await loginWithPassword(config.baseUrl, loginEmail, loginPassword);
          gql.setCookie(cookieHeader);
          console.error("Successfully authenticated with email/password (async)");
        } catch (e) {
          console.error("Failed to authenticate with email/password (async):", e);
        }
      })();
    }
  }

  // Log authentication status
  if (!gql.isAuthenticated()) {
    console.error("WARNING: No authentication configured. Some operations may fail.");
    console.error("Set AFFINE_API_TOKEN or run: affine-mcp login");
  }
  registerWorkspaceTools(server, gql);
  registerDocTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerCommentTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerHistoryTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerUserTools(server, gql);
  registerUserCRUDTools(server, gql);
  registerAccessTokenTools(server, gql);
  registerBlobTools(server, gql);
  registerNotificationTools(server, gql);
  registerAuthTools(server, gql, config.baseUrl);
  return server;
}

async function start() {
  // stdio transport is the only supported mode in MCP SDK 1.17+
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The server is now ready to accept stdio communication
  // It will continue running until the process is terminated
}

start().catch((err) => {
  console.error("Failed to start affine-mcp server:", err);
  process.exit(1);
});
