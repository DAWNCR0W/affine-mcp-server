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
import { startHttpMcpServer } from "./sse.js";
import { existsSync } from "fs";
import { CONFIG_FILE } from "./config.js";

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
const config = loadConfig();
const transportMode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const useHttpTransport =
  transportMode === "sse" || transportMode === "http" || transportMode === "streamable";

// ---------------------------------------------------------------------------
// Tool filtering — parsed once at module load (not per-session in HTTP mode)
// ---------------------------------------------------------------------------
const KNOWN_GROUPS = new Set<string>([
  "workspaces", "docs", "comments", "history",
  "users", "access_tokens", "blobs", "notifications",
]);

const DISABLED_GROUPS = new Set<string>(
  (process.env.AFFINE_DISABLED_GROUPS || "")
    .split(",")
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean),
);

const DISABLED_TOOLS = new Set<string>(
  (process.env.AFFINE_DISABLED_TOOLS || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean),
);

// Startup diagnostics (visible in Claude Code MCP server logs via stderr)
console.error(`[affine-mcp] Config: ${CONFIG_FILE} (${existsSync(CONFIG_FILE) ? 'found' : 'missing'})`);
console.error(`[affine-mcp] Endpoint: ${config.baseUrl}${config.graphqlPath}`);
const hasAuth = !!(config.apiToken || config.cookie || (config.email && config.password));
console.error(`[affine-mcp] Auth: ${hasAuth ? 'configured' : 'not configured'}`);
console.error(`[affine-mcp] HTTP auth mode: ${config.authMode}`);
if (hasAuth && config.baseUrl.startsWith("http://")
    && !config.baseUrl.includes("localhost")
    && !config.baseUrl.includes("127.0.0.1")) {
  console.error("WARNING: Credentials configured over plain HTTP. Use HTTPS for remote servers.");
}
console.error(`[affine-mcp] Workspace: ${config.defaultWorkspaceId ? 'set' : '(none)'}`);

// Warn about unknown group names (likely typos) before they silently do nothing
for (const g of DISABLED_GROUPS) {
  if (!KNOWN_GROUPS.has(g)) {
    console.error(
      `[affine-mcp] WARNING: Unknown group "${g}" in AFFINE_DISABLED_GROUPS — ` +
      `valid groups: ${[...KNOWN_GROUPS].join(", ")}`
    );
  }
}

if (config.authMode === "oauth" && !useHttpTransport) {
  throw new Error("AFFINE_MCP_AUTH_MODE=oauth requires MCP_TRANSPORT=http (or streamable/sse).");
}

async function buildServer() {
  const server = new McpServer({ name: "affine-mcp", version: VERSION });
  const gqlHeaders = { ...(config.headers || {}) };
  const gqlBearer = config.apiToken;

  if (config.authMode === "oauth") {
    if (!gqlBearer) {
      throw new Error("AFFINE_API_TOKEN is required when AFFINE_MCP_AUTH_MODE=oauth.");
    }
    if (config.cookie || config.email || config.password) {
      console.error(
        "[affine-mcp] OAuth mode uses the configured AFFINE_API_TOKEN service credential. " +
        "Ignoring AFFINE_COOKIE / AFFINE_EMAIL / AFFINE_PASSWORD.",
      );
    }
    delete gqlHeaders.Cookie;
    if (process.env.AFFINE_LOGIN_AT_START) {
      console.error("[affine-mcp] AFFINE_LOGIN_AT_START is ignored when AFFINE_MCP_AUTH_MODE=oauth.");
    }
  }

  // Initialize GraphQL client with authentication
  const gql = new GraphQLClient({
    endpoint: `${config.baseUrl}${config.graphqlPath}`,
    headers: gqlHeaders,
    bearer: gqlBearer
  });

  // Try email/password authentication if no other auth method is configured.
  // To avoid startup timeouts in MCP clients, default to async login after the stdio handshake.
  if (config.authMode !== "oauth" && !gql.isAuthenticated() && config.email && config.password) {
    const mode = (process.env.AFFINE_LOGIN_AT_START || "async").toLowerCase();
    // In HTTP transport mode, buildServer() is called per session, so credentials
    // must be retained for subsequent sessions. Only clear in stdio mode (single session).
    const isHttpTransport = ["sse", "http", "streamable"].includes(
      (process.env.MCP_TRANSPORT || "stdio").toLowerCase()
    );
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
        if (!isHttpTransport) {
          config.password = undefined;
          config.email = undefined;
        }
      }
    } else {
      console.error("No token/cookie; deferring email/password authentication (async after connect)...");
      // Capture credentials before clearing — async login needs them.
      const loginEmail = config.email!;
      const loginPassword = config.password!;
      if (!isHttpTransport) {
        config.password = undefined;
        config.email = undefined;
      }
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

  // ---------------------------------------------------------------------------
  // Per-tool blacklist: patch registerTool on this server instance so individual
  // tools in AFFINE_DISABLED_TOOLS are silently skipped during registration.
  // All tool files use server.registerTool exclusively — no need to patch server.tool.
  // ---------------------------------------------------------------------------
  if (DISABLED_TOOLS.size > 0) {
    const originalRegisterTool = (server as any).registerTool?.bind(server);
    if (typeof originalRegisterTool !== "function") {
      console.error(
        "[affine-mcp] WARNING: server.registerTool not found — " +
        "AFFINE_DISABLED_TOOLS will have no effect. " +
        "The MCP SDK API may have changed."
      );
    } else {
      (server as any).registerTool = (name: string, options: any, handler: any) => {
        if (DISABLED_TOOLS.has(name)) return;
        return originalRegisterTool(name, options, handler);
      };
    }
  }

  // Log filters directly from environment variables
  console.error(`[affine-mcp] Disabled groups: ${process.env.AFFINE_DISABLED_GROUPS || "(none)"}`);
  console.error(`[affine-mcp] Disabled tools: ${process.env.AFFINE_DISABLED_TOOLS || "(none)"}`);

  if (!DISABLED_GROUPS.has("workspaces")) registerWorkspaceTools(server, gql);
  if (!DISABLED_GROUPS.has("docs")) registerDocTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  if (!DISABLED_GROUPS.has("comments")) registerCommentTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  if (!DISABLED_GROUPS.has("history")) registerHistoryTools(server, gql, { workspaceId: config.defaultWorkspaceId });
  if (!DISABLED_GROUPS.has("users")) {
    registerUserTools(server, gql);
    registerUserCRUDTools(server, gql);
    if (config.authMode !== "oauth") {
      registerAuthTools(server, gql, config.baseUrl);
    }
  }
  if (!DISABLED_GROUPS.has("access_tokens")) registerAccessTokenTools(server, gql);
  if (!DISABLED_GROUPS.has("blobs")) registerBlobTools(server, gql);
  if (!DISABLED_GROUPS.has("notifications")) registerNotificationTools(server, gql);

  return server;
}

async function start() {
  if (useHttpTransport) {
    const DEFAULT_PORT = 3000;
    const portEnvValue = process.env.PORT;

    let port = DEFAULT_PORT;

    // Validate the HTTP server port if provided.
    if (portEnvValue != null && portEnvValue.trim() !== "") {
      const parsedPort = Number(portEnvValue);

      if (Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535) {
        port = parsedPort;
      } else {
        console.warn(
          `[affine-mcp] Invalid PORT "${portEnvValue}" (expected 0..65535 integer). Falling back to ${DEFAULT_PORT}.`
        );
      }
    }

    await startHttpMcpServer(buildServer, port, config);
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
