#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const BIN_ENTRY = path.join(ROOT, "bin", "affine-mcp");

const tempRoot = path.join(os.tmpdir(), `affine-mcp-cli-test-${process.pid}`);
const xdgConfigHome = path.join(tempRoot, "config-home");
const configDir = path.join(xdgConfigHome, "affine-mcp");
const expectedConfigPath = path.join(configDir, "config");

rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(expectedConfigPath, [
  "AFFINE_BASE_URL=https://example.affine.test",
  "AFFINE_API_TOKEN=ut_test_token_12345678",
  "AFFINE_WORKSPACE_ID=workspace-123",
].join("\n"));

function run(label, args, extraEnv = {}) {
  const result = spawnSync("node", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigHome,
      ...extraEnv,
    },
  });
  return { label, ...result };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectSuccess(result, label = result.label) {
  expect(result.status === 0, `${label} exited with ${result.status}: ${result.stderr || result.stdout}`);
}

function expectFailure(result, label = result.label) {
  expect(result.status !== 0, `${label} unexpectedly succeeded`);
}

const helpDist = run("dist --help", [DIST_ENTRY, "--help"]);
expectSuccess(helpDist);
expect(helpDist.stdout.includes("Usage:"), "dist --help should print usage");
expect(helpDist.stdout.includes("doctor"), "dist --help should mention doctor");

const helpBin = run("bin -h", [BIN_ENTRY, "-h"]);
expectSuccess(helpBin);
expect(helpBin.stdout.includes("snippet"), "bin -h should mention snippet");

const configPath = run("config-path", [DIST_ENTRY, "config-path"]);
expectSuccess(configPath);
expect(configPath.stdout.trim() === expectedConfigPath, `config-path mismatch: ${configPath.stdout}`);

const showConfig = run("show-config --json", [DIST_ENTRY, "show-config", "--json"]);
expectSuccess(showConfig);
const showConfigJson = JSON.parse(showConfig.stdout);
expect(showConfigJson.baseUrl === "https://example.affine.test", "show-config baseUrl mismatch");
expect(showConfigJson.workspaceId === "workspace-123", "show-config workspace mismatch");
expect(showConfigJson.apiToken.includes("…"), "show-config should redact token");

const claudeSnippet = run("snippet claude --env", [DIST_ENTRY, "snippet", "claude", "--env"]);
expectSuccess(claudeSnippet);
const claudeJson = JSON.parse(claudeSnippet.stdout);
expect(claudeJson.mcpServers.affine.command === "affine-mcp", "claude snippet command mismatch");
expect(claudeJson.mcpServers.affine.env.AFFINE_BASE_URL === "https://example.affine.test", "claude snippet env missing base URL");

const codexSnippet = run("snippet codex --env", [DIST_ENTRY, "snippet", "codex", "--env"]);
expectSuccess(codexSnippet);
expect(codexSnippet.stdout.includes("codex mcp add affine"), "codex snippet should print codex command");
expect(codexSnippet.stdout.includes("AFFINE_API_TOKEN"), "codex snippet should include env token");

const allSnippet = run("snippet all --env", [DIST_ENTRY, "snippet", "all", "--env"]);
expectSuccess(allSnippet);
const allSnippetJson = JSON.parse(allSnippet.stdout);
expect(allSnippetJson.claude.mcpServers.affine.command === "affine-mcp", "snippet all should include claude payload");
expect(typeof allSnippetJson.codex === "string" && allSnippetJson.codex.includes("codex mcp add affine"), "snippet all should include codex command");

const unknown = run("unknown command", [DIST_ENTRY, "wat"]);
expectFailure(unknown);
expect(unknown.stderr.includes("Unknown command"), "unknown command should print error");

const commandHelp = run("help doctor", [DIST_ENTRY, "help", "doctor"]);
expectSuccess(commandHelp);
expect(commandHelp.stdout.includes("affine-mcp doctor"), "help doctor should print command usage");

console.log(JSON.stringify({
  ok: true,
  cases: [
    "dist --help",
    "bin -h",
    "config-path",
    "show-config --json",
    "snippet claude --env",
    "snippet codex --env",
    "snippet all --env",
    "unknown command",
    "help doctor",
  ],
}, null, 2));
