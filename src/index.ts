import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CONFIG_FILE, loadConfig, type ServerConfig, VERSION } from "./config.js";
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
import { AuthSession, parseLoginMode } from "./authSession.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerOrganizeTools } from "./tools/organize.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerIconTools } from "./tools/icons.js";
import { runCli } from "./cli.js";
import { startHttpMcpServer } from "./sse.js";
import { existsSync } from "fs";
import { createToolFilter, toolAnnotationsFor } from "./toolSurface.js";
import { toolOutputSchemaFor } from "./toolOutputSchemas.js";
import {
  assertOAuthServiceWritePolicy,
  createToolFilterEnvironment,
} from "./oauthServicePolicy.js";

// CLI commands: affine-mcp login|status|logout|version
const rawArgs = process.argv.slice(2);
const cliArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const subcommand = cliArgs[0];
if (subcommand === "--version" || subcommand === "-v" || subcommand === "version") {
  console.log(VERSION);
  process.exit(0);
}
if (subcommand === "--help" || subcommand === "-h") {
  await runCli("help");
  process.exit(0);
}
if (subcommand) {
  const handled = await runCli(subcommand, cliArgs.slice(1));
  if (!handled) {
    console.error(`Unknown command: ${subcommand}`);
    await runCli("help");
    process.exit(1);
  }
  process.exit(0);
}

