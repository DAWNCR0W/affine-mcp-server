#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function addMismatch(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
  }
}

export function versionFromReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(tag || "");
  if (!match) {
    throw new Error(`Release tag must use the exact vX.Y.Z format; received ${JSON.stringify(tag)}.`);
  }
  return tag.slice(1);
}

export function validateReleaseMetadata(root, tag) {
  const version = versionFromReleaseTag(tag);
  const packageJson = readJson(root, "package.json");
  const packageLock = readJson(root, "package-lock.json");
  const toolManifest = readJson(root, "tool-manifest.json");
  const readme = readText(root, "README.md");
  const changelog = readText(root, "CHANGELOG.md");
  const releaseNotes = readText(root, "RELEASE_NOTES.md");
  const errors = [];

  addMismatch(errors, "package.json version", packageJson.version, version);
  addMismatch(errors, "package-lock.json root version", packageLock.version, version);
  addMismatch(errors, "package-lock.json package version", packageLock.packages?.[""]?.version, version);
  addMismatch(errors, "tool-manifest.json version", toolManifest.version, version);

  const badgeVersion = readme.match(/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-blue/)?.[1];
  addMismatch(errors, "README version badge", badgeVersion, version);

  if (!changelog.includes(`## [${version}]`)) {
    errors.push(`CHANGELOG.md has no release section for ${version}.`);
  }
  if (!changelog.includes(`[${version}]:`) || !changelog.includes(`/releases/tag/${tag}`)) {
    errors.push(`CHANGELOG.md has no release link for ${tag}.`);
  }
  if (!releaseNotes.includes(`## Version ${version}`)) {
    errors.push(`RELEASE_NOTES.md has no release section for ${version}.`);
  }

  if (errors.length > 0) {
    throw new Error(`Release metadata validation failed:\n- ${errors.join("\n- ")}`);
  }

  return { tag, version };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "git command failed").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function validateReleaseGitState(root, { tag, commit, mainRef }, git = runGit) {
  versionFromReleaseTag(tag);
  if (!commit) {
    throw new Error("A release commit is required.");
  }
  if (!mainRef) {
    throw new Error("A main branch reference is required.");
  }

  const tagRef = `refs/tags/${tag}`;
  const tagObjectType = git(["cat-file", "-t", tagRef], root);
  if (tagObjectType !== "tag") {
    throw new Error(`Release tag ${tag} must be an annotated tag; found Git object type ${tagObjectType}.`);
  }

  const taggedCommit = git(["rev-parse", `${tagRef}^{commit}`], root);
  const resolvedCommit = git(["rev-parse", `${commit}^{commit}`], root);
  if (taggedCommit !== resolvedCommit) {
    throw new Error(`Tag ${tag} resolves to ${taggedCommit}, not the requested release commit ${resolvedCommit}.`);
  }

  git(["merge-base", "--is-ancestor", resolvedCommit, mainRef], root);
  return { commit: resolvedCommit, mainRef, tag };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error(`Expected --name value arguments; received ${JSON.stringify(argv)}.`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const tag = args.get("tag") || process.env.GITHUB_REF_NAME;
  const commit = args.get("commit") || process.env.GITHUB_SHA || "HEAD";
  const mainRef = args.get("main-ref") || "origin/main";

  const metadata = validateReleaseMetadata(root, tag);
  const gitState = validateReleaseGitState(root, { tag, commit, mainRef });
  console.log(JSON.stringify({ ok: true, ...metadata, ...gitState }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
