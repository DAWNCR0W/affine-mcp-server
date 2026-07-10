import fs from "node:fs";
import path from "node:path";

export const TEST_FILE_PATTERN = /^test-[a-z0-9-]+\.mjs$/;
export const VALID_CLASSIFICATIONS = new Set(["fast", "integration", "browser"]);
export const REQUIRED_SUITES = ["fast", "e2e", "comprehensive", "manual"];

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function discoverTestFiles(testsDirectory) {
  return fs
    .readdirSync(testsDirectory)
    .filter(file => TEST_FILE_PATTERN.test(file))
    .sort();
}

export function extractFocusedCoverageFiles(source) {
  const declarationStart = source.indexOf("const FOCUSED_TOOL_COVERAGE = new Map([");
  if (declarationStart === -1) {
    throw new Error("Could not locate FOCUSED_TOOL_COVERAGE in test-comprehensive.mjs");
  }

  const declarationEnd = source.indexOf("]);", declarationStart);
  if (declarationEnd === -1) {
    throw new Error("Could not locate the end of FOCUSED_TOOL_COVERAGE in test-comprehensive.mjs");
  }

  const declaration = source.slice(declarationStart, declarationEnd);
  const files = [];
  const entryPattern = /\[\s*["'][a-z_]+["']\s*,\s*["'](test-[a-z0-9-]+\.mjs)["']\s*\]/g;
  let match;
  while ((match = entryPattern.exec(declaration)) !== null) {
    files.push(match[1]);
  }
  return [...new Set(files)].sort();
}

export function validateTestSuiteManifest(manifest, context) {
  const errors = [];
  const discoveredTests = sorted(context.discoveredTests || []);
  const focusedCoverageFiles = sorted(context.focusedCoverageFiles || []);

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["Manifest must be a JSON object."];
  }
  if (manifest.version !== 1) {
    errors.push(`Manifest version must be 1; received ${JSON.stringify(manifest.version)}.`);
  }

  const classifications = manifest.classifications;
  if (!classifications || typeof classifications !== "object" || Array.isArray(classifications)) {
    errors.push("Manifest classifications must be an object keyed by test filename.");
  }

  const suites = manifest.suites;
  if (!suites || typeof suites !== "object" || Array.isArray(suites)) {
    errors.push("Manifest suites must be an object keyed by suite name.");
  }

  if (errors.length > 0) {
    return errors;
  }

  const classifiedTests = Object.keys(classifications);
  const discoveredSet = new Set(discoveredTests);
  const classifiedSet = new Set(classifiedTests);

  const orphanTests = discoveredTests.filter(file => !classifiedSet.has(file));
  if (orphanTests.length > 0) {
    errors.push(`Unclassified test files: ${orphanTests.join(", ")}.`);
  }

  const missingTests = classifiedTests.filter(file => !discoveredSet.has(file)).sort();
  if (missingTests.length > 0) {
    errors.push(`Manifest references missing test files: ${missingTests.join(", ")}.`);
  }

  if (JSON.stringify(classifiedTests) !== JSON.stringify(sorted(classifiedTests))) {
    errors.push("Manifest classification keys must be sorted alphabetically.");
  }

  for (const [file, classification] of Object.entries(classifications)) {
    if (!TEST_FILE_PATTERN.test(file)) {
      errors.push(`Invalid test filename in classifications: ${file}.`);
    }
    if (!VALID_CLASSIFICATIONS.has(classification)) {
      errors.push(
        `Invalid classification for ${file}: ${JSON.stringify(classification)}. ` +
        `Expected one of ${[...VALID_CLASSIFICATIONS].join(", ")}.`
      );
    }
  }

  for (const suiteName of REQUIRED_SUITES) {
    if (!Array.isArray(suites[suiteName])) {
      errors.push(`Required suite ${suiteName} must be an array.`);
    }
  }

  for (const suiteName of Object.keys(suites)) {
    if (!REQUIRED_SUITES.includes(suiteName)) {
      errors.push(`Unknown suite name: ${suiteName}.`);
    }
  }

  const suiteMembership = new Map(classifiedTests.map(file => [file, []]));
  for (const [suiteName, files] of Object.entries(suites)) {
    if (!Array.isArray(files)) continue;

    const duplicates = duplicateValues(files);
    if (duplicates.length > 0) {
      errors.push(`Suite ${suiteName} contains duplicate entries: ${duplicates.join(", ")}.`);
    }

    for (const file of files) {
      if (typeof file !== "string" || !TEST_FILE_PATTERN.test(file)) {
        errors.push(`Suite ${suiteName} contains an invalid test filename: ${JSON.stringify(file)}.`);
        continue;
      }
      if (!classifiedSet.has(file)) {
        errors.push(`Suite ${suiteName} references an unclassified or missing test: ${file}.`);
        continue;
      }
      suiteMembership.get(file).push(suiteName);
    }
  }

  for (const [file, membership] of suiteMembership) {
    if (membership.length === 0) {
      errors.push(`Classified test is not assigned to any suite: ${file}.`);
    }
    if (classifications[file] === "fast" && !membership.includes("fast")) {
      errors.push(`Fast test must be included in the fast suite: ${file}.`);
    }
    if (classifications[file] !== "fast" && membership.includes("fast")) {
      errors.push(`Live test must not be included in the fast suite: ${file}.`);
    }
    if (membership.includes("manual") && membership.length > 1) {
      errors.push(`Manual test must not also belong to an automated suite: ${file}.`);
    }
  }

  const comprehensiveTests = new Set(Array.isArray(suites.comprehensive) ? suites.comprehensive : []);
  const missingFocusedCoverage = focusedCoverageFiles.filter(file => !comprehensiveTests.has(file));
  if (missingFocusedCoverage.length > 0) {
    errors.push(
      "Comprehensive coverage credits tests that are not in the comprehensive suite: " +
      `${missingFocusedCoverage.join(", ")}.`
    );
  }

  const releaseRequired = manifest.releaseRequired;
  if (!Array.isArray(releaseRequired)) {
    errors.push("Manifest releaseRequired must be an array.");
  } else {
    const duplicates = duplicateValues(releaseRequired);
    if (duplicates.length > 0) {
      errors.push(`releaseRequired contains duplicate entries: ${duplicates.join(", ")}.`);
    }
    const e2eTests = new Set(Array.isArray(suites.e2e) ? suites.e2e : []);
    for (const file of releaseRequired) {
      if (!classifiedSet.has(file)) {
        errors.push(`releaseRequired references an unclassified or missing test: ${file}.`);
      } else if (!e2eTests.has(file)) {
        errors.push(`Release-required test must be included in the e2e suite: ${file}.`);
      }
    }
  }

  return errors;
}

export function loadAndValidateTestSuites(rootDirectory) {
  const manifestPath = path.join(rootDirectory, "tests", "test-suites.json");
  const testsDirectory = path.join(rootDirectory, "tests");
  const comprehensivePath = path.join(rootDirectory, "test-comprehensive.mjs");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const discoveredTests = discoverTestFiles(testsDirectory);
  const focusedCoverageFiles = extractFocusedCoverageFiles(
    fs.readFileSync(comprehensivePath, "utf8")
  );
  const errors = validateTestSuiteManifest(manifest, {
    discoveredTests,
    focusedCoverageFiles,
  });

  return {
    manifest,
    manifestPath,
    discoveredTests,
    focusedCoverageFiles,
    errors,
  };
}
