#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const BIN_ENTRY = path.join(ROOT, "bin", "affine-mcp");
const expectedVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function runVersionCheck(label, args) {
  const result = spawnSync("node", args, {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${label} exited with ${result.status}: ${result.stderr || result.stdout}`);
  }

  const stdout = result.stdout.trim();
  if (stdout !== expectedVersion) {
    throw new Error(`${label} stdout mismatch: expected ${expectedVersion}, got ${JSON.stringify(stdout)}`);
  }

  if (result.stderr.trim()) {
    throw new Error(`${label} wrote unexpected stderr: ${result.stderr}`);
  }
}

runVersionCheck("dist --version", [DIST_ENTRY, "--version"]);
runVersionCheck("dist -v", [DIST_ENTRY, "-v"]);
runVersionCheck("dist version", [DIST_ENTRY, "version"]);
runVersionCheck("dist -- --version", [DIST_ENTRY, "--", "--version"]);
runVersionCheck("bin --version", [BIN_ENTRY, "--version"]);
runVersionCheck("bin -v", [BIN_ENTRY, "-v"]);
runVersionCheck("bin version", [BIN_ENTRY, "version"]);
runVersionCheck("bin -- --version", [BIN_ENTRY, "--", "--version"]);

// Exercise the Web Storage probe after module evaluation, without process.exit
// hiding queued warnings. Explicitly installed polyfills must remain intact.
for (const [label, setup, assertion] of [
  ["native storage", "", ""],
  ["explicit polyfill", 'const storage = { getItem() { return null; } }; Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });', 'if (globalThis.localStorage !== storage) throw new Error("polyfill was replaced");'],
  ["lazy storage", 'let reads = 0; Object.defineProperty(globalThis, "localStorage", { get() { reads += 1; throw new Error("unused getter called"); }, configurable: true });', 'if (reads !== 0) throw new Error("unused getter was read");'],
]) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `${setup}\nawait import('./dist/nodeRuntime.js');\nawait import('yjs');\n${assertion}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 || /localStorage|ExperimentalWarning/.test(result.stderr)) {
    throw new Error(`${label} bootstrap failed: ${result.stderr}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  version: expectedVersion,
  cases: [
    "dist --version",
    "dist -v",
    "dist version",
    "dist -- --version",
    "bin --version",
    "bin -v",
    "bin version",
    "bin -- --version",
  ],
}, null, 2));
