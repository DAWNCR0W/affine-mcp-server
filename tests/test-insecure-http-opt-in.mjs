#!/usr/bin/env node
/**
 * Regression tests for the plain-HTTP opt-in on the CLI login path.
 *
 * `AFFINE_ALLOW_INSECURE_HTTP=true` is a documented escape hatch for a trusted
 * private network. It was ineffective for `affine-mcp login`: the CLI granted
 * the opt-in to `validateBaseUrl`, then re-validated the same URL through
 * `buildGraphqlEndpoint`, which dropped the option and threw
 * "must use HTTPS for non-loopback destinations". Only the CLI was affected —
 * the runtime builds its endpoint in `loadConfig`, which forwards the option.
 *
 * These tests also pin the AFFiNE Cloud vs self-hosted classification used to
 * pick the login method menu, which previously matched "affine.pro" as a
 * substring of the whole URL.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGraphqlEndpoint } from "../dist/config.js";
import { isAffineCloudUrl } from "../dist/networkSecurity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI_ENTRY = path.join(PROJECT_DIR, "dist", "index.js");

const HTTPS_REMOTE = "https://affine.example.com";
const PLAIN_HTTP_REMOTE = "http://0.0.0.0:9";
const PLAIN_HTTP_LOOPBACK = "http://127.0.0.1:3010";
const INSECURE_OPTIONS = {
  allowInsecureHttp: true,
  insecureHttpOptInName: "AFFINE_ALLOW_INSECURE_HTTP",
  label: "AFFINE URL",
};
const HTTPS_REJECTION = "must use HTTPS for non-loopback destinations";

/** Run `fn` with `console.warn` captured, so expected warnings stay out of the log. */
function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

function runCli(args, environment = {}, input = "") {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.AFFINE_ALLOW_INSECURE_HTTP;
    delete env.AFFINE_BASE_URL;
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: PROJECT_DIR,
      env: {
        ...env,
        XDG_CONFIG_HOME: mkdtempSync(path.join(os.tmpdir(), "affine-mcp-insecure-http-")),
        ...environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // Empty stdin would leave a readline prompt pending forever; an empty line
    // accepts the prompt default when a prompt is reached.
    child.stdin.end(input);
  });
}

/** `buildGraphqlEndpoint` must forward the opt-in it was given. */
function testGraphqlEndpointForwardsInsecureOptIn() {
  const optedIn = captureWarnings(
    () => buildGraphqlEndpoint(`${PLAIN_HTTP_REMOTE}/`, "graphql", INSECURE_OPTIONS),
  );
  assert.equal(
    optedIn.result,
    "http://0.0.0.0:9/graphql",
    "opt-in must survive normalization of base URL and GraphQL path",
  );
  assert.equal(
    optedIn.warnings.length,
    1,
    `the opt-in must warn exactly once per call: ${JSON.stringify(optedIn.warnings)}`,
  );
  assert.ok(
    optedIn.warnings[0].includes("uses plain HTTP for a non-loopback destination"),
    `the warning must explain the exposure: ${optedIn.warnings[0]}`,
  );

  assert.throws(
    () => buildGraphqlEndpoint(PLAIN_HTTP_REMOTE, "/graphql"),
    /must use HTTPS/,
    "plain HTTP must stay rejected without the opt-in",
  );
  assert.throws(
    () => buildGraphqlEndpoint(PLAIN_HTTP_REMOTE, "/graphql", { label: "AFFINE URL" }),
    /must use HTTPS/,
    "a partial options object must not silently grant the opt-in",
  );

  assert.equal(
    buildGraphqlEndpoint(PLAIN_HTTP_LOOPBACK, "/graphql"),
    "http://127.0.0.1:3010/graphql",
    "loopback plain HTTP needs no opt-in",
  );
  assert.equal(
    buildGraphqlEndpoint(HTTPS_REMOTE, "/graphql", INSECURE_OPTIONS),
    "https://affine.example.com/graphql",
    "HTTPS is unaffected by the opt-in",
  );
}

