#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractDocumentedRuntimeVariables,
  extractDocumentedTools,
  extractRelativeMarkdownTargets,
  extractRuntimeConfigVariables,
  validateDocumentation,
} from "./docs-drift-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDirectory, relativePath), "utf8");
}

function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

const toolManifest = readJson("tool-manifest.json");
const packageJson = readJson("package.json");
const toolReference = readText("docs/tool-reference.md");
const configurationReference = readText("docs/configuration-and-deployment.md");
const readme = readText("README.md");
const runtimeSources = collectTypeScriptFiles(path.join(rootDirectory, "src"))
  .map(file => fs.readFileSync(file, "utf8"));

const documentedTools = extractDocumentedTools(toolReference);
const runtimeConfigVariables = extractRuntimeConfigVariables(runtimeSources);
const documentedRuntimeVariables = extractDocumentedRuntimeVariables(configurationReference);
const readmeTargets = extractRelativeMarkdownTargets(readme);
const existingPaths = new Set(
  readmeTargets.filter(target => fs.existsSync(path.join(rootDirectory, target)))
);

const errors = validateDocumentation({
  manifestTools: toolManifest.tools,
  documentedTools,
  runtimeConfigVariables,
  documentedRuntimeVariables,
  readmeTargets,
  packageFiles: packageJson.files,
  existingPaths,
});

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`ERROR: ${error}`);
  }
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  documentedTools: documentedTools.length,
  runtimeConfigVariables: runtimeConfigVariables.length,
  packagedReadmeTargets: readmeTargets.length,
}, null, 2));
