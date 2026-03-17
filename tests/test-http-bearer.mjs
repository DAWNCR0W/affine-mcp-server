#!/usr/bin/env node
/**
 * Integration test for HTTP bearer-token protection on /mcp.
 *
 * Covers:
 * - /healthz and /readyz
 * - 401 for missing/invalid bearer token
 * - query-string token fallback
 * - valid static bearer auth over Streamable HTTP
 */
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.resolve(PROJECT_DIR, "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || "60000");

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForSuccessfulFetch(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // ignore until timeout
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function generateAffineApiToken() {
  const client = new Client({ name: "affine-mcp-http-bearer-token", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: PROJECT_DIR,
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-http-bearer-token-noconfig",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[stdio-token] ${chunk}`);
  });

  await client.connect(transport);
  try {
    const tokenResult = await client.callTool(
      { name: "generate_access_token", arguments: { name: `http-bearer-${Date.now()}` } },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const parsed = parseContent(tokenResult);
    expectTruthy(parsed?.token, "generate_access_token token");
    return parsed.token;
  } finally {
    await transport.close();
  }
}

async function startBearerHttpServer(affineApiToken, staticToken) {
  const port = await findFreePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const child = spawn("node", [MCP_SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(port),
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_API_TOKEN: affineApiToken,
      AFFINE_MCP_AUTH_MODE: "bearer",
      AFFINE_MCP_HTTP_HOST: "127.0.0.1",
      AFFINE_MCP_HTTP_TOKEN: staticToken,
      XDG_CONFIG_HOME: "/tmp/affine-mcp-http-bearer-server-noconfig",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", chunk => process.stderr.write(`[http-bearer-server] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[http-bearer-server] ${chunk}`));

  await waitForSuccessfulFetch(`${publicBaseUrl}/healthz`);

  return {
    child,
    publicBaseUrl,
    mcpUrl: `${publicBaseUrl}/mcp`,
    async close() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function main() {
  console.log("=== HTTP Bearer Integration Test ===");
  console.log(`AFFiNE Base URL: ${BASE_URL}`);
  console.log();

  const affineApiToken = await generateAffineApiToken();
  const staticToken = `http-bearer-${Date.now()}`;
  const server = await startBearerHttpServer(affineApiToken, staticToken);

  try {
    const healthz = await fetch(`${server.publicBaseUrl}/healthz`);
    expectEqual(healthz.status, 200, "healthz status");
    const readyz = await fetch(`${server.publicBaseUrl}/readyz`);
    expectEqual(readyz.status, 200, "readyz status");

    const initializeBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "http-bearer-test", version: "1.0.0" },
      },
    };

    const unauthorized = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeBody),
    });
    expectEqual(unauthorized.status, 401, "missing bearer token status");

    const invalidToken = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify(initializeBody),
    });
    expectEqual(invalidToken.status, 401, "invalid bearer token status");

    const queryTokenResponse = await fetch(`${server.mcpUrl}?token=${encodeURIComponent(staticToken)}`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
    });
    if (queryTokenResponse.status === 401) {
      throw new Error("query-string token was rejected before reaching the MCP handler");
    }

    const client = new Client({ name: "http-bearer-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${staticToken}`,
        },
      },
    });

    await client.connect(transport);
    try {
      const currentUser = parseContent(await client.callTool({ name: "current_user", arguments: {} }));
      expectEqual(currentUser?.email, EMAIL, "current_user via http bearer");
    } finally {
      await transport.close();
    }

    console.log();
    console.log("=== HTTP bearer integration test passed ===");
  } finally {
    await server.close();
  }
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
