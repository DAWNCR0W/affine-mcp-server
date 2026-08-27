#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect as connectTcp } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  loadHttpRuntimeConfig,
  parseBodyLimit,
} from "../src/httpRuntimeConfig.ts";
import { startHttpMcpServer } from "../src/sse.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(PROJECT_DIR, "dist", "index.js");
const RUNTIME_ENV_KEYS = [
  "AFFINE_MCP_HTTP_BODY_LIMIT",
  "AFFINE_MCP_HTTP_MAX_SESSIONS",
  "AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS",
  "AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS",
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
  for (const key of RUNTIME_ENV_KEYS) delete env[key];
  delete env.AFFINE_MCP_HTTP_TOKEN;
  return {
    ...env,
    MCP_TRANSPORT: "http",
    PORT: String(port),
    AFFINE_BASE_URL: "http://127.0.0.1:3010",
    AFFINE_API_TOKEN: "test-affine-api-token",
    AFFINE_MCP_AUTH_MODE: "bearer",
    AFFINE_MCP_HTTP_HOST: "127.0.0.1",
    XDG_CONFIG_HOME: `/tmp/affine-mcp-http-runtime-${process.pid}-${port}`,
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

async function waitForExit(child, timeoutMs = 4_000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    delay(timeoutMs).then(() => null),
  ]);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const result = await waitForExit(child);
  if (!result) {
    child.kill("SIGKILL");
    await waitForExit(child);
    throw new Error("HTTP server did not stop after SIGTERM");
  }
  assertEqual(result.code, 0, "HTTP server shutdown exit code");
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
  return { ...spawned, baseUrl, port, close: () => stopServer(spawned.child) };
}

async function expectStartupFailure(overrides, expectedMessage, port) {
  const targetPort = port ?? await findFreePort();
  const spawned = spawnServer(targetPort, overrides);
  const result = await waitForExit(spawned.child, 5_000);
  if (!result) {
    spawned.child.kill("SIGKILL");
    await waitForExit(spawned.child);
    throw new Error(`Expected startup failure but server stayed running: ${JSON.stringify(spawned.logs())}`);
  }
  assertEqual(result.code, 1, "startup failure exit code");
  assert(spawned.logs().stderr.includes(expectedMessage), `missing startup error: ${spawned.logs().stderr}`);
}

async function readJson(response) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Expected JSON response, got ${response.status}: ${body}`);
  }
}

function initializeBody(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-runtime-test", version: "1.0.0" },
    },
  };
}

async function postMcp(baseUrl, body, sessionId) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function initializeSession(baseUrl, id) {
  const response = await postMcp(baseUrl, initializeBody(id));
  const responseBody = await response.text();
  assertEqual(response.status, 200, `initialize session ${id}: ${responseBody}`);
  const sessionId = response.headers.get("mcp-session-id");
  assert(sessionId, `initialize session ${id} did not return mcp-session-id`);
  return sessionId;
}

async function waitForSessionCapacity(baseUrl, id, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await postMcp(baseUrl, initializeBody(id));
    if (response.status === 200) {
      await response.body?.cancel();
      return;
    }
    assertEqual(response.status, 503, "session capacity polling status");
    await response.body?.cancel();
    await delay(100);
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for session capacity`);
}

async function testRuntimeConfig() {
  assertEqual(parseBodyLimit(undefined), 4 * 1024 * 1024, "default body limit");
  assertEqual(parseBodyLimit("1kb"), 1024, "kilobyte body limit");
  assertEqual(parseBodyLimit("1.5mb"), 1.5 * 1024 * 1024, "fractional megabyte body limit");
  assertThrows(() => parseBodyLimit("512b"), "between 1kb and 64mb", "too-small body limit");
  assertThrows(() => parseBodyLimit("1gb"), "must be a byte size", "unsupported body limit unit");

  const parsed = loadHttpRuntimeConfig({
    AFFINE_MCP_HTTP_BODY_LIMIT: "2kb",
    AFFINE_MCP_HTTP_MAX_SESSIONS: "1",
    AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "600",
    AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "100",
  });
  assertEqual(parsed.bodyLimitBytes, 2048, "configured body limit");
  assertEqual(parsed.maxSessions, 1, "configured session limit");
  assertEqual(parsed.sessionIdleTimeoutMs, 600, "configured idle timeout");
  assertEqual(parsed.shutdownTimeoutMs, 100, "configured shutdown timeout");
  assertThrows(
    () => loadHttpRuntimeConfig({ AFFINE_MCP_HTTP_MAX_SESSIONS: "0" }),
    "must be an integer between 1 and 10000",
    "invalid max sessions",
  );
}

