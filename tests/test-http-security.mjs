#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { validateBaseUrl } from "../src/config.ts";
import { createHttpAuthState } from "../src/httpAuth.ts";
import {
  isLoopbackHostname,
  isRemotePlainHttpUrl,
  parseBooleanFlag,
} from "../src/networkSecurity.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(PROJECT_DIR, "dist", "index.js");
const SECURITY_ENV_KEYS = [
  "AFFINE_ALLOW_INSECURE_HTTP",
  "AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN",
  "AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED",
  "AFFINE_MCP_HTTP_TOKEN",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, expectedMessage, message) {
  try {
    fn();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert(detail.includes(expectedMessage), `${message}: unexpected error: ${detail}`);
    return;
  }
  throw new Error(`${message}: expected an error`);
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function serverEnvironment(port, overrides = {}) {
  const env = { ...process.env };
  for (const key of SECURITY_ENV_KEYS) delete env[key];
  return {
    ...env,
    MCP_TRANSPORT: "http",
    PORT: String(port),
    AFFINE_BASE_URL: "http://127.0.0.1:3010",
    AFFINE_API_TOKEN: "test-affine-api-token",
    AFFINE_MCP_AUTH_MODE: "bearer",
    AFFINE_MCP_HTTP_HOST: "127.0.0.1",
    XDG_CONFIG_HOME: `/tmp/affine-mcp-http-security-${process.pid}-${port}`,
    ...overrides,
  };
}

function spawnServer(port, overrides = {}) {
  const child = spawn("node", [SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: serverEnvironment(port, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return { child, logs: () => ({ stdout, stderr }) };
}

async function waitForHealth(child, url, logs, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming healthy: ${JSON.stringify(logs())}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // Retry until the startup deadline.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(logs())}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(4_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    throw new Error("HTTP server did not stop after SIGTERM");
  }
}

async function startHealthyServer(overrides = {}) {
  const port = await findFreePort();
  const spawned = spawnServer(port, overrides);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(spawned.child, `${baseUrl}/healthz`, spawned.logs);
  } catch (error) {
    if (spawned.child.exitCode === null) spawned.child.kill("SIGKILL");
    throw error;
  }
  return { ...spawned, baseUrl, close: () => stopServer(spawned.child) };
}

async function expectStartupFailure(overrides, expectedMessage) {
  const port = await findFreePort();
  const spawned = spawnServer(port, overrides);
  const result = await Promise.race([
    new Promise((resolve) => spawned.child.once("exit", (code) => resolve({ exited: true, code }))),
    delay(5_000).then(() => ({ exited: false, code: null })),
  ]);
  if (!result.exited) {
    spawned.child.kill("SIGKILL");
    await new Promise((resolve) => spawned.child.once("exit", resolve));
    throw new Error(`Expected startup failure but server stayed running: ${JSON.stringify(spawned.logs())}`);
  }
  assertEqual(result.code, 1, "startup failure exit code");
  assert(spawned.logs().stderr.includes(expectedMessage), `missing startup error: ${spawned.logs().stderr}`);
}

async function expectStatusFailure(overrides, expectedMessage) {
  const child = spawn("node", [SERVER_PATH, "status", "--json"], {
    cwd: PROJECT_DIR,
    env: serverEnvironment(0, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const result = await Promise.race([
    new Promise(resolve => child.once("exit", code => resolve({ exited: true, code }))),
    delay(5_000).then(() => ({ exited: false, code: null })),
  ]);
  if (!result.exited) {
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
    throw new Error(`Expected status failure but command stayed running: ${stderr}`);
  }
  assertEqual(result.code, 1, "status failure exit code");
  assert(stderr.includes(expectedMessage), `missing status error: ${stderr}`);
}

async function readJson(response) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Expected JSON response, got ${response.status}: ${body}`);
  }
}

function invokeAuthMiddleware(state, query) {
  let nextCalled = false;
  const response = {
    statusCode: 200,
    body: undefined,
    headers: {},
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };

  state.authMiddleware(
    { method: "GET", query, headers: {} },
    response,
    () => { nextCalled = true; },
  );
  return { nextCalled, response };
}

function testQueryTokenShapeRejection() {
  const commonConfig = {
    baseUrl: "http://127.0.0.1:3010",
    graphqlPath: "/graphql",
    oauthScopes: ["mcp"],
    oauthClockSkewSeconds: 60,
  };
  const oauth = createHttpAuthState(
    {
      ...commonConfig,
      authMode: "oauth",
      publicBaseUrl: "http://127.0.0.1:3100",
      oauthIssuerUrl: "http://127.0.0.1:3200",
    },
    { allowAnyOrigin: false },
  );
  const bearer = createHttpAuthState(
    { ...commonConfig, authMode: "bearer" },
    {
      allowAnyOrigin: false,
      allowQueryToken: false,
      httpAuthToken: "static-test-token",
    },
  );

  const queryTokenShapes = [
    ["string", "one"],
    ["duplicate/array", ["one", "two"]],
    ["object", { value: "one" }],
  ];
  for (const [label, token] of queryTokenShapes) {
    for (const [mode, state] of [["oauth", oauth], ["bearer", bearer]]) {
      const { nextCalled, response } = invokeAuthMiddleware(state, { token });
      assertEqual(response.statusCode, 400, `${mode} ${label} query token status`);
      assertEqual(response.body?.error, "invalid_request", `${mode} ${label} query token error`);
      assertEqual(nextCalled, false, `${mode} ${label} query token must not call next`);
    }
  }
}

async function testNetworkPolicyHelpers() {
  const loopbackHosts = ["localhost", "LOCALHOST", "127.0.0.1", "127.255.255.255", "::1", "[::1]"];
  for (const host of loopbackHosts) {
    assert(isLoopbackHostname(host), `${host} should be loopback`);
  }
  const remoteHosts = ["0.0.0.0", "::", "192.168.1.10", "10.0.0.4", "example.com", "127.0.0.256"];
  for (const host of remoteHosts) {
    assert(!isLoopbackHostname(host), `${host} should not be loopback`);
  }

  assert(isRemotePlainHttpUrl(new URL("http://192.0.2.10")), "remote HTTP URL should be insecure");
  assert(!isRemotePlainHttpUrl(new URL("https://192.0.2.10")), "remote HTTPS URL should be secure");
  assert(!isRemotePlainHttpUrl(new URL("http://127.0.0.1:3010")), "loopback HTTP URL should be allowed");

  assertThrows(
    () => validateBaseUrl("http://192.0.2.10", { label: "AFFINE_BASE_URL" }),
    "must use HTTPS",
    "remote plain HTTP rejection",
  );
  assertEqual(
    validateBaseUrl("http://192.0.2.10/", { allowInsecureHttp: true, label: "AFFINE_BASE_URL" }),
    "http://192.0.2.10",
    "explicit remote plain HTTP opt-in",
  );
  assertEqual(validateBaseUrl("http://127.0.0.1:3010/"), "http://127.0.0.1:3010", "loopback URL");

  assertEqual(parseBooleanFlag("FLAG", undefined), false, "undefined boolean flag");
  assertEqual(parseBooleanFlag("FLAG", "true"), true, "true boolean flag");
  assertEqual(parseBooleanFlag("FLAG", "FALSE"), false, "false boolean flag");
  assertThrows(() => parseBooleanFlag("FLAG", "yes"), "must be either", "ambiguous boolean flag");

  await expectStatusFailure(
    { AFFINE_BASE_URL: "http://192.0.2.10" },
    "must use HTTPS",
  );
}

async function testRemoteBindPolicy() {
  await expectStartupFailure(
    { AFFINE_MCP_HTTP_HOST: "0.0.0.0" },
    "Refusing to bind the HTTP MCP server to non-loopback host",
  );

  const local = await startHealthyServer();
  try {
    const health = await fetch(`${local.baseUrl}/healthz`);
    assertEqual(health.status, 200, "local unauthenticated health status");
    assertEqual((await readJson(health)).protected, false, "local server protection state");

    const mcp = await fetch(`${local.baseUrl}/mcp`);
    assertEqual(mcp.status, 400, "local unauthenticated MCP reaches protocol handler");
    assertEqual((await readJson(mcp)).jsonrpc, "2.0", "local MCP protocol response");
  } finally {
    await local.close();
  }

  const explicitlyUnsafe = await startHealthyServer({
    AFFINE_MCP_HTTP_HOST: "0.0.0.0",
    AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED: "true",
  });
  try {
    const health = await fetch(`${explicitlyUnsafe.baseUrl}/healthz`);
    assertEqual(health.status, 200, "explicit unsafe opt-in health status");
    assert(
      explicitlyUnsafe.logs().stderr.includes("Do not expose this listener to an untrusted network"),
      "explicit unsafe opt-in should emit a warning",
    );
  } finally {
    await explicitlyUnsafe.close();
  }
}

async function testBearerTokenPolicy() {
  const token = "static-test-token";
  const server = await startHealthyServer({ AFFINE_MCP_HTTP_TOKEN: token });
  try {
    const health = await fetch(`${server.baseUrl}/healthz`);
    assertEqual(health.status, 200, "protected server health remains unauthenticated");
    assertEqual((await readJson(health)).protected, true, "protected server health metadata");
    const readiness = await fetch(`${server.baseUrl}/readyz`);
    assertEqual(readiness.status, 200, "protected server readiness remains unauthenticated");

    const missing = await fetch(`${server.baseUrl}/mcp`);
    assertEqual(missing.status, 401, "missing bearer token");

    const wrong = await fetch(`${server.baseUrl}/mcp`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assertEqual(wrong.status, 401, "incorrect bearer token");

    const query = await fetch(`${server.baseUrl}/mcp?token=${encodeURIComponent(token)}`);
    assertEqual(query.status, 400, "query token disabled status");
    const queryBody = await readJson(query);
    assertEqual(queryBody.error, "invalid_request", "query token disabled error");
    assert(
      queryBody.error_description.includes("Authorization header"),
      "query token rejection should explain the supported transport",
    );

    const authorized = await fetch(`${server.baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEqual(authorized.status, 400, "header token reaches MCP protocol handler");
    assertEqual((await readJson(authorized)).jsonrpc, "2.0", "authorized MCP protocol response");
  } finally {
    await server.close();
  }

  const legacy = await startHealthyServer({
    AFFINE_MCP_HTTP_TOKEN: token,
    AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN: "true",
  });
  try {
    const query = await fetch(`${legacy.baseUrl}/mcp?token=${encodeURIComponent(token)}`);
    assertEqual(query.status, 400, "legacy query token reaches MCP protocol handler");
    assertEqual((await readJson(query)).jsonrpc, "2.0", "legacy query token protocol response");
    assert(
      legacy.logs().stderr.includes("Query-string bearer tokens are enabled"),
      "legacy query token mode should emit a warning",
    );
  } finally {
    await legacy.close();
  }
}

async function main() {
  assert(existsSync(SERVER_PATH), "dist/index.js is missing; run npm run build first");
  testQueryTokenShapeRejection();
  await testNetworkPolicyHelpers();
  await testRemoteBindPolicy();
  await testBearerTokenPolicy();
  console.log("HTTP security regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
