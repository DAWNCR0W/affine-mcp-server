#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  extractDocumentedAffineVariables,
  extractDocumentedTools,
  extractRelativeMarkdownTargets,
  extractRuntimeAffineVariables,
  validateDocumentation,
} from "../scripts/docs-drift-lib.mjs";

const toolReference = [
  "| Tool | Purpose |",
  "| --- | --- |",
  "| `read_doc` | Read a document |",
  "| `write_doc` | Write a document |",
  "",
  "| Field | Purpose |",
  "| --- | --- |",
  "| `not_a_tool` | Example input field |",
].join("\n");
const configurationReference = [
  "| Variable | Default |",
  "| --- | --- |",
  "| `AFFINE_BASE_URL` | local |",
  "| `AFFINE_API_TOKEN` | none |",
].join("\n");

const documentedTools = extractDocumentedTools(toolReference);
const documentedAffineVariables = extractDocumentedAffineVariables(configurationReference);
const runtimeAffineVariables = extractRuntimeAffineVariables([
  "const base = process.env.AFFINE_BASE_URL;",
  "const token = env.AFFINE_API_TOKEN; const duplicate = 'AFFINE_API_TOKEN';",
  "const documentationOnly = 'AFFINE_NOT_A_RUNTIME_ACCESS';",
]);
const readmeTargets = extractRelativeMarkdownTargets(
  "[Guide](docs/guide.md#usage) [Changes](CHANGELOG.md) [Web](https://example.test)"
);

assert.deepEqual(documentedTools, ["read_doc", "write_doc"]);
assert.deepEqual(documentedAffineVariables, ["AFFINE_BASE_URL", "AFFINE_API_TOKEN"]);
assert.deepEqual(runtimeAffineVariables, ["AFFINE_API_TOKEN", "AFFINE_BASE_URL"]);
assert.deepEqual(readmeTargets, ["CHANGELOG.md", "docs/guide.md"]);

const validInput = {
  manifestTools: ["read_doc", "write_doc"],
  documentedTools,
  runtimeAffineVariables,
  documentedAffineVariables,
  readmeTargets,
  packageFiles: ["docs", "CHANGELOG.md"],
  existingPaths: new Set(["docs/guide.md", "CHANGELOG.md"]),
};
assert.deepEqual(validateDocumentation(validInput), []);

function expectError(overrides, expectedMessage) {
  const errors = validateDocumentation({ ...validInput, ...overrides });
  assert.ok(
    errors.some(error => error.includes(expectedMessage)),
    `Expected ${JSON.stringify(expectedMessage)}, received ${JSON.stringify(errors)}`
  );
}

expectError({ documentedTools: ["read_doc"] }, "Manifest tools missing");
expectError({ documentedTools: [...documentedTools, "removed_tool"] }, "missing from tool-manifest.json");
expectError({ documentedTools: [...documentedTools, "read_doc"] }, "Duplicate canonical tool rows");
expectError({ documentedAffineVariables: ["AFFINE_BASE_URL"] }, "Runtime AFFINE variables missing");
expectError(
  { documentedAffineVariables: [...documentedAffineVariables, "AFFINE_REMOVED"] },
  "missing from runtime source"
);
expectError({ existingPaths: new Set(["docs/guide.md"]) }, "links to a missing local path");
expectError({ packageFiles: ["docs"] }, "excluded from the npm package");

console.log("Documentation drift verifier tests passed");