async function testStartupErrors() {
  await expectStartupFailure(
    { AFFINE_MCP_HTTP_MAX_SESSIONS: "0" },
    "AFFINE_MCP_HTTP_MAX_SESSIONS must be an integer",
  );

  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  try {
    await expectStartupFailure({}, "EADDRINUSE", address.port);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
}

async function testBodyLimitErrors() {
  const server = await startHealthyServer({ AFFINE_MCP_HTTP_BODY_LIMIT: "1kb" });
  try {
    const oversized = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(2_048) }),
    });
    assertEqual(oversized.status, 413, "oversized JSON status");
    const oversizedBody = await readJson(oversized);
    assertEqual(oversizedBody.error?.code, -32001, "oversized JSON error code");

    const malformed = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"broken\":",
    });
    assertEqual(malformed.status, 400, "malformed JSON status");
    const malformedBody = await readJson(malformed);
    assertEqual(malformedBody.error?.code, -32700, "malformed JSON error code");
  } finally {
    await server.close();
  }
}

async function testUnknownSessionReturnsNotFound() {
  const server = await startHealthyServer();
  try {
    const unknownSessionId = "00000000-0000-0000-0000-000000000000";
    const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

    const unknownPost = await postMcp(server.baseUrl, toolsList, unknownSessionId);
    assertEqual(unknownPost.status, 404, "unknown-session POST status");
    const unknownPostBody = await readJson(unknownPost);
    assertEqual(unknownPostBody.error?.code, -32001, "unknown-session POST error code");
    assertEqual(
      unknownPostBody.error?.message,
      "Session not found",
      "unknown-session POST error",
    );

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${server.baseUrl}/mcp`, {
        method,
        headers: {
          Accept: "application/json, text/event-stream",
          "mcp-session-id": unknownSessionId,
        },
      });
      assertEqual(response.status, 404, `unknown-session ${method} status`);
      await response.body?.cancel();
    }

    const missingSession = await postMcp(server.baseUrl, toolsList);
    assertEqual(missingSession.status, 400, "missing-session non-initialize status");
    await missingSession.body?.cancel();
  } finally {
    await server.close();
  }
}

async function testSessionCapacityActivityAndIdleCleanup() {
  const server = await startHealthyServer({
    AFFINE_MCP_HTTP_MAX_SESSIONS: "1",
    AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "4000",
  });
  try {
    const firstSessionId = await initializeSession(server.baseUrl, 1);

    const full = await postMcp(server.baseUrl, initializeBody(2));
    assertEqual(full.status, 503, "session capacity status");
    assertEqual((await readJson(full)).error?.code, -32002, "session capacity error code");

    await delay(2200);
    const activity = await postMcp(
      server.baseUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      firstSessionId,
    );
    assert([200, 202, 204].includes(activity.status), `session activity status: ${activity.status}`);
    await activity.body?.cancel();

    await delay(2200);
    const stillFull = await postMcp(server.baseUrl, initializeBody(3));
    assertEqual(stillFull.status, 503, "session activity refreshes idle deadline");
    await stillFull.body?.cancel();

    await waitForSessionCapacity(server.baseUrl, 4);
    assert(server.logs().stderr.includes("idle timeout"), "idle cleanup should be logged");
  } finally {
    await server.close();
  }
}

async function testShutdownWithActiveSession() {
  const server = await startHealthyServer({
    AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "60000",
    AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "1000",
  });
  await initializeSession(server.baseUrl, 10);

  const startedAt = Date.now();
  server.child.kill("SIGTERM");
  const result = await waitForExit(server.child, 2_000);
  assert(result, `server did not exit: ${JSON.stringify(server.logs())}`);
  assertEqual(result.code, 0, "active-session shutdown exit code");
  assert(Date.now() - startedAt < 1_500, "active-session shutdown exceeded deadline");
  assert(!server.logs().stderr.includes("forcing remaining"), "transport close should unblock HTTP close");
}

async function testForcedConnectionDeadline() {
  const server = await startHealthyServer({
    AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "100",
  });
  const socket = connectTcp(server.port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    socket.write(
      "POST /mcp HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${server.port}\r\n` +
        "Content-Type: application/json\r\n" +
        "Content-Length: 100000\r\n\r\n{",
      error => error ? reject(error) : resolve(),
    );
  });
  await delay(100);

  server.child.kill("SIGTERM");
  const result = await waitForExit(server.child, 2_000);
  socket.destroy();
  assert(result, `server did not force-close incomplete connection: ${JSON.stringify(server.logs())}`);
  assertEqual(result.code, 0, "forced shutdown exit code");
  assert(server.logs().stderr.includes("forcing remaining HTTP connections closed"), "forced close should be logged");
}

