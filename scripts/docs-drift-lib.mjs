import path from "node:path";

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function duplicateValues(values) {
  return sortedUnique(values.filter((value, index) => values.indexOf(value) !== index));
}

export function extractCodeValuesFromTables(markdown, firstColumnHeader) {
  const lines = markdown.split(/\r?\n/);
  const values = [];
  const escapedHeader = firstColumnHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\|\\s*${escapedHeader}\\s*\\|`, "i");

  for (let index = 0; index < lines.length; index += 1) {
    if (!headerPattern.test(lines[index].trim())) continue;

    index += 2;
    while (index < lines.length && /^\s*\|/.test(lines[index])) {
      const match = lines[index].match(/^\s*\|\s*`([^`]+)`\s*\|/);
      if (match) values.push(match[1]);
      index += 1;
    }
    index -= 1;
  }

  return values;
}

export function extractDocumentedTools(markdown) {
  return extractCodeValuesFromTables(markdown, "Tool");
}

export function extractDocumentedRuntimeVariables(markdown) {
  return extractCodeValuesFromTables(markdown, "Variable")
    .filter(value => /^[A-Z][A-Z0-9_]+$/.test(value));
}

export function extractRuntimeConfigVariables(sourceTexts) {
  const variables = [];
  const accessPatterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
    /\benv\.([A-Z][A-Z0-9_]+)/g,
    /\benv\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
    /\benv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  ];
  for (const source of sourceTexts) {
    for (const pattern of accessPatterns) {
      for (const match of source.matchAll(pattern)) {
        variables.push(match[1]);
      }
    }
  }
  return sortedUnique(variables);
}

export function extractRelativeMarkdownTargets(markdown) {
  const targets = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    let target = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    target = target.split("#", 1)[0].split("?", 1)[0];
    if (!target) continue;
    targets.push(path.posix.normalize(target.replace(/^\.\//, "")));
  }
  return sortedUnique(targets);
}

export function isPackagePathIncluded(target, packageFiles) {
  const normalizedTarget = path.posix.normalize(target.replace(/^\.\//, ""));
  const basename = path.posix.basename(normalizedTarget).toLowerCase();
  if (
    basename === "package.json" ||
    /^readme(?:\.|$)/.test(basename) ||
    /^licen[cs]e(?:\.|$)/.test(basename)
  ) {
    return true;
  }
  if (!Array.isArray(packageFiles)) return true;

  return packageFiles.some(entry => {
    if (typeof entry !== "string") return false;
    const normalizedEntry = path.posix.normalize(entry.replace(/^\.\//, "")).replace(/\/$/, "");
    return normalizedTarget === normalizedEntry || normalizedTarget.startsWith(`${normalizedEntry}/`);
  });
}

export function validateDocumentation({
  manifestTools,
  documentedTools,
  runtimeConfigVariables,
  documentedRuntimeVariables,
  readmeTargets,
  packageFiles,
  existingPaths,
}) {
  const errors = [];
  const manifestSet = new Set(manifestTools);
  const documentedToolSet = new Set(documentedTools);
  const runtimeVariableSet = new Set(runtimeConfigVariables);
  const documentedVariableSet = new Set(documentedRuntimeVariables);

  const missingTools = sortedUnique(manifestTools.filter(tool => !documentedToolSet.has(tool)));
  if (missingTools.length > 0) {
    errors.push(`Manifest tools missing from docs/tool-reference.md: ${missingTools.join(", ")}.`);
  }

  const unknownTools = sortedUnique(documentedTools.filter(tool => !manifestSet.has(tool)));
  if (unknownTools.length > 0) {
    errors.push(`Documented canonical tools missing from tool-manifest.json: ${unknownTools.join(", ")}.`);
  }

  const duplicateTools = duplicateValues(documentedTools);
  if (duplicateTools.length > 0) {
    errors.push(`Duplicate canonical tool rows in docs/tool-reference.md: ${duplicateTools.join(", ")}.`);
  }

  const missingVariables = sortedUnique(
    runtimeConfigVariables.filter(variable => !documentedVariableSet.has(variable))
  );
  if (missingVariables.length > 0) {
    errors.push(
      `Runtime configuration variables missing from configuration tables: ${missingVariables.join(", ")}.`
    );
  }

  const unknownVariables = sortedUnique(
    documentedRuntimeVariables.filter(variable => !runtimeVariableSet.has(variable))
  );
  if (unknownVariables.length > 0) {
    errors.push(
      `Documented configuration variables missing from runtime source: ${unknownVariables.join(", ")}.`
    );
  }

  const duplicateVariables = duplicateValues(documentedRuntimeVariables);
  if (duplicateVariables.length > 0) {
    errors.push(`Duplicate configuration variable rows in configuration docs: ${duplicateVariables.join(", ")}.`);
  }

  for (const target of readmeTargets) {
    if (!existingPaths.has(target)) {
      errors.push(`README.md links to a missing local path: ${target}.`);
      continue;
    }
    if (!isPackagePathIncluded(target, packageFiles)) {
      errors.push(`README.md local link is excluded from the npm package: ${target}.`);
    }
  }

  return errors;
}
