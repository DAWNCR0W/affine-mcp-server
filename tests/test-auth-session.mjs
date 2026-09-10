#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { AuthSession, parseLoginMode } from "../src/authSession.ts";
import { loginWithPassword } from "../src/auth.ts";
import { GraphQLClient } from "../src/graphqlClient.ts";
import { resolveConfiguredAuth } from "../src/util/configuredAuth.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.resolve(PROJECT_DIR, "dist", "index.js");
const EMAIL = "auth-session@example.test";
const PASSWORD = "mock-password";
const COOKIE = "affine_session=shared-session";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function assertRejects(promise, expectedMessage, message) {
  try {
    await promise;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert(detail.includes(expectedMessage), `${message}: unexpected error: ${detail}`);
    return;
  }
  throw new Error(`${message}: expected a rejection`);
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

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function startMockAffine(options = {}) {
  let releaseLogin;
  const loginGate = options.blockLogin
    ? new Promise((resolve) => { releaseLogin = resolve; })
    : Promise.resolve();
  const state = {
    graphqlCalls: 0,
    graphqlHeaders: [],
    loginCompletedAt: 0,
    signInCalls: 0,
    unauthenticatedGraphqlCalls: 0,
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/api/auth/sign-in" && req.method === "POST") {
        state.signInCalls += 1;
        await readRequestBody(req);
        await loginGate;
        if (options.failLogin) {
          jsonResponse(res, 401, { error: "invalid credentials" });
          return;
        }
        state.loginCompletedAt = Date.now();
        jsonResponse(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}; Path=/; HttpOnly${options.cookieAttributes || ""}` });
        return;
      }

      if (req.url === "/graphql" && req.method === "POST") {
        state.graphqlCalls += 1;
        state.graphqlHeaders.push({
          authorization: req.headers.authorization || "",
          cookie: req.headers.cookie || "",
          tenant: req.headers["x-tenant"] || "",
          receivedAt: Date.now(),
        });
        await readRequestBody(req);
        if (req.headers.cookie !== COOKIE || req.headers.authorization) {
          state.unauthenticatedGraphqlCalls += 1;
          jsonResponse(res, 401, { errors: [{ message: "unauthorized" }] });
          return;
        }

        const contentType = req.headers["content-type"] || "";
        if (contentType.startsWith("multipart/form-data")) {
          jsonResponse(res, 200, { data: { setBlob: "mock-blob-key" } });
          return;
        }
        jsonResponse(res, 200, {
          data: {
            currentUser: {
              id: "mock-user-id",
              name: "Auth Session Test",
              email: EMAIL,
              emailVerified: true,
              avatarUrl: null,
              disabled: false,
            },
          },
        });
        return;
      }

      res.writeHead(404);
      res.end();
    })().catch((error) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    releaseLogin: () => releaseLogin?.(),
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cleanServerEnvironment(port, baseUrl, configHome) {
  const env = { ...process.env };
  for (const key of [
    "AFFINE_API_TOKEN",
    "AFFINE_COOKIE",
    "AFFINE_DISABLED_GROUPS",
    "AFFINE_DISABLED_TOOLS",
    "AFFINE_HEADERS_JSON",
    "AFFINE_MCP_HTTP_TOKEN",
    "AFFINE_TOOL_PROFILE",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    MCP_TRANSPORT: "http",
    PORT: String(port),
    AFFINE_BASE_URL: baseUrl,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: "async",
    AFFINE_MCP_AUTH_MODE: "bearer",
    AFFINE_MCP_HTTP_HOST: "127.0.0.1",
    XDG_CONFIG_HOME: configHome || `/tmp/affine-mcp-auth-session-${process.pid}-${port}`,
  };
}

async function waitForHealth(child, url, logs, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited before health check: ${JSON.stringify(logs())}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // Retry until startup completes.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(logs())}`);
}

async function startMcpServer(baseUrl, options = {}) {
  const port = await findFreePort();
  const child = spawn("node", [MCP_SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: cleanServerEnvironment(port, baseUrl, options.configHome),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const logs = () => ({ stdout, stderr });
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(child, `${publicBaseUrl}/healthz`, logs);
  return {
    child,
    logs,
    mcpUrl: `${publicBaseUrl}/mcp`,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve(true))),
        delay(4_000).then(() => false),
      ]);
      if (!exited && child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
  };
}

