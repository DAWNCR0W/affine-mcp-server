#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
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
const serverEnvironment = {
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
};

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
    env: serverEnvironment,
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

async function verifyProxySurface(installedDirectory, installedManifest) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  const token = "package-smoke-http-token";
  const server = spawn(process.execPath, [path.join(installedDirectory, "dist", "index.js")], {
    cwd: temporaryDirectory,
    env: {
      ...serverEnvironment,
      MCP_TRANSPORT: "http",
      PORT: String(port),
      AFFINE_MCP_HTTP_HOST: "127.0.0.1",
      AFFINE_MCP_HTTP_TOKEN: token,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  server.stderr.on("data", chunk => { logs += chunk; });
  const exited = once(server, "exit");
  const proxyBin = path.join(installedDirectory, "bin", "affine-mcp-http-proxy");
  const installedBin = path.join(temporaryDirectory, "node_modules", ".bin", "affine-mcp-http-proxy");
  const client = new Client({ name: "packed-proxy-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? process.execPath : installedBin,
    args: process.platform === "win32" ? [proxyBin] : [],
    cwd: temporaryDirectory,
    env: {
      ...serverEnvironment,
      AFFINE_MCP_HTTP_TOKEN: token,
      AFFINE_MCP_HTTP_PROXY_URL: `${endpoint}/mcp`,
      AFFINE_MCP_HTTP_PROXY_TIMEOUT_MS: "10000",
    },
    stderr: "pipe",
  });
  try {
    assert.ok(fs.existsSync(proxyBin), "packed proxy executable must exist");
    assert.ok(fs.existsSync(path.join(installedDirectory, "dist", "stdioHttpProxy.js")),
      "packed proxy implementation must exist");
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(server.exitCode, null, `packed HTTP server exited: ${logs}`);
      try {
        const response = await fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1000) });
        healthy = response.ok;
        await response.body?.cancel();
      } catch { /* Wait for the listener to bind. */ }
      if (healthy) break;
      await delay(100);
    }
    assert.ok(healthy, `packed HTTP server did not become healthy: ${logs}`);
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...installedManifest.tools].sort(),
      "installed proxy must expose the real packaged HTTP listener's tool surface");
  } finally {
    await transport.close();
    if (server.exitCode === null) server.kill("SIGTERM");
    if (!await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) {
      server.kill("SIGKILL");
      await exited;
    }
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

  for (const test of ["test-cli-onboarding.mjs", "test-cli-tty.mjs"]) {
    run(process.execPath, [path.join(rootDirectory, "tests", test)], {
      env: { ...serverEnvironment, AFFINE_CLI_TEST_ENTRY: binEntry },
      timeout: 120_000,
    });
  }

  await verifyServerSurface(installedDirectory, installedManifest);
  await verifyProxySurface(installedDirectory, installedManifest);

  console.log(JSON.stringify({
    ok: true,
    tarball: tarballPath,
    package: `${installedPackage.name}@${installedPackage.version}`,
    tools: installedManifest.tools.length,
    checks: ["installed package", "bin version", "dist version", "CLI help", "installed CLI onboarding", "installed CLI TTY login", "MCP tools/list", "installed proxy to HTTP tools/list"],
  }, null, 2));
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
