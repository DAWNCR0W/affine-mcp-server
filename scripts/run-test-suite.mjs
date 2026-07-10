#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_SUITES, loadAndValidateTestSuites } from "./test-suite-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(__dirname, "..");
const suiteName = process.argv[2];
const listOnly = process.argv.includes("--list");

if (!suiteName || !REQUIRED_SUITES.includes(suiteName)) {
  console.error(`Usage: node scripts/run-test-suite.mjs <${REQUIRED_SUITES.join("|")}> [--list]`);
  process.exit(2);
}

let result;
try {
  result = loadAndValidateTestSuites(rootDirectory);
} catch (error) {
  console.error(`ERROR: ${error?.message || String(error)}`);
  process.exit(1);
}

if (result.errors.length > 0) {
  for (const error of result.errors) {
    console.error(`ERROR: ${error}`);
  }
  process.exit(1);
}

const testFiles = result.manifest.suites[suiteName];
if (listOnly) {
  for (const file of testFiles) {
    console.log(file);
  }
  process.exit(0);
}

console.log(`=== Running ${suiteName} test suite (${testFiles.length} tests) ===`);
for (const [index, file] of testFiles.entries()) {
  console.log(`\n[${index + 1}/${testFiles.length}] ${file}`);
  const testResult = spawnSync(process.execPath, [path.join("tests", file)], {
    cwd: rootDirectory,
    env: process.env,
    stdio: "inherit",
  });

  if (testResult.error) {
    console.error(`ERROR: Failed to start ${file}: ${testResult.error.message}`);
    process.exit(1);
  }
  if (testResult.signal) {
    console.error(`ERROR: ${file} was terminated by signal ${testResult.signal}.`);
    process.exit(1);
  }
  if (testResult.status !== 0) {
    console.error(`ERROR: ${file} failed with exit code ${testResult.status}.`);
    process.exit(testResult.status || 1);
  }
}

console.log(`\n=== ${suiteName} test suite passed (${testFiles.length} tests) ===`);