function writeSavedConfig(configHome, values) {
  const directory = path.join(configHome, "affine-mcp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "config"),
    `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
}

async function createMcpClient(mcpUrl, name) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  return { client, transport };
}

function parseToolContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function testSingleFlightPrimitive() {
  let loginCalls = 0;
  const session = new AuthSession({
    baseUrl: "http://127.0.0.1:1",
    email: EMAIL,
    password: PASSWORD,
    login: async () => {
      loginCalls += 1;
      await delay(50);
      return { cookieHeader: COOKIE };
    },
  });

  const snapshots = await Promise.all(Array.from({ length: 20 }, () => session.ready()));
  assertEqual(loginCalls, 1, "concurrent ready calls share one login");
  assert(snapshots.every((snapshot) => snapshot.kind === "cookie" && snapshot.cookie === COOKIE), "shared login result");
  assertEqual(session.source, "cookie", "resolved auth source");
  assertEqual(parseLoginMode(undefined), "async", "default login mode");
  assertEqual(parseLoginMode("SYNC"), "sync", "sync login mode");
  assertThrows(() => parseLoginMode("background"), "must be", "invalid login mode");

  const bearerPriority = new AuthSession({
    baseUrl: "http://127.0.0.1:1",
    bearer: "preferred-token",
    email: EMAIL,
  });
  assertEqual((await bearerPriority.ready()).kind, "bearer", "bearer ignores incomplete lower-priority credentials");
}

async function testConfiguredAuthResolution() {
  const bearerHeaders = resolveConfiguredAuth({
    headers: {
      AUTHORIZATION: "Bearer header-token",
      Cookie: "stale-cookie=1",
      "X-Tenant": "header-tenant",
    },
    source: "env",
  });
  assertEqual(bearerHeaders.kind, "api-token", "case-insensitive Authorization header kind");
  assertEqual(bearerHeaders.apiToken, "header-token", "header bearer token");
  assertEqual(bearerHeaders.source, "env", "header auth source");
  assertEqual(bearerHeaders.headers?.["X-Tenant"], "header-tenant", "header auth preserves non-auth headers");
  assert(!Object.keys(bearerHeaders.headers || {}).some((name) => /^(authorization|cookie)$/i.test(name)), "header auth is canonicalized");

  const cookieHeaders = resolveConfiguredAuth({
    headers: { cOoKiE: "affine_session=header-cookie" },
    source: "config",
  });
  assertEqual(cookieHeaders.kind, "cookie", "case-insensitive Cookie header kind");
  assertEqual(cookieHeaders.cookie, "affine_session=header-cookie", "header cookie");
  assertEqual(cookieHeaders.headers?.Cookie, "affine_session=header-cookie", "canonical cookie header");

  const explicitToken = resolveConfiguredAuth({
    apiToken: "explicit-token",
    cookie: "cookie=\ninvalid-lower-priority",
    email: EMAIL,
    password: PASSWORD,
    headers: { Authorization: "Basic ignored" },
  });
  assertEqual(explicitToken.kind, "api-token", "explicit token precedence");
  assertEqual(explicitToken.apiToken, "explicit-token", "explicit token value");
  assertEqual(explicitToken.cookie, undefined, "ignored lower-priority cookie is not exposed");
  assertEqual(explicitToken.email, undefined, "ignored lower-priority email is not exposed");
  assertEqual(explicitToken.password, undefined, "ignored lower-priority password is not exposed");

  const explicitCookie = resolveConfiguredAuth({
    cookie: "cookie=explicit",
    headers: { Authorization: "Bearer lower-priority" },
  });
  assertEqual(explicitCookie.kind, "cookie", "explicit cookie precedence");
  assertEqual(explicitCookie.cookie, "cookie=explicit", "explicit cookie value");
  assertEqual(explicitCookie.apiToken, undefined, "ignored lower-priority token is not exposed");

  const emailAuth = resolveConfiguredAuth({ email: EMAIL, password: PASSWORD });
  assertEqual(emailAuth.kind, "email-password", "email/password fallback");
  const partialEmail = resolveConfiguredAuth({ email: EMAIL });
  assertEqual(partialEmail.kind, "none", "partial email does not select authentication");
  assertEqual(partialEmail.email, EMAIL, "partial email remains available for configuration warnings");
  assertEqual(partialEmail.password, undefined, "missing partial password remains unset");
  assertThrows(
    () => resolveConfiguredAuth({ headers: { Authorization: "Basic invalid" } }),
    "Bearer scheme",
    "invalid Authorization scheme",
  );
}

async function testExclusiveAuthState() {
  const client = new GraphQLClient({
    endpoint: "http://127.0.0.1:1/graphql",
    headers: {
      authorization: "Bearer old-lowercase-token",
      Authorization: "Bearer old-uppercase-token",
      cookie: "old-lowercase-cookie=1",
      Cookie: "old-uppercase-cookie=1",
      "X-Test": "kept",
    },
  });

  client.setCookie("new-cookie=1");
  let connection = await client.getConnectionAuth();
  assertEqual(connection.cookie, "new-cookie=1", "setCookie cookie value");
  assertEqual(connection.bearer, "", "setCookie clears bearer");
  assertEqual(Object.keys(connection.headers).filter((key) => key.toLowerCase() === "cookie").length, 1, "one cookie header");
  assertEqual(Object.keys(connection.headers).filter((key) => key.toLowerCase() === "authorization").length, 0, "no authorization header after setCookie");

  client.setBearer("new-bearer-token");
  connection = await client.getConnectionAuth();
  assertEqual(connection.bearer, "new-bearer-token", "setBearer token value");
  assertEqual(connection.cookie, "", "setBearer clears cookie");
  assertEqual(Object.keys(connection.headers).filter((key) => key.toLowerCase() === "authorization").length, 1, "one authorization header");
  assertEqual(Object.keys(connection.headers).filter((key) => key.toLowerCase() === "cookie").length, 0, "no cookie header after setBearer");
  assertEqual(connection.headers["X-Test"], "kept", "non-auth header retained");

  client.setHeaders({ COOKIE: "header-cookie=1" });
  connection = await client.getConnectionAuth();
  assertEqual(connection.cookie, "header-cookie=1", "setHeaders cookie override");
  assertEqual(connection.bearer, "", "setHeaders cookie clears bearer");
  assertThrows(() => client.setCookie("bad\r\ncookie"), "CR/LF", "cookie header injection");
  assertThrows(() => client.setBearer("bad\ntoken"), "CR/LF", "bearer header injection");
  assertThrows(() => client.setBearer(" "), "must not be empty", "empty bearer token");

  const rejectedProviderClient = new GraphQLClient({
    endpoint: "http://127.0.0.1:1/graphql",
    authProvider: async () => { throw new Error("provider failed"); },
  });
  await assertRejects(rejectedProviderClient.getConnectionAuth(), "provider failed", "provider failure");
  rejectedProviderClient.setCookie("recovered-cookie=1");
  assertEqual((await rejectedProviderClient.getConnectionAuth()).cookie, "recovered-cookie=1", "explicit sign-in overrides failed provider");
}

async function testTransientLoginRecovery() {
  let calls = 0;
  let now = 1000;
  const session = new AuthSession({
    baseUrl: "http://127.0.0.1:1", email: EMAIL, password: PASSWORD,
    now: () => now, retryDelayMs: 5000,
    login: async () => {
      calls++;
      if (calls === 1) throw new Error("backend unavailable");
      return { cookieHeader: COOKIE };
    },
  });
  const client = new GraphQLClient({ endpoint: "http://127.0.0.1:1/graphql", authProvider: () => session.ready() });
  await assertRejects(client.getConnectionAuth(), "backend unavailable", "initial outage");
  await assertRejects(client.getConnectionAuth(), "backend unavailable", "cooldown retains the failure");
  assertEqual(calls, 1, "no login storm during cooldown");
  now += 5000;
  const recovered = await Promise.all(Array.from({ length: 20 }, () => client.getConnectionAuth()));
  assertEqual(calls, 2, "one recovery login in the same client session");
  assert(recovered.every(value => value.cookie === COOKIE), "every consumer recovers without restart");
}

async function testCookieRenewal() {
  let now = 1_000;
  let calls = 0;
  let unavailable = false;
  const session = new AuthSession({
    baseUrl: "http://127.0.0.1:1", email: EMAIL, password: PASSWORD,
    now: () => now,
    login: async () => {
      calls++;
      if (unavailable) throw new Error("renewal unavailable");
      return { cookieHeader: `session=${calls}`, expiresAt: now + 120_000 };
    },
  });
  const client = new GraphQLClient({ endpoint: "http://127.0.0.1:1/graphql", authProvider: () => session.ready() });
  assertEqual((await client.getConnectionAuth()).cookie, "session=1", "first cookie");
  now += 59_000;
  assertEqual((await client.getConnectionAuth()).cookie, "session=1", "valid cookie reused");
  now += 1_000;
  const renewed = await Promise.all(Array.from({ length: 20 }, () => client.getConnectionAuth()));
  assertEqual(calls, 2, "one renewal shared by all consumers");
  assert(renewed.every(value => value.cookie === "session=2"), "same long-lived client sees renewed cookie");
  now += 60_000;
  unavailable = true;
  await assertRejects(client.getConnectionAuth(), "renewal unavailable", "renewal outage is visible");
  assert(session.requiresLogin, "renewal failure does not fall back to stale or anonymous auth");
  unavailable = false;
  now += 5_000;
  assertEqual((await client.getConnectionAuth()).cookie, "session=4", "renewal recovers after cooldown");

  const mock = await startMockAffine({ cookieAttributes: "; Max-Age=120; Expires=Thu, 01 Jan 2099 00:00:00 GMT" });
  try {
    const before = Date.now();
    const result = await loginWithPassword(mock.baseUrl, EMAIL, PASSWORD);
    assert(result.expiresAt >= before + 120_000 && result.expiresAt <= Date.now() + 120_000,
      "Max-Age takes precedence over Expires and is preserved for renewal");
  } finally {
    await mock.close();
  }
}

async function testFailureNeverFallsBack() {
  const mock = await startMockAffine({ failLogin: true });
  try {
    const session = new AuthSession({ baseUrl: mock.baseUrl, email: EMAIL, password: PASSWORD });
    session.start();
    const first = new GraphQLClient({
      endpoint: `${mock.baseUrl}/graphql`,
      authProvider: () => session.ready(),
    });
    const second = new GraphQLClient({
      endpoint: `${mock.baseUrl}/graphql`,
      authProvider: () => session.ready(),
    });

    const results = await Promise.allSettled([
      first.request("query { currentUser { email } }"),
      second.request("query { currentUser { email } }"),
      first.getConnectionAuth(),
    ]);
    assert(results.every((result) => result.status === "rejected"), "all consumers should receive login failure");
    assertEqual(mock.state.signInCalls, 1, "failed login remains single-flight");
    assertEqual(mock.state.graphqlCalls, 0, "failed login sends no anonymous GraphQL request");
  } finally {
    await mock.close();
  }
}

async function testEnvironmentCredentialsOverrideSavedAuthentication() {
  const scenarios = [
    {
      label: "saved API token",
      values: { AFFINE_API_TOKEN: "stale-saved-token" },
    },
    {
      label: "saved cookie",
      values: { AFFINE_COOKIE: "affine_session=stale-saved-cookie" },
    },
    {
      label: "saved authentication headers",
      values: {
        AFFINE_HEADERS_JSON: JSON.stringify({
          Authorization: "Bearer stale-saved-header-token",
          Cookie: "affine_session=stale-saved-header-cookie",
        }),
      },
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const configHome = mkdtempSync(path.join(os.tmpdir(), "affine-mcp-env-auth-"));
    const tenant = `saved-tenant-${index}`;
    const existingHeaders = scenario.values.AFFINE_HEADERS_JSON
      ? JSON.parse(scenario.values.AFFINE_HEADERS_JSON)
      : {};
    writeSavedConfig(configHome, {
      ...scenario.values,
      AFFINE_HEADERS_JSON: JSON.stringify({ ...existingHeaders, "X-Tenant": tenant }),
    });

    const mock = await startMockAffine();
    const mcp = await startMcpServer(mock.baseUrl, { configHome });
    let client;
    try {
      client = await createMcpClient(mcp.mcpUrl, `environment-auth-${index}`);
      const result = await client.client.callTool({ name: "current_user", arguments: {} });

      assertEqual(parseToolContent(result)?.email, EMAIL, `${scenario.label} current_user email`);
      assertEqual(mock.state.signInCalls, 1, `${scenario.label} did not trigger environment login`);
      assertEqual(mock.state.graphqlCalls, 1, `${scenario.label} GraphQL request count`);
      assertEqual(
        mock.state.unauthenticatedGraphqlCalls,
        0,
        `${scenario.label} reached AFFiNE with stale authentication`,
      );
      assertEqual(mock.state.graphqlHeaders[0]?.cookie, COOKIE, `${scenario.label} session cookie`);
      assertEqual(mock.state.graphqlHeaders[0]?.authorization, "", `${scenario.label} bearer header`);
      assertEqual(mock.state.graphqlHeaders[0]?.tenant, tenant, `${scenario.label} non-auth header`);
    } finally {
      if (client) {
        try { await client.client.close(); } catch {}
        try { await client.transport.close(); } catch {}
      }
      await mcp.close();
      await mock.close();
      rmSync(configHome, { recursive: true, force: true });
    }
  }
}

async function testConcurrentHttpSessionsAndDirectMultipart() {
  const mock = await startMockAffine({ blockLogin: true });
  const mcp = await startMcpServer(mock.baseUrl);
  const clients = [];
  try {
    const [first, second] = await Promise.all([
      createMcpClient(mcp.mcpUrl, "auth-session-first"),
      createMcpClient(mcp.mcpUrl, "auth-session-second"),
    ]);
    clients.push(first, second);

    const userResultsPromise = Promise.all([
      first.client.callTool({ name: "current_user", arguments: {} }),
      second.client.callTool({ name: "current_user", arguments: {} }),
    ]);

    await waitFor(() => mock.state.signInCalls === 1, "shared sign-in request did not start");
    await delay(100);
    assertEqual(mock.state.graphqlCalls, 0, "backend requests wait for auth readiness");
    mock.releaseLogin();

    const userResults = await userResultsPromise;
    for (const result of userResults) {
      assertEqual(parseToolContent(result)?.email, EMAIL, "current_user email");
    }

    const uploadResult = await first.client.callTool({
      name: "upload_blob",
      arguments: {
        workspaceId: "mock-workspace",
        content: "plain mock upload",
        filename: "mock.txt",
        contentType: "text/plain",
      },
    });
    assertEqual(parseToolContent(uploadResult)?.key, "mock-blob-key", "multipart upload result");

    assertEqual(mock.state.signInCalls, 1, "two HTTP sessions share one login");
    assertEqual(mock.state.graphqlCalls, 3, "two GraphQL calls and one multipart call");
    assertEqual(mock.state.unauthenticatedGraphqlCalls, 0, "no unauthenticated backend request");
    assert(
      mock.state.graphqlHeaders.every((headers) =>
        headers.cookie === COOKIE && headers.authorization === ""
      ),
      "all backend consumers use exactly the shared cookie credential",
    );
    assert(
      mock.state.graphqlHeaders.every((headers) => headers.receivedAt >= mock.state.loginCompletedAt),
      "backend requests occur only after login completes",
    );
  } finally {
    mock.releaseLogin();
    for (const { client, transport } of clients) {
      try { await client.close(); } catch {}
      try { await transport.close(); } catch {}
    }
    await mcp.close();
    await mock.close();
  }
}

async function main() {
  assert(existsSync(MCP_SERVER_PATH), "dist/index.js is missing; run npm run build first");
  await testSingleFlightPrimitive();
  await testConfiguredAuthResolution();
  await testTransientLoginRecovery();
  await testCookieRenewal();
  await testExclusiveAuthState();
  await testFailureNeverFallsBack();
  await testEnvironmentCredentialsOverrideSavedAuthentication();
  await testConcurrentHttpSessionsAndDirectMultipart();
  console.log("Authentication session regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
