#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(__dirname, "..");
const tarballFlagIndex = process.argv.indexOf("--tarball");
const tarballArgument = tarballFlagIndex === -1 ? undefined : process.argv[tarballFlagIndex + 1];
const tarballPath = tarballArgument ? path.resolve(tarballArgument) : undefined;

if (!tarballPath) {
  throw new Error("Usage: node tests/test-package-smoke.mjs --tarball <package.tgz>");
}
if (!fs.existsSync(tarballPath)) {
  throw new Error(`Package tarball not found: ${tarballPath}`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedPackage = JSON.parse(fs.readFileSync(path.join(rootDirectory, "package.json"), "utf8"));
const expectedManifest = JSON.parse(
  fs.readFileSync(path.join(rootDirectory, "tool-manifest.json"), "utf8")
);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "affine-mcp-package-smoke-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}:\n${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function verifyServerSurface(installedDirectory, installedManifest) {
  const entryPoint = path.join(installedDirectory, "dist", "index.js");
  const client = new Client(
    { name: "affine-mcp-package-smoke", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd: temporaryDirectory,
    env: {
      ...process.env,
      AFFINE_BASE_URL: "http://127.0.0.1:9",
      AFFINE_API_TOKEN: "package-smoke-token",
      AFFINE_COOKIE: "",
      AFFINE_EMAIL: "",
      AFFINE_PASSWORD: "",
      AFFINE_HEADERS_JSON: "",
      AFFINE_MCP_AUTH_MODE: "bearer",
      AFFINE_TOOL_PROFILE: "full",
      AFFINE_DISABLED_GROUPS: "",
      AFFINE_DISABLED_TOOLS: "",
      MCP_TRANSPORT: "stdio",
      XDG_CONFIG_HOME: path.join(temporaryDirectory, "config"),
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[packed-server] ${chunk}`);
  });

  try {
    await client.connect(transport);
    const response = await client.listTools();
    const actualNames = response.tools.map(tool => tool.name).sort();
    const expectedNames = [...installedManifest.tools].sort();
    assert.deepEqual(actualNames, expectedNames, "packed server tool surface must match its manifest");
    assert.ok(response.tools.length > 0, "packed server must expose tools");
    assert.ok(
      response.tools.every(tool => tool.description && tool.inputSchema),
      "every packed tool must expose a description and input schema"
    );
  } finally {
    await transport.close();
  }
}

try {
  fs.writeFileSync(
    path.join(temporaryDirectory, "package.json"),
    JSON.stringify({ name: "affine-mcp-package-smoke", private: true }, null, 2)
  );

  run(npmCommand, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    tarballPath,
  ]);

  const installedDirectory = path.join(
    temporaryDirectory,
    "node_modules",
    expectedPackage.name
  );
  const installedPackage = JSON.parse(
    fs.readFileSync(path.join(installedDirectory, "package.json"), "utf8")
  );
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedDirectory, "tool-manifest.json"), "utf8")
  );
  assert.equal(installedPackage.name, expectedPackage.name);
  assert.equal(installedPackage.version, expectedPackage.version);
  assert.equal(installedManifest.version, expectedPackage.version);
  assert.deepEqual(installedManifest, expectedManifest, "packed tool manifest must match the validated source");

  const binEntry = path.join(installedDirectory, "bin", "affine-mcp");
  const distEntry = path.join(installedDirectory, "dist", "index.js");
  const binVersion = run(process.execPath, [binEntry, "--version"]);
  const distVersion = run(process.execPath, [distEntry, "--version"]);
  const help = run(process.execPath, [binEntry, "--help"]);

  assert.equal(binVersion.stdout.trim(), expectedPackage.version);
  assert.equal(distVersion.stdout.trim(), expectedPackage.version);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /affine-mcp login/);

  await verifyServerSurface(installedDirectory, installedManifest);

  console.log(JSON.stringify({
    ok: true,
    tarball: tarballPath,
    package: `${installedPackage.name}@${installedPackage.version}`,
    tools: installedManifest.tools.length,
    checks: ["installed package", "bin version", "dist version", "CLI help", "MCP tools/list"],
  }, null, 2));
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