async function testInitializeRequestSurvivesIdleSweep() {
  const previousIdleTimeout = process.env.AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS;
  process.env.AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS = "100";
  let releaseRequest;
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  let handle;
  try {
    handle = await startHttpMcpServer(
      async () => {
        const server = new McpServer({ name: "runtime-idle-test", version: "1.0.0" });
        const connect = server.connect.bind(server);
        server.connect = async (transport) => {
          await connect(transport);
          const handleRequest = transport.handleRequest.bind(transport);
          transport.handleRequest = async (...args) => {
            await handleRequest(...args);
            await requestGate;
          };
        };
        return server;
      },
      {
        baseUrl: "http://127.0.0.1:3010",
        graphqlEndpoint: "http://127.0.0.1:3010/graphql",
        graphqlPath: "/graphql",
        authMode: "bearer",
        oauthScopes: ["mcp"],
        oauthClockSkewSeconds: 60,
        transportMode: "http",
        loginAtStart: "async",
        http: {
          host: "127.0.0.1",
          port: 0,
          allowedOrigins: [],
          allowAllOrigins: false,
        },
        oauthAllowServiceWrites: false,
      },
    );

    const response = await postMcp(`http://127.0.0.1:${handle.port}`, initializeBody(20));
    assertEqual(response.status, 200, "delayed initialize response status");
    await response.body?.cancel();
    await delay(150);
    assertEqual(handle.sessionCount(), 1, "initialize request remains active during idle sweep");
  } finally {
    releaseRequest?.();
    await handle?.close("Idle sweep test shutdown");
    if (previousIdleTimeout === undefined) delete process.env.AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS;
    else process.env.AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS = previousIdleTimeout;
  }
}

async function testIdempotentProgrammaticClose() {
  const previousHost = process.env.AFFINE_MCP_HTTP_HOST;
  process.env.AFFINE_MCP_HTTP_HOST = "127.0.0.1";
  try {
    const handle = await startHttpMcpServer(
      async () => new McpServer({ name: "runtime-close-test", version: "1.0.0" }),
      {
        baseUrl: "http://127.0.0.1:3010",
        graphqlEndpoint: "http://127.0.0.1:3010/graphql",
        graphqlPath: "/graphql",
        authMode: "bearer",
        oauthScopes: ["mcp"],
        oauthClockSkewSeconds: 60,
        transportMode: "http",
        loginAtStart: "async",
        http: {
          host: "127.0.0.1",
          port: 0,
          allowedOrigins: [],
          allowAllOrigins: false,
        },
        oauthAllowServiceWrites: false,
      },
    );
    const first = handle.close("Test shutdown");
    const second = handle.close("Duplicate shutdown");
    assert(first === second, "programmatic close should return the same promise");
    await Promise.all([first, second]);
  } finally {
    if (previousHost === undefined) delete process.env.AFFINE_MCP_HTTP_HOST;
    else process.env.AFFINE_MCP_HTTP_HOST = previousHost;
  }
}

async function main() {
  assert(existsSync(SERVER_PATH), "dist/index.js is missing; run npm run build first");
  await testRuntimeConfig();
  await testStartupErrors();
  await testBodyLimitErrors();
  await testUnknownSessionReturnsNotFound();
  await testSessionCapacityActivityAndIdleCleanup();
  await testShutdownWithActiveSession();
  await testForcedConnectionDeadline();
  await testInitializeRequestSurvivesIdleSweep();
  await testIdempotentProgrammaticClose();
  console.log("HTTP runtime safety regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
