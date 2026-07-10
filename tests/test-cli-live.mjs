#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * Live CLI integration test against a running AFFiNE instance.
 *
 * Covers:
 * - login --url --token --workspace-id --force
 * - status --json
 * - doctor --json
 * - snippet all --env
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const BIN_ENTRY = path.join(ROOT, "bin", "affine-mcp");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(label, args, xdgConfigHome) {
  const result = spawnSync("node", [BIN_ENTRY, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  });
  return { label, ...result };
}

async function generateAccessToken() {
  const client = new Client({ name: "affine-cli-live-token", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST_ENTRY],
    cwd: ROOT,
    env: {
      ...process.env,
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: testTempPath('cli-live-token-config'),
    },
  });

  await client.connect(transport);
  let workspaceId;
  let tokenId;
  const cleanupTool = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result?.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text || 'unknown error'}`);
    const parsed = JSON.parse(result.content?.[0]?.text || '{}');
    if (parsed?.error || parsed?.success !== true) {
      throw new Error(`${name} cleanup failed: ${parsed?.error || 'success was not true'}`);
    }
  };
  try {
    const workspaceResult = await client.callTool({
      name: "create_workspace",
      arguments: { name: testResourceName('cli-live') },
    });
    if (workspaceResult?.isError) throw new Error(workspaceResult.content?.[0]?.text || 'create_workspace failed');
    const workspace = JSON.parse(workspaceResult.content[0].text);
    workspaceId = workspace.id;
    expect(workspaceId, 'create_workspace did not return an id');

    const tokenResult = await client.callTool({
      name: "generate_access_token",
      arguments: { name: testResourceName('cli-live-token') },
    });
    if (tokenResult?.isError) throw new Error(tokenResult.content?.[0]?.text || 'generate_access_token failed');
    const tokenPayload = JSON.parse(tokenResult.content[0].text);
    tokenId = tokenPayload.id;
    expect(tokenPayload.token, 'generate_access_token did not return a token');
    expect(tokenId, 'generate_access_token did not return an id');

    return {
      token: tokenPayload.token,
      workspaceId,
      async cleanup() {
        try {
          await cleanupTool('delete_workspace', { id: workspaceId, confirmWorkspaceId: workspaceId });
        } finally {
          try {
            await cleanupTool('revoke_access_token', { id: tokenId });
          } finally {
            await transport.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      if (workspaceId) {
        await cleanupTool('delete_workspace', { id: workspaceId, confirmWorkspaceId: workspaceId });
      }
    } finally {
      try {
        if (tokenId) await cleanupTool('revoke_access_token', { id: tokenId });
      } finally {
        await transport.close();
      }
    }
    throw error;
  }
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), "affine-mcp-cli-live-"));
const xdgConfigHome = path.join(tempDir, "config-home");
mkdirSync(xdgConfigHome, { recursive: true });

let remoteArtifacts;
try {
  remoteArtifacts = await generateAccessToken();
  const { token, workspaceId } = remoteArtifacts;

  const login = runCli("login", [
    "login",
    "--url", BASE_URL,
    "--token", token,
    "--workspace-id", workspaceId,
    "--force",
  ], xdgConfigHome);
  expect(login.status === 0, `login failed: ${login.stderr || login.stdout}`);

  const configPath = path.join(xdgConfigHome, "affine-mcp", "config");
  const configContent = readFileSync(configPath, "utf8");
  expect(configContent.includes(`AFFINE_BASE_URL=${BASE_URL}`), "saved config should include base URL");
  expect(configContent.includes(`AFFINE_WORKSPACE_ID=${workspaceId}`), "saved config should include workspace id");

  const status = runCli("status --json", ["status", "--json"], xdgConfigHome);
  expect(status.status === 0, `status --json failed: ${status.stderr || status.stdout}`);
  const statusJson = JSON.parse(status.stdout);
  expect(statusJson.userEmail === EMAIL, `status user email mismatch: ${status.stdout}`);
  expect(statusJson.workspaceId === workspaceId, `status workspace mismatch: ${status.stdout}`);

  const doctor = runCli("doctor --json", ["doctor", "--json"], xdgConfigHome);
  expect(doctor.status === 0, `doctor --json failed: ${doctor.stderr || doctor.stdout}`);
  const doctorJson = JSON.parse(doctor.stdout);
  expect(doctorJson.ok === true, `doctor should be ok: ${doctor.stdout}`);

  const snippet = runCli("snippet all --env", ["snippet", "all", "--env"], xdgConfigHome);
  expect(snippet.status === 0, `snippet all failed: ${snippet.stderr || snippet.stdout}`);
  const snippetJson = JSON.parse(snippet.stdout);
  expect(snippetJson.claude.mcpServers.affine.env.AFFINE_BASE_URL === BASE_URL, "snippet should include base URL");
  expect(snippetJson.codex.includes("AFFINE_API_TOKEN"), "snippet codex should include API token env");

  console.log(JSON.stringify({
    ok: true,
    cases: [
      "login --url --token --workspace-id --force",
      "status --json",
      "doctor --json",
      "snippet all --env",
    ],
  }, null, 2));
} finally {
  try {
    if (remoteArtifacts) await remoteArtifacts.cleanup();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
