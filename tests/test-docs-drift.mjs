#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  extractDocumentedRuntimeVariables,
  extractDocumentedTools,
  extractRelativeMarkdownTargets,
  extractRuntimeConfigVariables,
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
  "| `MCP_TRANSPORT` | stdio |",
  "| `PORT` | 3000 |",
  "| `XDG_CONFIG_HOME` | platform default |",
].join("\n");

const documentedTools = extractDocumentedTools(toolReference);
const documentedRuntimeVariables = extractDocumentedRuntimeVariables(configurationReference);
const runtimeConfigVariables = extractRuntimeConfigVariables([
  "const base = process.env.AFFINE_BASE_URL;",
  "const token = env.AFFINE_API_TOKEN; const duplicate = 'AFFINE_API_TOKEN';",
  "const transport = process.env.MCP_TRANSPORT;",
  "const port = process.env['PORT'];",
  "const configHome = process.env.XDG_CONFIG_HOME;",
  "const documentationOnly = 'AFFINE_NOT_A_RUNTIME_ACCESS';",
]);
const readmeTargets = extractRelativeMarkdownTargets(
  "[Guide](docs/guide.md#usage) [Changes](CHANGELOG.md) [Web](https://example.test)"
);

assert.deepEqual(documentedTools, ["read_doc", "write_doc"]);
assert.deepEqual(documentedRuntimeVariables, [
  "AFFINE_BASE_URL",
  "AFFINE_API_TOKEN",
  "MCP_TRANSPORT",
  "PORT",
  "XDG_CONFIG_HOME",
]);
assert.deepEqual(runtimeConfigVariables, [
  "AFFINE_API_TOKEN",
  "AFFINE_BASE_URL",
  "MCP_TRANSPORT",
  "PORT",
  "XDG_CONFIG_HOME",
]);
assert.deepEqual(readmeTargets, ["CHANGELOG.md", "docs/guide.md"]);

const validInput = {
  manifestTools: ["read_doc", "write_doc"],
  documentedTools,
  runtimeConfigVariables,
  documentedRuntimeVariables,
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
expectError(
  { documentedRuntimeVariables: documentedRuntimeVariables.filter(variable => variable !== "XDG_CONFIG_HOME") },
  "Runtime configuration variables missing",
);
expectError(
  { documentedRuntimeVariables: [...documentedRuntimeVariables, "AFFINE_REMOVED"] },
  "missing from runtime source"
);
expectError({ existingPaths: new Set(["docs/guide.md"]) }, "links to a missing local path");
expectError({ packageFiles: ["docs"] }, "excluded from the npm package");

console.log("Documentation drift verifier tests passed");