// MCP server mode (default)
function loadServerConfig(): ServerConfig {
  try {
    return loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[affine-mcp] Invalid configuration: ${message}`);
    process.exit(1);
  }
}
const config = loadServerConfig();
const useHttpTransport = config.transportMode === "http";

// OAuth callers share one AFFiNE service credential. Default that deployment
// model to read-only unless operators explicitly enable both a write-capable
// profile and the service-write acknowledgement.
const toolFilterEnvironment = createToolFilterEnvironment(config.authMode, process.env);

// Tool filtering is parsed once at module load (not per-session in HTTP mode).
const toolFilter = createToolFilter(toolFilterEnvironment);

if (config.authMode === "oauth" && !useHttpTransport) {
  throw new Error("AFFINE_MCP_AUTH_MODE=oauth requires MCP_TRANSPORT=http (or streamable/sse).");
}
if (config.authMode === "oauth" && !config.apiToken) {
  throw new Error("AFFINE_API_TOKEN is required when AFFINE_MCP_AUTH_MODE=oauth.");
}
if (config.authMode === "oauth" && (config.cookie || config.email || config.password)) {
  console.error(
    "[affine-mcp] OAuth mode uses the configured AFFINE_API_TOKEN service credential. " +
    "Ignoring AFFINE_COOKIE / AFFINE_EMAIL / AFFINE_PASSWORD.",
  );
}
if (config.authMode === "oauth" && process.env.AFFINE_LOGIN_AT_START) {
  console.error("[affine-mcp] AFFINE_LOGIN_AT_START is ignored when AFFINE_MCP_AUTH_MODE=oauth.");
}

const loginMode = config.authMode === "oauth"
  ? "async"
  : parseLoginMode(process.env.AFFINE_LOGIN_AT_START);

function findConfiguredHeader(name: string): string | undefined {
  let value: string | undefined;
  for (const [headerName, headerValue] of Object.entries(config.headers || {})) {
    if (headerName.toLowerCase() === name) value = headerValue;
  }
  return value;
}

const configuredAuthorization = findConfiguredHeader("authorization");
const configuredCookie = findConfiguredHeader("cookie");
let headerBearer: string | undefined;
if (!config.apiToken && configuredAuthorization !== undefined) {
  if (/[\r\n]/.test(configuredAuthorization)) {
    throw new Error("Configured Authorization header contains illegal CR/LF characters.");
  }
  const match = /^Bearer\s+(.+)$/i.exec(configuredAuthorization);
  if (!match) {
    throw new Error("Configured Authorization header must use the Bearer scheme.");
  }
  headerBearer = match[1];
}

const sessionBearer = config.apiToken || headerBearer;
const sessionCookie = config.authMode === "oauth" || sessionBearer
  ? undefined
  : config.cookie || configuredCookie;
const authSession = new AuthSession({
  baseUrl: config.baseUrl,
  bearer: sessionBearer,
  cookie: sessionCookie,
  email: config.authMode === "oauth" || sessionBearer || sessionCookie ? undefined : config.email,
  password: config.authMode === "oauth" || sessionBearer || sessionCookie ? undefined : config.password,
});

// The process-scoped AuthSession owns credentials after configuration is loaded.
config.email = undefined;
config.password = undefined;

if (loginMode === "async" && authSession.requiresLogin) {
  authSession.start();
}

// Startup diagnostics (visible in Claude Code MCP server logs via stderr)
console.error(`[affine-mcp] Config: ${CONFIG_FILE} (${existsSync(CONFIG_FILE) ? 'found' : 'missing'})`);
console.error(`[affine-mcp] Endpoint: ${config.graphqlEndpoint}`);
const authSource = authSession.hasConfiguredAuth ? authSession.source : "not configured";
console.error(`[affine-mcp] Auth: ${authSource}`);
if (authSource === "not configured") {
  console.error("[affine-mcp] WARNING: No authentication configured. Some operations may fail.");
  console.error("[affine-mcp] Set AFFINE_API_TOKEN or run: affine-mcp login");
}
console.error(`[affine-mcp] HTTP auth mode: ${config.authMode}`);

console.error(`[affine-mcp] Workspace: ${config.defaultWorkspaceId ? 'set' : '(none)'}`);

assertOAuthServiceWritePolicy({
  authMode: config.authMode,
  allowServiceWrites: config.oauthAllowServiceWrites,
  enabledWriteTools: toolFilter.enabledWriteTools,
});
if (
  config.authMode === "oauth"
  && config.oauthAllowServiceWrites
  && toolFilter.enabledWriteTools.length > 0
) {
  console.error(
    "[affine-mcp] WARNING: OAuth service-account writes are enabled. Every authorized OAuth caller " +
    "can mutate AFFiNE with the shared AFFINE_API_TOKEN permissions.",
  );
}

async function buildServer() {
  const server = new McpServer({ name: "affine-mcp", version: VERSION });
  const gqlHeaders = { ...(config.headers || {}) };

  // Initialize GraphQL client with authentication
  const gql = new GraphQLClient({
    endpoint: config.graphqlEndpoint,
    headers: gqlHeaders,
    authProvider: () => authSession.ready(),
  });


  const originalRegisterTool = (server as any).registerTool?.bind(server);
  if (typeof originalRegisterTool !== "function") {
    const message =
      "[affine-mcp] server.registerTool not found - tool filtering cannot be enforced. " +
      "The MCP SDK API may have changed.";
    throw new Error(`${message} Refusing to start because the canonical tool surface cannot be enforced.`);
  } else {
    (server as any).registerTool = (name: string, options: any, handler: any) => {
      if (!toolFilter.isEnabled(name)) return;
      const outputSchema = options?.outputSchema ?? toolOutputSchemaFor(name);
      return originalRegisterTool(name, {
        ...options,
        ...(outputSchema ? { outputSchema } : {}),
        annotations: {
          ...toolAnnotationsFor(name),
          ...(options?.annotations || {}),
        },
      }, handler);
    };
  }
  console.error(`[affine-mcp] Tool profile: ${toolFilter.profile}`);
  console.error(`[affine-mcp] Disabled groups: ${toolFilterEnvironment.AFFINE_DISABLED_GROUPS || "(none)"}`);
  console.error(`[affine-mcp] Disabled tools: ${toolFilterEnvironment.AFFINE_DISABLED_TOOLS || "(none)"}`);
  console.error(`[affine-mcp] Enabled tools: ${toolFilter.enabledTools.length}/${toolFilter.totalToolCount}`);

  registerWorkspaceTools(server, gql);
  registerDocTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerCommentTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerHistoryTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerOrganizeTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerPropertyTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerIconTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  registerUserTools(server, gql);
  registerUserCRUDTools(server, gql);
  if (config.authMode !== "oauth") {
    registerAuthTools(server, gql, config.baseUrl);
  }
  registerAccessTokenTools(server, gql);
  registerBlobTools(server, gql);
  registerNotificationTools(server, gql);
  return server;
}

async function start() {
  if (loginMode === "sync" && authSession.requiresLogin) {
    await authSession.ready();
  }

  if (useHttpTransport) {
    await startHttpMcpServer(buildServer, config);
  } else {
    // stdio transport is the default for typical desktop MCP clients
    const server = await buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

start().catch((err) => {
  console.error("Failed to start affine-mcp server:", err);
  process.exit(1);
});
