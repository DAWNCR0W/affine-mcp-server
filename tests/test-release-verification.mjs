#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateReleaseGitState,
  validateReleaseMetadata,
  versionFromReleaseTag,
} from "../scripts/verify-release.mjs";

function writeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "affine-release-test-"));
  const version = overrides.version || "2.5.0";
  const files = {
    "package.json": JSON.stringify({ version: overrides.packageVersion || version }),
    "package-lock.json": JSON.stringify({
      version: overrides.lockVersion || version,
      packages: { "": { version: overrides.lockPackageVersion || version } },
    }),
    "tool-manifest.json": JSON.stringify({ version: overrides.manifestVersion || version, tools: [] }),
    "README.md": `[![Version](https://img.shields.io/badge/version-${overrides.badgeVersion || version}-blue)](#)`,
    "CHANGELOG.md": `## [${overrides.changelogVersion || version}]\n[${overrides.changelogVersion || version}]: https://example.test/releases/tag/v${overrides.changelogVersion || version}`,
    "RELEASE_NOTES.md": `## Version ${overrides.notesVersion || version}`,
  };

  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

assert.equal(versionFromReleaseTag("v2.5.0"), "2.5.0");
for (const tag of ["2.5.0", "v2.5", "v2.5.0-beta.1", "v02.5.0", "release-v2.5.0"]) {
  assert.throws(() => versionFromReleaseTag(tag), /exact vX\.Y\.Z format/);
}

const validRoot = writeFixture();
assert.deepEqual(validateReleaseMetadata(validRoot, "v2.5.0"), {
  tag: "v2.5.0",
  version: "2.5.0",
});

const invalidRoot = writeFixture({
  lockVersion: "2.4.0",
  manifestVersion: "2.4.0",
  badgeVersion: "2.4.0",
  notesVersion: "2.4.0",
});
assert.throws(
  () => validateReleaseMetadata(invalidRoot, "v2.5.0"),
  error =>
    error.message.includes("package-lock.json root version") &&
    error.message.includes("tool-manifest.json version") &&
    error.message.includes("README version badge") &&
    error.message.includes("RELEASE_NOTES.md has no release section"),
);

const calls = [];
const fakeGit = (args) => {
  calls.push(args.join(" "));
  if (args[0] === "cat-file") return "tag";
  if (args[0] === "rev-parse") return "abc123";
  return "";
};
assert.deepEqual(
  validateReleaseGitState(validRoot, {
    tag: "v2.5.0",
    commit: "abc123",
    mainRef: "origin/main",
  }, fakeGit),
  { commit: "abc123", mainRef: "origin/main", tag: "v2.5.0" },
);
assert.deepEqual(calls, [
  "cat-file -t refs/tags/v2.5.0",
  "rev-parse refs/tags/v2.5.0^{commit}",
  "rev-parse abc123^{commit}",
  "merge-base --is-ancestor abc123 origin/main",
]);

assert.throws(
  () => validateReleaseGitState(validRoot, {
    tag: "v2.5.0",
    commit: "abc123",
    mainRef: "origin/main",
  }, (args) => args[0] === "cat-file" ? "commit" : "abc123"),
  /must be an annotated tag; found Git object type commit/,
);

assert.throws(
  () => validateReleaseGitState(validRoot, {
    tag: "v2.5.0",
    commit: "different",
    mainRef: "origin/main",
  }, (args) => {
    if (args[0] === "cat-file") return "tag";
    return args[1].startsWith("refs/tags/v2.5.0") ? "tagged" : "requested";
  }),
  /not the requested release commit/,
);

console.log("Release verification tests passed");
