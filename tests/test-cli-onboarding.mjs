#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ENTRY = process.env.AFFINE_CLI_TEST_ENTRY || path.join(ROOT, "dist", "index.js");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "affine-mcp-cli-onboarding-"));

function expect(condition, message) {
  assert.ok(condition, message);
}

function writeConfig(xdgConfigHome, values) {
  const directory = path.join(xdgConfigHome, "affine-mcp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "config"),
    `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
}

function readConfig(xdgConfigHome) {
  return readFileSync(path.join(xdgConfigHome, "affine-mcp", "config"), "utf8");
}

function runCli(args, env, input = "", timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_ENTRY, ...args], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

function cleanEnvironment(xdgConfigHome, extra = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: xdgConfigHome };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AFFINE_") || key === "MCP_TRANSPORT" || key === "PORT") delete env[key];
  }
  return {
    ...env,
    AFFINE_ALLOW_INSECURE_HTTP: "true",
    AFFINE_WS_CONNECT_TIMEOUT_MS: "50",
    ...extra,
  };
}

const workspaces = [
  {
    id: "workspace-one",
    createdAt: "2026-09-01T00:00:00.000Z",
    memberCount: 2,
    owner: { name: "Owner One" },
  },
  {
    id: "workspace-two",
    createdAt: "2026-09-02T00:00:00.000Z",
    memberCount: 1,
    owner: { name: "Owner Two" },
  },
];
let discoveryMode = "success";

const upstream = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/auth/sign-in") {
    for await (const _chunk of request) {}
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "affine_session=onboarding-cookie; Path=/",
    });
    response.end("{}");
    return;
  }
  if (request.method !== "POST" || request.url !== "/graphql") {
    response.writeHead(404);
    response.end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (discoveryMode === "failure" && !body.query.includes("currentUser")) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ errors: [{ message: "Workspace discovery temporarily unavailable" }] }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    data: {
      currentUser: { name: "Onboarding User", email: "onboarding@example.test" },
      workspaces: discoveryMode === "empty" ? [] : workspaces,
    },
  }));
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const address = upstream.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const savedHome = path.join(tempRoot, "saved");
  writeConfig(savedHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_API_TOKEN: "saved-token",
    AFFINE_WORKSPACE_ID: "workspace-one",
    AFFINE_HEADERS_JSON: JSON.stringify({ "X-Tenant": "preserve-me" }),
    MCP_TRANSPORT: "stdio",
    PORT: "3011",
  });
  const savedEnv = cleanEnvironment(savedHome);

  const listed = await runCli(["workspaces", "--json"], savedEnv);
  expect(listed.code === 0, `workspaces failed: ${listed.stderr}`);
  const listPayload = JSON.parse(listed.stdout);
  expect(Array.isArray(listPayload) && listPayload.length === 2, "workspaces --json should return all memberships");
  expect(listPayload[0].displayName === "Workspace name unavailable", "fallback workspace label should be explicit");
  expect(listPayload[0].url === `${baseUrl}/workspace/workspace-one`, "workspace URL fallback is incorrect");
  expect(readConfig(savedHome).includes("AFFINE_WORKSPACE_ID=workspace-one"), "listing changed config");

  const prompted = await runCli(
    ["workspace"],
    savedEnv,
    "abc\n1garbage\n99\n2\n",
  );
  expect(!prompted.timedOut && prompted.code === 0, `interactive workspace selection failed: ${prompted.stderr}`);
  expect(prompted.stderr.includes("Enter a number") && prompted.stderr.includes("Selection must be between"), "workspace selector did not reject invalid choices");
  const promptedConfig = readConfig(savedHome);
  expect(promptedConfig.includes("AFFINE_WORKSPACE_ID=workspace-two"), "interactive workspace selection did not save the valid choice");
  expect(promptedConfig.includes("AFFINE_API_TOKEN=saved-token"), "interactive workspace selection erased credentials");
  expect(promptedConfig.includes("X-Tenant\":\"preserve-me"), "interactive workspace selection erased unrelated headers");
  expect(promptedConfig.includes("MCP_TRANSPORT=stdio") && promptedConfig.includes("PORT=3011"), "interactive workspace selection erased runtime config");

  const cancelledHome = path.join(tempRoot, "cancelled-workspace");
  writeConfig(cancelledHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_API_TOKEN: "cancel-token",
    AFFINE_WORKSPACE_ID: "workspace-one",
    MCP_TRANSPORT: "stdio",
  });
  const cancelledBefore = readConfig(cancelledHome);
  const cancelled = await runCli(["workspace"], cleanEnvironment(cancelledHome), "q\n");
  expect(!cancelled.timedOut && cancelled.code !== 0, "q should cancel workspace selection");
  expect(cancelled.stderr.includes("cancelled") && readConfig(cancelledHome) === cancelledBefore, "q changed config");

  const eofWorkspaceHome = path.join(tempRoot, "eof-workspace");
  writeConfig(eofWorkspaceHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_API_TOKEN: "eof-token",
    AFFINE_WORKSPACE_ID: "workspace-one",
    MCP_TRANSPORT: "stdio",
  });
  const eofWorkspaceBefore = readConfig(eofWorkspaceHome);
  const eofWorkspace = await runCli(["workspace"], cleanEnvironment(eofWorkspaceHome), "");
  expect(!eofWorkspace.timedOut && eofWorkspace.code !== 0, "EOF should cancel workspace selection");
  expect(eofWorkspace.stderr.includes("Input ended") && readConfig(eofWorkspaceHome) === eofWorkspaceBefore, "workspace EOF changed config");

  const switched = await runCli(["workspace", "workspace-two", "--json"], savedEnv);
  expect(switched.code === 0, `workspace switch failed: ${switched.stderr}`);
  const switchPayload = JSON.parse(switched.stdout);
  expect(switchPayload.saved === true, "workspace switch should report a saved selection");
  const switchedConfig = readConfig(savedHome);
  expect(switchedConfig.includes("AFFINE_WORKSPACE_ID=workspace-two"), "workspace switch did not save the selected ID");
  expect(switchedConfig.includes("AFFINE_API_TOKEN=saved-token"), "workspace switch erased credentials");
  expect(switchedConfig.includes("X-Tenant\":\"preserve-me"), "workspace switch erased unrelated headers");
  expect(switchedConfig.includes("MCP_TRANSPORT=stdio") && switchedConfig.includes("PORT=3011"), "workspace switch erased runtime config");

  const beforeInvalid = switchedConfig;
  const invalid = await runCli(["workspace", "not-a-member"], savedEnv);
  expect(invalid.code !== 0 && invalid.stderr.includes("No config was changed"), "invalid workspace should fail safely");
  expect(readConfig(savedHome) === beforeInvalid, "invalid workspace changed config");

  const envOverride = await runCli(
    ["workspace", "workspace-one"],
    cleanEnvironment(savedHome, { AFFINE_WORKSPACE_ID: "workspace-two" }),
  );
  expect(envOverride.code !== 0, "workspace switch should refuse an environment override");
  expect(envOverride.stderr.includes("overrides saved config") && envOverride.stderr.includes("unset AFFINE_WORKSPACE_ID"), "environment override recovery was unclear");
  expect(readConfig(savedHome) === beforeInvalid, "environment override changed config");

  const snippet = await runCli(["snippet", "claude", "--env"], savedEnv);
  expect(snippet.code === 0, `snippet failed: ${snippet.stderr}`);
  expect(snippet.stderr.includes("copies credentials") && snippet.stderr.includes("regenerate"), "--env warning is missing");
  const defaultSnippet = await runCli(["snippet", "claude"], savedEnv);
  expect(defaultSnippet.code === 0 && defaultSnippet.stderr.includes("omit --env"), "default snippet should recommend saved config");

  const headerOnlyHome = path.join(tempRoot, "header-only");
  writeConfig(headerOnlyHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_HEADERS_JSON: JSON.stringify({ Authorization: "Bearer stale-header-token", "X-Tenant": "preserve-me" }),
    AFFINE_WORKSPACE_ID: "workspace-one",
  });
  const headerOnlyEnv = cleanEnvironment(headerOnlyHome);
  const headerOnlyBefore = readConfig(headerOnlyHome);
  const headerOnlyGuard = await runCli(
    ["login", "--url", baseUrl, "--cookie-stdin"],
    headerOnlyEnv,
    "renewed-cookie\n",
  );
  expect(!headerOnlyGuard.timedOut && headerOnlyGuard.code !== 0, "header-only credentials should require --force");
  expect(headerOnlyGuard.stderr.includes("--force is required"), "header-only overwrite guard was unclear");
  expect(readConfig(headerOnlyHome) === headerOnlyBefore, "header-only overwrite guard changed config");

  const headerOnlyRenewal = await runCli(
    ["login", "--url", baseUrl, "--cookie-stdin", "--workspace-id", "workspace-one", "--force"],
    headerOnlyEnv,
    "renewed-cookie\n",
  );
  expect(!headerOnlyRenewal.timedOut && headerOnlyRenewal.code === 0, `header-only renewal failed: ${headerOnlyRenewal.stderr}`);
  const renewedConfig = readConfig(headerOnlyHome);
  expect(renewedConfig.includes("AFFINE_COOKIE=renewed-cookie"), "header-only renewal did not save the new credential");
  expect(!renewedConfig.includes("stale-header-token") && renewedConfig.includes("X-Tenant\":\"preserve-me"), "header-only renewal did not sanitize auth headers");
  const renewedSnippet = await runCli(["snippet", "claude", "--env"], headerOnlyEnv);
  expect(renewedSnippet.code === 0, `renewed snippet failed: ${renewedSnippet.stderr}`);
  const renewedSnippetEnv = JSON.parse(renewedSnippet.stdout).mcpServers.affine.env;
  expect(renewedSnippetEnv.AFFINE_COOKIE === "renewed-cookie", "snippet did not emit the selected credential");
  expect(!renewedSnippetEnv.AFFINE_HEADERS_JSON.includes("Authorization") && renewedSnippetEnv.AFFINE_HEADERS_JSON.includes("X-Tenant"), "snippet copied an auth header instead of canonical headers");

  const realtimeDoctor = await runCli(["doctor", "--json"], savedEnv);
  expect(!realtimeDoctor.timedOut && realtimeDoctor.code !== 0, "doctor should fail when realtime root metadata is unavailable");
  const realtimeDoctorJson = JSON.parse(realtimeDoctor.stdout);
  expect(realtimeDoctorJson.checks.some(check => check.name === "realtime-root-read" && !check.ok), "doctor reported unavailable realtime root as healthy");

  const invalidProfileDoctor = await runCli(
    ["doctor", "--json"],
    cleanEnvironment(savedHome, { AFFINE_TOOL_PROFILE: "invalid-profile" }),
  );
  expect(!invalidProfileDoctor.timedOut && invalidProfileDoctor.code !== 0, "doctor should reject an invalid tool profile");
  const invalidProfileJson = JSON.parse(invalidProfileDoctor.stdout);
  expect(invalidProfileJson.checks.some(check => check.name === "tool-filter" && !check.ok), "doctor reported an invalid tool profile as healthy");

  const unknownWorkspaceHome = path.join(tempRoot, "unknown-workspace");
  writeConfig(unknownWorkspaceHome, {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_API_TOKEN: "unknown-workspace-token",
    AFFINE_WORKSPACE_ID: "workspace-missing",
  });
  const unknownWorkspaceDoctor = await runCli(["doctor", "--json"], cleanEnvironment(unknownWorkspaceHome));
  expect(!unknownWorkspaceDoctor.timedOut && unknownWorkspaceDoctor.code !== 0, "doctor should fail for an unknown default workspace");
  const unknownWorkspaceJson = JSON.parse(unknownWorkspaceDoctor.stdout);
  expect(unknownWorkspaceJson.checks.some(check => check.name === "workspace-membership" && !check.ok), "doctor reported an unknown default workspace as healthy");

  const freshHome = path.join(tempRoot, "fresh-login");
  const retriedLogin = await runCli(
    ["login", "--url", baseUrl, "--force"],
    cleanEnvironment(freshHome),
    "9\n1\nonboarding@example.test\npassword\n1\n",
  );
  expect(retriedLogin.code === 0, `strict auth-method retry failed: ${retriedLogin.stderr}`);
  expect(
    retriedLogin.stderr.includes("Choose one of")
      && retriedLogin.stderr.includes("Selected workspace")
      && retriedLogin.stderr.includes("snippet codex"),
    "login retry/success guidance is missing",
  );
  expect(readConfig(freshHome).includes("AFFINE_WORKSPACE_ID=workspace-one"), "interactive login did not save the selected membership");

  const reusedUrl = await runCli(["login", "--force"], cleanEnvironment(freshHome),
    "\n1\nonboarding@example.test\npassword\n1\n");
  expect(reusedUrl.code === 0 && reusedUrl.stderr.includes(`Affine URL [${baseUrl}]`),
    `interactive re-login did not reuse the saved URL: ${reusedUrl.stderr}`);
  const beforeDiscoveryFailure = readConfig(freshHome);
  for (const mode of ["empty", "failure"]) {
    discoveryMode = mode;
    const failedLogin = await runCli(
      ["login", "--url", baseUrl, "--cookie-stdin", "--workspace-id", "workspace-one", "--force"],
      cleanEnvironment(freshHome), "replacement-cookie\n",
    );
    expect(failedLogin.code !== 0 && !failedLogin.stderr.includes("Saved to"), `${mode} discovery claimed successful login`);
    expect(readConfig(freshHome) === beforeDiscoveryFailure, `${mode} discovery overwrote saved credentials`);
  }
  discoveryMode = "success";

  const eofHome = path.join(tempRoot, "eof");
  const eof = await runCli(
    ["login", "--url", baseUrl, "--cookie-stdin", "--force"],
    cleanEnvironment(eofHome),
    "",
  );
  expect(eof.code !== 0 && eof.stderr.includes("Input ended"), "EOF should produce a readable cancellation");
  expect(!eof.stderr.includes("Saved to"), "EOF login must not claim success");

  console.log(JSON.stringify({
    ok: true,
    cases: [
      "workspaces --json fallback labels and URLs",
      "workspace switch membership and config preservation",
      "workspace invalid selector and environment override safety",
      "snippet snapshot warning",
      "strict auth-method retry",
      "piped login EOF recovery",
    ],
  }, null, 2));
} finally {
  await new Promise(resolve => upstream.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
}
