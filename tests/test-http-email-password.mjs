#!/usr/bin/env node
/**
 * Integration test for HTTP transport using AFFiNE email/password auth.
 *
 * Reproduces the multi-session flow where buildServer() is invoked for each
 * Streamable HTTP session. Credentials must remain available so each new
 * session can authenticate successfully.
 */
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.resolve(PROJECT_DIR, "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
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
      // Ignore until timeout.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startEmailPasswordHttpServer() {
  const port = await findFreePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const child = spawn("node", [MCP_SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(port),
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      AFFINE_MCP_HTTP_HOST: "127.0.0.1",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-http-email-password-server-noconfig",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", chunk => process.stderr.write(`[http-email-server] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[http-email-server] ${chunk}`));

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

async function assertCurrentUserForFreshSession(mcpUrl, label) {
  const client = new Client({ name: `http-email-password-${label}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  await client.connect(transport);
  try {
    const currentUser = parseContent(await client.callTool({ name: "current_user", arguments: {} }));
    expectEqual(currentUser?.email, EMAIL, `${label} session current_user email`);
  } finally {
    await transport.close();
  }
}

async function main() {
  console.log("=== HTTP Email/Password Integration Test ===");
  console.log(`AFFiNE Base URL: ${BASE_URL}`);
  console.log();

  const server = await startEmailPasswordHttpServer();
  try {
    const readyz = await fetch(`${server.publicBaseUrl}/readyz`);
    expectEqual(readyz.status, 200, "readyz status");

    await assertCurrentUserForFreshSession(server.mcpUrl, "first");
    await assertCurrentUserForFreshSession(server.mcpUrl, "second");

    console.log();
    console.log("=== HTTP email/password integration test passed ===");
  } finally {
    await server.close();
  }
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
