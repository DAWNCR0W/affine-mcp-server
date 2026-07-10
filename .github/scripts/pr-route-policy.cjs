"use strict";

const PROTECTED_HEADS = new Set(["main", "develop", "dev", "master"]);

function evaluatePrRoute({ baseRef, headRef }) {
  if (typeof baseRef !== "string" || baseRef.length === 0) {
    return {
      allowed: false,
      code: "invalid-base",
      reason: "The pull request base branch is missing or invalid.",
    };
  }
  if (typeof headRef !== "string" || headRef.length === 0) {
    return {
      allowed: false,
      code: "invalid-head",
      reason: "The pull request head branch is missing or invalid.",
    };
  }

  const normalizedHead = headRef.toLowerCase();
  if (PROTECTED_HEADS.has(normalizedHead)) {
    return {
      allowed: false,
      code: "protected-head",
      reason:
        `Protected branch \`${headRef}\` cannot be used as a pull request head. ` +
        "Create a dedicated working or synchronization branch instead.",
    };
  }

  if (baseRef === "develop") {
    return {
      allowed: true,
      code: "develop-target",
      reason: "A non-protected branch may target develop.",
    };
  }

  if (baseRef === "main" && headRef.startsWith("release/")) {
    return {
      allowed: true,
      code: "release-target",
      reason: "A release branch may target main.",
    };
  }

  return {
    allowed: false,
    code: "invalid-route",
    reason:
      "Pull requests must target develop from a non-protected branch, " +
      "or target main from a release/* branch.",
  };
}

module.exports = {
  PROTECTED_HEADS,
  evaluatePrRoute,
};

if (require.main === module) {
  const [baseRef, headRef] = process.argv.slice(2);
  const result = evaluatePrRoute({ baseRef, headRef });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.allowed ? 0 : 1);
}