/** Cloud detection must match complete hostname labels, not a substring. */
function testAffineCloudHostnameDetection() {
  const cloud = [
    "https://app.affine.pro",
    "https://affine.pro",
    "https://affine.pro/",
    "HTTPS://APP.AFFINE.PRO/workspace",
    "https://app.affine.pro:443/path",
    "https://affine.pro.",
  ];
  for (const url of cloud) {
    assert.equal(isAffineCloudUrl(url), true, `${url} should be AFFiNE Cloud`);
  }

  const selfHosted = [
    "http://47.100.255.180:3010",
    "https://affine.example.com",
    "http://localhost:3010",
    // Substring traps: these contain "affine.pro" but are self-hosted hosts.
    "https://affine.proxy.internal",
    "https://affine.pro.example.com",
    "https://my-affine.prototype.dev",
    "https://notaffine.pro",
    "not-a-url",
  ];
  for (const url of selfHosted) {
    assert.equal(isAffineCloudUrl(url), false, `${url} should be self-hosted`);
  }
}

/** The documented opt-in must reach the real CLI login path, not just helpers. */
async function testLoginCliHonorsInsecureOptIn() {
  const args = [
    "login",
    "--url", PLAIN_HTTP_REMOTE,
    "--token", "regression-test-token",
    "--workspace-id", "regression-workspace",
    "--force",
  ];

  const withoutOptIn = await runCli(args);
  assert.equal(withoutOptIn.code, 1, "login without the opt-in must fail");
  assert.ok(
    withoutOptIn.stderr.includes(HTTPS_REJECTION),
    `login without the opt-in must explain the HTTPS requirement: ${withoutOptIn.stderr}`,
  );

  const withOptIn = await runCli(args, { AFFINE_ALLOW_INSECURE_HTTP: "true" });
  assert.equal(withOptIn.code, 1, "unreachable host must still fail the connection");
  assert.ok(
    !withOptIn.stderr.includes(HTTPS_REJECTION),
    `the opt-in must reach buildGraphqlEndpoint: ${withOptIn.stderr}`,
  );
  assert.ok(
    withOptIn.stderr.includes("WARNING: AFFINE URL uses plain HTTP"),
    `the opt-in must still warn about plain HTTP: ${withOptIn.stderr}`,
  );
  assert.ok(
    withOptIn.stderr.includes("Authentication failed"),
    `login must proceed past URL validation to the network call: ${withOptIn.stderr}`,
  );

  const fromConfigFile = await runCli(
    ["login", "--url", PLAIN_HTTP_REMOTE, "--token", "regression-test-token", "--force"],
    { AFFINE_ALLOW_INSECURE_HTTP: "false" },
  );
  assert.ok(
    fromConfigFile.stderr.includes(HTTPS_REJECTION),
    `an explicit false opt-in must keep plain HTTP rejected: ${fromConfigFile.stderr}`,
  );
}

/** The opt-in is read from the saved config file, matching runtime semantics. */
async function testLoginCliReadsOptInFromConfigFile() {
  const configHome = mkdtempSync(path.join(os.tmpdir(), "affine-mcp-insecure-config-"));
  const configDir = path.join(configHome, "affine-mcp");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "config"),
    [
      `AFFINE_BASE_URL=${PLAIN_HTTP_REMOTE}`,
      "AFFINE_ALLOW_INSECURE_HTTP=true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const result = await runCli(
    ["login", "--token", "regression-test-token", "--workspace-id", "w", "--force"],
    { XDG_CONFIG_HOME: configHome },
    "\n",
  );
  assert.ok(
    !result.stderr.includes(HTTPS_REJECTION),
    `a config-file opt-in must be honored by login: ${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes("Affine URL [http://0.0.0.0:9]"),
    `the prompt must default to the configured URL: ${result.stderr}`,
  );
}

async function main() {
  testGraphqlEndpointForwardsInsecureOptIn();
  testAffineCloudHostnameDetection();
  await testLoginCliHonorsInsecureOptIn();
  await testLoginCliReadsOptInFromConfigFile();
  console.log("Plain-HTTP opt-in regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
