#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runNode(args, env, options = {}) {
  const { input = "", timeoutMs = 10_000 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
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

function parseCodexShellArguments(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/sh",
      ["-c", `codex() { printf '%s\\0' "$@"; }\n${command}`],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Generated Codex command failed POSIX shell parsing: ${stderr}`));
        return;
      }
      const serialized = Buffer.concat(stdout).toString("utf8");
      const args = serialized.split("\0");
      if (args.at(-1) === "") args.pop();
      resolve(args);
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
    affineVersion: request.headers["x-affine-version"] || null,
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
    AFFINE_HEADERS_JSON: JSON.stringify({ "X-Affine-Version": "cli-override-version" }),
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

  const staleSavedAuthHome = path.join(TEMP_ROOT, "stale-saved-auth");
  writeConfig(staleSavedAuthHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_API_TOKEN: "stale-saved-token",
    AFFINE_COOKIE: "affine_session=stale-saved-cookie",
    AFFINE_EMAIL: "saved@example.test",
    AFFINE_PASSWORD: "saved-password",
    AFFINE_HEADERS_JSON: JSON.stringify({
      Authorization: "Bearer stale-saved-header-token",
      Cookie: "affine_session=stale-saved-header-cookie",
      "X-Tenant": "saved-tenant",
    }),
  });
  const environmentCredentials = cleanEnvironment({
    XDG_CONFIG_HOME: staleSavedAuthHome,
    AFFINE_EMAIL: "environment@example.test",
    AFFINE_PASSWORD: "environment-password",
  });
  const environmentAuthConfig = await runNode(
    [DIST_ENTRY, "show-config", "--json"],
    environmentCredentials,
  );
  expect(
    environmentAuthConfig.code === 0,
    `environment auth config failed: ${environmentAuthConfig.stderr}`,
  );
  const environmentAuthSummary = JSON.parse(environmentAuthConfig.stdout);
  expect(
    environmentAuthSummary.authKind === "email-password",
    "saved token or cookie overrode environment email/password credentials",
  );
  expect(environmentAuthSummary.apiToken === null, "ignored saved API token remained effective");
  expect(environmentAuthSummary.cookie === null, "ignored saved cookie remained effective");
  expect(
    environmentAuthSummary.email === "environment@example.test",
    "environment email was not selected",
  );
  expect(
    environmentAuthSummary.sources.apiToken === "unset",
    "ignored saved API token source remained active",
  );
  expect(
    environmentAuthSummary.sources.cookie === "unset",
    "ignored saved cookie source remained active",
  );
  expect(
    environmentAuthSummary.sources.email === "env",
    "environment email source was not reported",
  );
  expect(
    environmentAuthSummary.sources.password === "env",
    "environment password source was not reported",
  );

  const partialCredentialWarning =
    "Environment provides only one of AFFINE_EMAIL or AFFINE_PASSWORD";
  expect(
    !environmentAuthConfig.stderr.includes(partialCredentialWarning),
    "complete environment email/password credentials produced a partial-credential warning",
  );

  const environmentEmailOnlyConfig = await runNode(
    [DIST_ENTRY, "show-config", "--json"],
    cleanEnvironment({
      XDG_CONFIG_HOME: staleSavedAuthHome,
      AFFINE_EMAIL: "environment@example.test",
    }),
  );
  expect(
    environmentEmailOnlyConfig.code === 0,
    `partial environment email config failed: ${environmentEmailOnlyConfig.stderr}`,
  );
  expect(
    environmentEmailOnlyConfig.stderr.includes(partialCredentialWarning),
    "environment email without a password did not warn that saved credentials were ignored",
  );
  const environmentEmailOnlySummary = JSON.parse(environmentEmailOnlyConfig.stdout);
  expect(
    environmentEmailOnlySummary.sources.email === "env" &&
      environmentEmailOnlySummary.sources.password === "unset",
    "environment email was combined with the saved password",
  );

  const environmentPasswordOnlyConfig = await runNode(
    [DIST_ENTRY, "show-config", "--json"],
    cleanEnvironment({
      XDG_CONFIG_HOME: staleSavedAuthHome,
      AFFINE_PASSWORD: "environment-password",
    }),
  );
  expect(
    environmentPasswordOnlyConfig.code === 0,
    `partial environment password config failed: ${environmentPasswordOnlyConfig.stderr}`,
  );
  expect(
    environmentPasswordOnlyConfig.stderr.includes(partialCredentialWarning),
    "environment password without an email did not warn that saved credentials were ignored",
  );
  const environmentPasswordOnlySummary = JSON.parse(environmentPasswordOnlyConfig.stdout);
  expect(
    environmentPasswordOnlySummary.sources.email === "unset" &&
      environmentPasswordOnlySummary.sources.password === "env",
    "environment password was combined with the saved email",
  );

  const nonAuthEnvironmentHeaders = await runNode(
    [DIST_ENTRY, "show-config", "--json"],
    cleanEnvironment({
      XDG_CONFIG_HOME: staleSavedAuthHome,
      AFFINE_HEADERS_JSON: JSON.stringify({ "X-Tenant": "environment-tenant" }),
    }),
  );
  expect(
    nonAuthEnvironmentHeaders.code === 0,
    `non-auth environment headers config failed: ${nonAuthEnvironmentHeaders.stderr}`,
  );
  const savedAuthSummary = JSON.parse(nonAuthEnvironmentHeaders.stdout);
  expect(
    savedAuthSummary.authKind === "api-token",
    "non-auth environment headers incorrectly disabled saved authentication",
  );
  expect(
    savedAuthSummary.sources.apiToken === "config",
    "saved API token source was not reported after non-auth environment headers",
  );

  const status = await runNode([DIST_ENTRY, "status", "--json"], effectiveEnv);
  expect(status.code === 0, `status failed: ${status.stderr}`);
  const statusPayload = JSON.parse(status.stdout);
  expect(statusPayload.graphqlEndpoint === `${baseUrl}/custom/graphql`, "status reported the wrong endpoint");
  expect(statusPayload.authKind === "api-token", "status did not use effective token auth");
  expect(statusPayload.userEmail === "config@example.test", "status did not inspect the fake upstream");
  expect(
    graphqlRequests.some(
      (entry) => entry.authorization === "Bearer env-token"
        && entry.affineVersion === "cli-override-version",
    ),
    "status did not send the environment API token and exact client-version override",
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

  const unsafeShellCharacters = "session=$(printf SUBSTITUTED); tick=`printf BACKTICK`; quote='; line\nbreak\rreturn";
  const shellSnippetEnv = cleanEnvironment({
    XDG_CONFIG_HOME: noConfigHome,
    AFFINE_BASE_URL: baseUrl,
    AFFINE_COOKIE: unsafeShellCharacters,
  });
  const codexSnippet = await runNode([DIST_ENTRY, "snippet", "codex", "--env"], shellSnippetEnv);
  expect(codexSnippet.code === 0, `Codex snippet failed: ${codexSnippet.stderr}`);
  const codexCommand = codexSnippet.stdout.endsWith("\n")
    ? codexSnippet.stdout.slice(0, -1)
    : codexSnippet.stdout;
  const codexArgs = await parseCodexShellArguments(codexCommand);
  const expectedCodexArgs = [
    "mcp",
    "add",
    "affine",
    "--env",
    `AFFINE_BASE_URL=${baseUrl}`,
    "--env",
    `AFFINE_COOKIE=${unsafeShellCharacters}`,
    "--",
    "affine-mcp",
  ];
  expect(
    JSON.stringify(codexArgs) === JSON.stringify(expectedCodexArgs),
    `Codex snippet did not preserve shell-sensitive values: ${JSON.stringify(codexArgs)}`,
  );

  const allSnippets = await runNode([DIST_ENTRY, "snippet", "all", "--env"], shellSnippetEnv);
  expect(allSnippets.code === 0, `all snippets failed: ${allSnippets.stderr}`);
  const allCodexArgs = await parseCodexShellArguments(JSON.parse(allSnippets.stdout).codex);
  expect(
    JSON.stringify(allCodexArgs) === JSON.stringify(expectedCodexArgs),
    "snippet all did not apply the POSIX-safe Codex quoting contract",
  );

  const savedOnlyEnv = cleanEnvironment({ XDG_CONFIG_HOME: savedConfigHome });
  const cookieFromStdin = "affine_session=stdin-cookie-value";
  const login = await runNode([
    DIST_ENTRY,
    "login",
    "--url",
    baseUrl,
    "--graphql-path",
    "/custom/graphql",
    "--cookie-stdin",
    "--workspace-id",
    "workspace-env",
    "--force",
  ], savedOnlyEnv, { input: `${cookieFromStdin}\n` });
  expect(login.code === 0, `non-interactive login failed: ${login.stderr}`);
  const configAfterLogin = readFileSync(path.join(savedConfigHome, "affine-mcp", "config"), "utf8");
  expect(configAfterLogin.includes("MCP_TRANSPORT=stdio"), "login erased a saved runtime setting");
  expect(configAfterLogin.includes("PORT=3001"), "login erased the saved HTTP port");
  expect(configAfterLogin.includes("AFFINE_GRAPHQL_PATH=/custom/graphql"), "login did not save the GraphQL path");
  expect(configAfterLogin.includes(`AFFINE_COOKIE=${cookieFromStdin}`), "login did not save the stdin cookie");
  expect(configAfterLogin.includes("AFFINE_WORKSPACE_ID=workspace-env"), "login did not save the validated workspace");
  expect(
    graphqlRequests.some((entry) => entry.cookie === cookieFromStdin),
    "stdin cookie was not used to authenticate and validate the workspace",
  );

  const rejectedWorkspaceHome = path.join(TEMP_ROOT, "rejected-workspace");
  const rejectedWorkspace = await runNode([
    DIST_ENTRY,
    "login",
    "--url",
    baseUrl,
    "--graphql-path",
    "/custom/graphql",
    "--cookie-stdin",
    "--workspace-id",
    "workspace-unavailable",
    "--force",
  ], cleanEnvironment({ XDG_CONFIG_HOME: rejectedWorkspaceHome }), {
    input: `${cookieFromStdin}\n`,
  });
  expect(rejectedWorkspace.code !== 0, "login accepted a workspace outside the authenticated account");
  expect(
    rejectedWorkspace.stderr.includes("Workspace 'workspace-unavailable' is not available"),
    `invalid workspace failure was unclear: ${rejectedWorkspace.stderr}`,
  );
  expect(
    !existsSync(path.join(rejectedWorkspaceHome, "affine-mcp", "config")),
    "login saved config after workspace validation failed",
  );

  const legacyCookieSecret = "affine_session=must-not-appear-in-errors";
  const legacyCookie = await runNode([
    DIST_ENTRY,
    "login",
    "--cookie",
    legacyCookieSecret,
  ], cleanEnvironment({ XDG_CONFIG_HOME: path.join(TEMP_ROOT, "legacy-cookie") }));
  expect(legacyCookie.code !== 0, "login accepted a cookie in process arguments");
  expect(legacyCookie.stderr.includes("--cookie-stdin"), "legacy cookie error did not explain the safe replacement");
  expect(!legacyCookie.stderr.includes(legacyCookieSecret), "legacy cookie secret leaked to stderr");
  expect(!legacyCookie.stdout.includes(legacyCookieSecret), "legacy cookie secret leaked to stdout");

  const logout = await runNode([DIST_ENTRY, "logout"], savedOnlyEnv);
  expect(logout.code === 0, `logout failed: ${logout.stderr}`);
  const configAfterLogout = readFileSync(path.join(savedConfigHome, "affine-mcp", "config"), "utf8");
  expect(!configAfterLogout.includes("AFFINE_COOKIE="), "logout left the saved session cookie behind");
  expect(configAfterLogout.includes("MCP_TRANSPORT=stdio"), "logout erased a saved runtime setting");

  const headerOnlyConfigHome = path.join(TEMP_ROOT, "header-only-auth");
  writeConfig(headerOnlyConfigHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_HEADERS_JSON: JSON.stringify({
      authorization: "Bearer header-only-token",
      COOKIE: "affine_session=header-only-cookie",
      "X-Tenant": "preserved-tenant",
      "X-Trace": "preserved-trace",
    }),
    MCP_TRANSPORT: "http",
    PORT: "3456",
  });
  const headerOnlyLogout = await runNode(
    [DIST_ENTRY, "logout"],
    cleanEnvironment({ XDG_CONFIG_HOME: headerOnlyConfigHome }),
  );
  expect(headerOnlyLogout.code === 0, `header-only logout failed: ${headerOnlyLogout.stderr}`);
  expect(
    headerOnlyLogout.stderr.includes("Removed saved credentials"),
    "logout did not recognize header-only credentials",
  );
  const headerOnlyConfig = readFileSync(
    path.join(headerOnlyConfigHome, "affine-mcp", "config"),
    "utf8",
  );
  const retainedHeadersLine = headerOnlyConfig
    .split("\n")
    .find((line) => line.startsWith("AFFINE_HEADERS_JSON="));
  expect(retainedHeadersLine, "logout removed non-authentication headers");
  const retainedHeaders = JSON.parse(retainedHeadersLine.slice("AFFINE_HEADERS_JSON=".length));
  expect(
    !Object.keys(retainedHeaders).some((name) => /^(authorization|cookie)$/i.test(name)),
    "logout left an Authorization or Cookie header in saved config",
  );
  expect(retainedHeaders["X-Tenant"] === "preserved-tenant", "logout removed the saved tenant header");
  expect(retainedHeaders["X-Trace"] === "preserved-trace", "logout removed the saved trace header");
  expect(headerOnlyConfig.includes("MCP_TRANSPORT=http"), "logout erased the saved transport setting");
  expect(headerOnlyConfig.includes("PORT=3456"), "logout erased the saved port setting");

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
      "X-Affine-Version": "readyz-override-version",
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
        && entry.tenant === "saved-tenant"
        && entry.affineVersion === "readyz-override-version",
    ),
    "readyz did not use the configured endpoint, exact client-version override, custom headers, and service token",
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
      "authentication source precedence",
      "custom GraphQL path",
      "custom-path workspace socket origin",
      "effective status auth",
      "environment-only doctor",
      "HTTP exposure diagnostics",
      "snippet propagation",
      "POSIX-safe Codex snippet quoting",
      "login and logout setting preservation",
      "stdin cookie authentication",
      "workspace override validation",
      "legacy cookie argument redaction",
      "header-only credential logout",
      "strict transport validation",
      "saved HTTP runtime flags",
      "upstream-aware readiness",
      "case-insensitive client-version overrides",
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
