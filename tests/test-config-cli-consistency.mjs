#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const TEMP_ROOT = path.join(os.tmpdir(), `affine-mcp-config-consistency-${process.pid}`);
const { wsUrlFromGraphQLEndpoint } = await import("../dist/ws.js");

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AFFINE_") || key === "MCP_TRANSPORT" || key === "PORT") {
      delete environment[key];
    }
  }
  return { ...environment, ...extra };
}

function runNode(args, env, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: node ${args.join(" ")}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
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

async function waitForHttp(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The child process may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function writeConfig(xdgConfigHome, values) {
  const directory = path.join(xdgConfigHome, "affine-mcp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "config"),
    `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
}

rmSync(TEMP_ROOT, { recursive: true, force: true });
mkdirSync(TEMP_ROOT, { recursive: true });

expect(
  wsUrlFromGraphQLEndpoint("https://affine.example.test/custom/graphql") === "wss://affine.example.test",
  "custom GraphQL paths must not become Socket.IO namespaces",
);

let upstreamReady = true;
const graphqlRequests = [];
const upstream = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("No root route");
    return;
  }
  if (request.method !== "POST" || request.url !== "/custom/graphql") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "wrong path" }));
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  graphqlRequests.push({
    authorization: request.headers.authorization || null,
    cookie: request.headers.cookie || null,
    tenant: request.headers["x-tenant"] || null,
    query: body.query,
    url: request.url,
  });

  if (!upstreamReady) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "maintenance" }));
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  if (body.query.includes("AffineMcpReadiness")) {
    response.end(JSON.stringify({ data: { __typename: "Query" } }));
    return;
  }
  response.end(JSON.stringify({
    data: {
      currentUser: { name: "Config Test", email: "config@example.test" },
      workspaces: [{ id: "workspace-env" }],
    },
  }));
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const upstreamAddress = upstream.address();
const baseUrl = `http://127.0.0.1:${upstreamAddress.port}`;

let httpChild;
let httpChildStderr = "";
try {
  const savedConfigHome = path.join(TEMP_ROOT, "saved-config");
  writeConfig(savedConfigHome, {
    AFFINE_BASE_URL: "https://saved.example.test",
    AFFINE_GRAPHQL_PATH: "/saved/graphql",
    AFFINE_API_TOKEN: "saved-token",
    MCP_TRANSPORT: "stdio",
    PORT: "3001",
  });
  const effectiveEnv = cleanEnvironment({
    XDG_CONFIG_HOME: savedConfigHome,
    AFFINE_BASE_URL: baseUrl,
    AFFINE_GRAPHQL_PATH: "/custom/graphql",
    AFFINE_API_TOKEN: "env-token",
    AFFINE_WORKSPACE_ID: "workspace-env",
    MCP_TRANSPORT: "streamable",
    PORT: "4321",
    AFFINE_MCP_HTTP_TOKEN: "http-secret-token",
    AFFINE_MCP_HTTP_ALLOWED_ORIGINS: "https://client.example.test",
  });

  const showConfig = await runNode([DIST_ENTRY, "show-config", "--json"], effectiveEnv);
  expect(showConfig.code === 0, `show-config failed: ${showConfig.stderr}`);
  const summary = JSON.parse(showConfig.stdout);
  expect(summary.graphqlEndpoint === `${baseUrl}/custom/graphql`, "GraphQL endpoint did not use env precedence");
  expect(summary.transportMode === "http", "streamable alias did not normalize to HTTP");
  expect(summary.http.port === 4321, "HTTP port did not reach effective config");
  expect(summary.http.authToken !== "http-secret-token", "show-config exposed the HTTP auth token");
  expect(summary.sources.graphqlPath === "env", "GraphQL path source should be env");
  expect(summary.apiToken !== "env-token", "show-config exposed the API token");

  const status = await runNode([DIST_ENTRY, "status", "--json"], effectiveEnv);
  expect(status.code === 0, `status failed: ${status.stderr}`);
  const statusPayload = JSON.parse(status.stdout);
  expect(statusPayload.graphqlEndpoint === `${baseUrl}/custom/graphql`, "status reported the wrong endpoint");
  expect(statusPayload.authKind === "api-token", "status did not use effective token auth");
  expect(statusPayload.userEmail === "config@example.test", "status did not inspect the fake upstream");
  expect(
    graphqlRequests.some((entry) => entry.authorization === "Bearer env-token"),
    "status did not send the environment API token",
  );

  const noConfigHome = path.join(TEMP_ROOT, "no-config");
  const doctorEnv = cleanEnvironment({
    XDG_CONFIG_HOME: noConfigHome,
    AFFINE_BASE_URL: baseUrl,
    AFFINE_GRAPHQL_PATH: "/custom/graphql",
    AFFINE_API_TOKEN: "doctor-token",
  });
  const doctor = await runNode([DIST_ENTRY, "doctor", "--json"], doctorEnv);
  expect(doctor.code === 0, `doctor failed without a saved config: ${doctor.stderr}\n${doctor.stdout}`);
  const doctorPayload = JSON.parse(doctor.stdout);
  expect(doctorPayload.ok === true, "doctor should accept an environment-only configuration");
  expect(doctorPayload.config.configFileExists === false, "doctor unexpectedly found a saved config");
  expect(
    doctorPayload.checks.some((check) => check.name === "base-url" && check.ok),
    "doctor should treat an HTTP response from a 404 root route as reachable",
  );
  expect(
    doctorPayload.checks.some((check) => check.name === "graphql-auth" && check.ok),
    "doctor did not validate the exact GraphQL endpoint",
  );

  const exposedDoctor = await runNode(
    [DIST_ENTRY, "doctor", "--json"],
    cleanEnvironment({
      XDG_CONFIG_HOME: noConfigHome,
      AFFINE_BASE_URL: baseUrl,
      AFFINE_GRAPHQL_PATH: "/custom/graphql",
      AFFINE_API_TOKEN: "doctor-token",
      MCP_TRANSPORT: "http",
      AFFINE_MCP_HTTP_HOST: "0.0.0.0",
    }),
  );
  expect(exposedDoctor.code !== 0, "doctor accepted an unprotected non-loopback HTTP bind");
  const exposedDoctorPayload = JSON.parse(exposedDoctor.stdout);
  expect(
    exposedDoctorPayload.checks.some((check) => check.name === "http-exposure" && !check.ok),
    "doctor did not identify the unsafe HTTP exposure",
  );

  const snippet = await runNode([DIST_ENTRY, "snippet", "claude", "--env"], effectiveEnv);
  expect(snippet.code === 0, `snippet failed: ${snippet.stderr}`);
  const snippetPayload = JSON.parse(snippet.stdout);
  expect(
    snippetPayload.mcpServers.affine.env.AFFINE_GRAPHQL_PATH === "/custom/graphql",
    "snippet omitted the custom GraphQL path",
  );

  const savedOnlyEnv = cleanEnvironment({ XDG_CONFIG_HOME: savedConfigHome });
  const login = await runNode([
    DIST_ENTRY,
    "login",
    "--url",
    baseUrl,
    "--graphql-path",
    "/custom/graphql",
    "--token",
    "replacement-token",
    "--workspace-id",
    "workspace-login",
    "--force",
  ], savedOnlyEnv);
  expect(login.code === 0, `non-interactive login failed: ${login.stderr}`);
  const configAfterLogin = readFileSync(path.join(savedConfigHome, "affine-mcp", "config"), "utf8");
  expect(configAfterLogin.includes("MCP_TRANSPORT=stdio"), "login erased a saved runtime setting");
  expect(configAfterLogin.includes("PORT=3001"), "login erased the saved HTTP port");
  expect(configAfterLogin.includes("AFFINE_GRAPHQL_PATH=/custom/graphql"), "login did not save the GraphQL path");

  const logout = await runNode([DIST_ENTRY, "logout"], savedOnlyEnv);
  expect(logout.code === 0, `logout failed: ${logout.stderr}`);
  const configAfterLogout = readFileSync(path.join(savedConfigHome, "affine-mcp", "config"), "utf8");
  expect(!configAfterLogout.includes("AFFINE_API_TOKEN="), "logout left the saved API token behind");
  expect(configAfterLogout.includes("MCP_TRANSPORT=stdio"), "logout erased a saved runtime setting");

  const invalidTransport = await runNode(
    [DIST_ENTRY, "show-config", "--json"],
    cleanEnvironment({ XDG_CONFIG_HOME: noConfigHome, MCP_TRANSPORT: "udp" }),
  );
  expect(invalidTransport.code !== 0, "invalid transport unexpectedly succeeded");
  expect(invalidTransport.stderr.includes("Invalid MCP_TRANSPORT"), "invalid transport error was not actionable");

  const httpConfigHome = path.join(TEMP_ROOT, "http-config");
  const httpPort = await findFreePort();
  writeConfig(httpConfigHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_GRAPHQL_PATH: "/custom/graphql",
    AFFINE_API_TOKEN: "runtime-token",
    AFFINE_COOKIE: "stale-cookie",
    AFFINE_HEADERS_JSON: JSON.stringify({
      "X-Tenant": "saved-tenant",
      Authorization: "Basic stale",
      Cookie: "stale-header-cookie",
    }),
    MCP_TRANSPORT: "http",
    PORT: String(httpPort),
    AFFINE_MCP_HTTP_HOST: "127.0.0.1",
    AFFINE_MCP_HTTP_ALLOWED_ORIGINS: "https://allowed.example.test",
  });

  httpChild = spawn(process.execPath, [DIST_ENTRY], {
    cwd: ROOT,
    env: cleanEnvironment({ XDG_CONFIG_HOME: httpConfigHome }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  httpChild.stderr.on("data", (chunk) => { httpChildStderr += chunk; });
  await waitForHttp(`http://127.0.0.1:${httpPort}/healthz`);

  const allowedHealth = await fetch(`http://127.0.0.1:${httpPort}/healthz`, {
    headers: { Origin: "https://allowed.example.test" },
  });
  expect(allowedHealth.status === 200, "saved HTTP origin allowlist did not reach runtime");
  const blockedHealth = await fetch(`http://127.0.0.1:${httpPort}/healthz`, {
    headers: { Origin: "https://blocked.example.test" },
  });
  expect(blockedHealth.status === 403, "runtime accepted an origin outside the saved allowlist");

  const ready = await fetch(`http://127.0.0.1:${httpPort}/readyz`);
  expect(ready.status === 200, `readyz did not validate the configured upstream: ${await ready.text()}`);
  expect(
    graphqlRequests.some(
      (entry) => entry.query.includes("AffineMcpReadiness")
        && entry.authorization === "Bearer runtime-token"
        && entry.cookie === null
        && entry.tenant === "saved-tenant",
    ),
    "readyz did not use the configured endpoint, custom headers, and service token",
  );

  upstreamReady = false;
  const notReady = await fetch(`http://127.0.0.1:${httpPort}/readyz`);
  expect(notReady.status === 503, "readyz stayed healthy while AFFiNE GraphQL was unavailable");
  const notReadyPayload = await notReady.json();
  expect(notReadyPayload.component === "affine-graphql", "readyz did not identify the failing component");

  console.log(JSON.stringify({
    ok: true,
    cases: [
      "environment precedence",
      "custom GraphQL path",
      "custom-path workspace socket origin",
      "effective status auth",
      "environment-only doctor",
      "HTTP exposure diagnostics",
      "snippet propagation",
      "login and logout setting preservation",
      "strict transport validation",
      "saved HTTP runtime flags",
      "upstream-aware readiness",
    ],
  }, null, 2));
} finally {
  if (httpChild && httpChild.exitCode === null) {
    httpChild.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        httpChild.kill("SIGKILL");
        resolve();
      }, 3_000);
      httpChild.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(TEMP_ROOT, { recursive: true, force: true });
}

if (httpChild?.exitCode && httpChild.exitCode !== 0) {
  throw new Error(`HTTP child exited unexpectedly: ${httpChildStderr}`);
}
