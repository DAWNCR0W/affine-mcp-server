#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PROTECTED_HEADS, evaluatePrRoute } = require("../.github/scripts/pr-route-policy.cjs");

const allowedRoutes = [
  { baseRef: "develop", headRef: "feat/new-tool", code: "develop-target" },
  { baseRef: "develop", headRef: "fix/http-auth", code: "develop-target" },
  { baseRef: "develop", headRef: "release/2.6.0", code: "develop-target" },
  { baseRef: "main", headRef: "release/2.6.0", code: "release-target" },
];

for (const route of allowedRoutes) {
  const result = evaluatePrRoute(route);
  assert.equal(result.allowed, true, `${route.headRef} -> ${route.baseRef} should be allowed`);
  assert.equal(result.code, route.code);
}

for (const headRef of PROTECTED_HEADS) {
  for (const baseRef of ["develop", "main", "feature-target"]) {
    const result = evaluatePrRoute({ baseRef, headRef });
    assert.equal(result.allowed, false, `${headRef} -> ${baseRef} should be blocked`);
    assert.equal(result.code, "protected-head");
  }
}

for (const headRef of ["MAIN", "Develop", "DEV", "Master"]) {
  const result = evaluatePrRoute({ baseRef: "develop", headRef });
  assert.equal(result.allowed, false, `${headRef} -> develop should be blocked case-insensitively`);
  assert.equal(result.code, "protected-head");
}

const invalidRoutes = [
  { baseRef: "main", headRef: "feat/new-tool" },
  { baseRef: "main", headRef: "chore/sync-v2.6.0-to-develop" },
  { baseRef: "main", headRef: "release-candidate/2.6.0" },
  { baseRef: "production", headRef: "release/2.6.0" },
  { baseRef: "feature-target", headRef: "fix/http-auth" },
  { baseRef: "attacker-controlled", headRef: "release/2.6.0" },
];

for (const route of invalidRoutes) {
  const result = evaluatePrRoute(route);
  assert.equal(result.allowed, false, `${route.headRef} -> ${route.baseRef} should be blocked`);
  assert.equal(result.code, "invalid-route");
}

assert.equal(evaluatePrRoute({ baseRef: "", headRef: "feat/test" }).code, "invalid-base");
assert.equal(evaluatePrRoute({ baseRef: "develop", headRef: "" }).code, "invalid-head");

const enforcementWorkflow = fs.readFileSync(
  new URL("../.github/workflows/enforce-pr-base.yml", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  enforcementWorkflow,
  /actions\/checkout|github\.event\.pull_request\.(?:base|head)\.sha/,
  "pull_request_target enforcement must not check out an event-controlled ref",
);
assert.doesNotMatch(
  enforcementWorkflow,
  /GITHUB_WORKSPACE|require\s*\(/,
  "pull_request_target enforcement must not load repository code",
);
assert.match(
  enforcementWorkflow,
  /Keep the policy in\s+\/\/ this trusted workflow and never execute code from an event ref\./,
  "the trusted inline policy guard must remain explicit",
);

console.log("PR route policy tests passed");
