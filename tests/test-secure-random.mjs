#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  secureRandomInt31,
  secureRandomString,
} from "../dist/util/random.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, "..", "src");
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

const identifiers = Array.from(
  { length: 512 },
  () => secureRandomString(21, alphabet),
);
assert.equal(new Set(identifiers).size, identifiers.length, "sample identifiers must be unique");
for (const identifier of identifiers) {
  assert.equal(identifier.length, 21);
  assert.match(identifier, /^[A-Za-z0-9_-]+$/);
}

for (let index = 0; index < 1_000; index += 1) {
  const seed = secureRandomInt31();
  assert(Number.isInteger(seed));
  assert(seed >= 0 && seed < 2 ** 31);
}

assert.throws(() => secureRandomString(0, alphabet), /positive safe integer/);
assert.throws(() => secureRandomString(1.5, alphabet), /positive safe integer/);
assert.throws(() => secureRandomString(10, "x"), /at least two/);
assert.throws(() => secureRandomString(10, "aab"), /duplicate/);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolutePath) : [absolutePath];
  });
}

for (const file of walk(sourceRoot).filter((entry) => entry.endsWith(".ts"))) {
  const source = fs.readFileSync(file, "utf8");
  assert.equal(
    source.includes("Math.random"),
    false,
    `${path.relative(sourceRoot, file)} must not use Math.random for persisted identifiers`,
  );
}

console.log("Secure random identifier tests passed");
