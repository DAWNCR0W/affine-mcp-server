#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const { normalizeAffineCookieInput } = await import(
  pathToFileURL(path.join(ROOT, "dist", "cookieAuth.js")).href
);

const SESSION_ID = "e11b3f35-fef0-4d2f-9f3d-9d430a6ced9d";
const USER_ID = "user_test_123";
const COOKIE = `affine_session=${SESSION_ID}; affine_user_id=${USER_ID}`;
const WORKSPACE_ID = "workspace-cookie-test";

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(args, xdgConfigHome, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_ENTRY, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfigHome,
        AFFINE_API_TOKEN: "",
        AFFINE_COOKIE: "",
        AFFINE_EMAIL: "",
        AFFINE_PASSWORD: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const seenCookies = [];
const server = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/graphql") {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const cookie = req.headers.cookie || "";
  seenCookies.push(cookie);

  res.setHeader("Content-Type", "application/json");
  if (cookie !== COOKIE) {
    res.end(JSON.stringify({ data: { currentUser: null, workspaces: [] } }));
    return;
  }

  if (payload.query.includes("owner { name }")) {
    res.end(JSON.stringify({
      data: {
        workspaces: [{
          id: WORKSPACE_ID,
          createdAt: "2026-07-15T00:00:00.000Z",
          memberCount: 1,
          owner: { name: "Cookie User" },
        }],
      },
    }));
    return;
  }

  res.end(JSON.stringify({
    data: {
      currentUser: { name: "Cookie User", email: "cookie@example.test" },
      workspaces: [{ id: WORKSPACE_ID }],
    },
  }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("mock server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
const tempDir = mkdtempSync(path.join(os.tmpdir(), "affine-mcp-cookie-login-"));
const xdgConfigHome = path.join(tempDir, "config-home");
mkdirSync(xdgConfigHome, { recursive: true });

try {
  expect(
    normalizeAffineCookieInput(SESSION_ID) === `affine_session=${SESSION_ID}`,
    "raw session value was not normalized",
  );
  expect(
    normalizeAffineCookieInput(`Cookie: ignored=value; ${COOKIE}`) === COOKIE,
    "complete Cookie header was not filtered",
  );

  const browserHeader = `Cookie: cf_clearance=discard-me; ${COOKIE}; affine_csrf_token=discard-me-too`;
  const login = await runCli([
    "login",
    "--url", baseUrl,
    "--cookie", browserHeader,
    "--workspace-id", WORKSPACE_ID,
    "--no-open",
    "--force",
  ], xdgConfigHome);
  expect(login.status === 0, `cookie login failed: ${login.stderr || login.stdout}`);
  expect(login.stderr.includes("Authenticated as: Cookie User"), "login did not confirm the user");

  const configPath = path.join(xdgConfigHome, "affine-mcp", "config");
  const config = readFileSync(configPath, "utf8");
  expect(config.includes(`AFFINE_COOKIE=${COOKIE}`), "saved config does not contain the normalized cookie");
  expect(config.includes(`AFFINE_WORKSPACE_ID=${WORKSPACE_ID}`), "saved config does not contain workspace id");
  expect(!config.includes("AFFINE_API_TOKEN="), "cookie login should remove an API token");
  expect(!config.includes("cf_clearance"), "unrelated browser cookie was persisted");
  expect(!config.includes("affine_csrf_token"), "unneeded CSRF cookie was persisted");
  expect((statSync(configPath).mode & 0o777) === 0o600, "saved config permissions should be 0600");

  const status = await runCli(["status", "--json"], xdgConfigHome);
  expect(status.status === 0, `cookie status failed: ${status.stderr || status.stdout}`);
  const statusJson = JSON.parse(status.stdout);
  expect(statusJson.authKind === "cookie", "status should report cookie auth");
  expect(statusJson.userEmail === "cookie@example.test", "status user mismatch");
  expect(statusJson.workspaceId === WORKSPACE_ID, "status workspace mismatch");

  const doctor = await runCli(["doctor", "--json"], xdgConfigHome);
  expect(doctor.status === 0, `cookie doctor failed: ${doctor.stderr || doctor.stdout}`);
  const doctorJson = JSON.parse(doctor.stdout);
  expect(doctorJson.ok === true, "doctor should pass with the saved cookie");
  expect(doctorJson.authKind === "cookie", "doctor should report cookie auth");

  const snippet = await runCli(["snippet", "all", "--env"], xdgConfigHome);
  expect(snippet.status === 0, `cookie snippet failed: ${snippet.stderr || snippet.stdout}`);
  const snippetJson = JSON.parse(snippet.stdout);
  expect(snippetJson.claude.mcpServers.affine.env.AFFINE_COOKIE === COOKIE, "snippet should include cookie auth");
  expect(!snippetJson.claude.mcpServers.affine.env.AFFINE_API_TOKEN, "snippet should not include an API token");

  const invalidCookie = await runCli([
    "login", "--url", baseUrl, "--cookie", "not-a-session", "--no-open", "--force",
  ], xdgConfigHome);
  expect(invalidCookie.status !== 0, "invalid cookie unexpectedly succeeded");
  expect(invalidCookie.stderr.includes("Invalid session cookie"), "invalid cookie error is not actionable");

  const workspaceToken = await runCli([
    "login",
    "--url", baseUrl,
    "--token", "aff_mcp_v1.credential.secret",
    "--workspace-id", WORKSPACE_ID,
    "--force",
  ], xdgConfigHome);
  expect(workspaceToken.status !== 0, "workspace MCP token unexpectedly succeeded");
  expect(workspaceToken.stderr.includes("cannot access the GraphQL/WebSocket APIs"), "workspace token error is not actionable");

  const configuredWorkspaceToken = await runCli(["status"], xdgConfigHome, {
    AFFINE_API_TOKEN: "aff_mcp_v1.credential.secret",
  });
  expect(configuredWorkspaceToken.status !== 0, "configured workspace MCP token unexpectedly succeeded");
  expect(
    configuredWorkspaceToken.stderr.includes("Remove it and run 'affine-mcp login'"),
    "configured workspace token error is not actionable",
  );

  expect(seenCookies.length >= 3, "mock GraphQL server did not receive expected authenticated requests");
  expect(seenCookies.every(cookie => cookie === COOKIE), "a request sent an unexpected Cookie header");

  console.log(JSON.stringify({
    ok: true,
    cases: [
      "cookie login and sanitization",
      "raw session and full Cookie header normalization",
      "0600 config permissions",
      "cookie-aware status",
      "cookie-aware doctor",
      "cookie client snippets",
      "invalid cookie rejection",
      "workspace MCP token rejection",
      "configured workspace MCP token rejection",
    ],
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
}
