#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAndValidateTestSuites } from "./test-suite-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(__dirname, "..");

try {
  const result = loadAndValidateTestSuites(rootDirectory);
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`ERROR: ${error}`);
    }
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    manifest: path.relative(rootDirectory, result.manifestPath),
    discoveredTests: result.discoveredTests.length,
    focusedCoverageFiles: result.focusedCoverageFiles.length,
    suites: Object.fromEntries(
      Object.entries(result.manifest.suites).map(([name, files]) => [name, files.length])
    ),
  }, null, 2));
} catch (error) {
  console.error(`ERROR: ${error?.message || String(error)}`);
  process.exit(1);
}
