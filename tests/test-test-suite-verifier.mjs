#!/usr/bin/env node
import assert from "node:assert/strict";

import { validateTestSuiteManifest } from "../scripts/test-suite-lib.mjs";

function createManifest() {
  return {
    version: 1,
    classifications: {
      "test-fast.mjs": "fast",
      "test-live.mjs": "integration",
      "test-receipt.mjs": "integration",
    },
    suites: {
      fast: ["test-fast.mjs"],
      e2e: ["test-receipt.mjs"],
      comprehensive: ["test-live.mjs"],
      manual: [],
    },
    releaseRequired: ["test-receipt.mjs"],
  };
}

const context = {
  discoveredTests: ["test-fast.mjs", "test-live.mjs", "test-receipt.mjs"],
  focusedCoverageFiles: ["test-live.mjs"],
};

function expectError(mutator, expectedMessage) {
  const manifest = structuredClone(createManifest());
  mutator(manifest);
  const errors = validateTestSuiteManifest(manifest, context);
  assert.ok(
    errors.some(error => error.includes(expectedMessage)),
    `Expected an error containing ${JSON.stringify(expectedMessage)}, received ${JSON.stringify(errors)}`
  );
}

assert.deepEqual(validateTestSuiteManifest(createManifest(), context), []);

expectError(
  manifest => { delete manifest.classifications["test-live.mjs"]; },
  "Unclassified test files"
);
expectError(
  manifest => { manifest.classifications["test-missing.mjs"] = "integration"; },
  "Manifest references missing test files"
);
expectError(
  manifest => { manifest.suites.fast.push("test-live.mjs"); },
  "Live test must not be included in the fast suite"
);
expectError(
  manifest => { manifest.suites.comprehensive = []; },
  "Comprehensive coverage credits tests"
);
expectError(
  manifest => { manifest.suites.e2e = []; },
  "Release-required test must be included in the e2e suite"
);
expectError(
  manifest => { manifest.suites.fast.push("test-fast.mjs"); },
  "contains duplicate entries"
);

console.log("Test suite manifest verifier tests passed");
