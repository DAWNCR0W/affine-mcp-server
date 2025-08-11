import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { WebSocketServerTransport } from "@modelcontextprotocol/sdk/server/websocket.js";

import { loadConfig } from "./config.js";
import { GraphQLClient } from "./graphqlClient.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerDocTools } from "./tools/docs.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerUserTools } from "./tools/user.js";
import { registerUpdateTools } from "./tools/updates.js";
import { registerAccessTokenTools } from "./tools/accessTokens.js";
import { loginWithPassword } from "./auth.js";
import { registerAuthTools } from "./tools/auth.js";

const config = loadConfig();

async function buildServer() {
  const server = new Server({ name: "affine-mcp", version: "0.1.0" });
  const gql = new GraphQLClient({ endpoint: `${config.baseUrl}${config.graphqlPath}`, headers: config.headers, bearer: config.apiToken });
  if (!config.headers?.Cookie && !config.apiToken && config.email && config.password) {
    try {
      const { cookieHeader } = await loginWithPassword(config.baseUrl, config.email, config.password);
      gql.setCookie(cookieHeader);
      // eslint-disable-next-line no-console
      console.log("Signed in to AFFiNE via email/password; session cookies set.");
    } catch (e) {
      console.warn("Failed to sign in with email/password:", e);
    }
  }
  registerWorkspaceTools(server, gql);
  registerDocTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerCommentTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerHistoryTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerUserTools(server, gql);
  registerUpdateTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerAccessTokenTools(server, gql);
  registerAuthTools(server, gql, config.baseUrl);
  return server;
}

async function start() {
  if (config.transport === "stdio") {
    const server = await buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const wss = new WebSocketServer({ port: config.wsPort });
  // For each incoming connection, create a new server instance
  wss.on("connection", async (socket) => {
    const server = await buildServer();
    const transport = new WebSocketServerTransport(socket);
    await server.connect(transport);
  });

  // eslint-disable-next-line no-console
  console.log(`AFFiNE MCP WebSocket server listening on ws://0.0.0.0:${config.wsPort}`);
}

start().catch((err) => {
  console.error("Failed to start affine-mcp server:", err);
  process.exit(1);
});
