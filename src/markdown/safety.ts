const UNSAFE_LINK_SCHEMES = new Set(["data", "file", "javascript", "vbscript"]);
const ENTITY_LIKE_AMPERSAND = /&(?=(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi;
const ENTITY_AFTER_AMPERSAND = /^(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i;
const INLINE_MARKDOWN_SYNTAX = new Set(["\\", "`", "*", "_", "[", "]", "<", "~"]);

export type MarkdownFrontmatterInput = {
  docId: string;
  title: string;
  tags: string[];
  lossy: boolean;
  fidelityRisk?: string;
};

export function quoteYamlString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function buildMarkdownFrontmatter(input: MarkdownFrontmatterInput): string {
  return [
    "---",
    `docId: ${quoteYamlString(input.docId)}`,
    `title: ${quoteYamlString(input.title)}`,
    ...(input.tags.length > 0
      ? ["tags:", ...input.tags.map(tag => `  - ${quoteYamlString(tag)}`)]
      : ["tags: []"]),
    `lossy: ${input.lossy ? "true" : "false"}`,
    ...(input.fidelityRisk === undefined
      ? []
      : [`fidelityRisk: ${quoteYamlString(input.fidelityRisk)}`]),
    "---",
  ].join("\n");
}

function longestCharacterRun(value: string, character: "`" | "~"): number {
  let longest = 0;
  let current = 0;
  for (const candidate of value) {
    if (candidate === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function sanitizeFenceInfo(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .trim();
}

export function renderFencedCodeBlock(text: string, language: string | null | undefined): string[] {
  const info = sanitizeFenceInfo(language ?? "");
  const backtickLength = Math.max(3, longestCharacterRun(text, "`") + 1);
  const tildeLength = Math.max(3, longestCharacterRun(text, "~") + 1);
  const canUseBackticks = !info.includes("`");
  const useBackticks = canUseBackticks && backtickLength <= tildeLength;
  const fence = (useBackticks ? "`" : "~").repeat(useBackticks ? backtickLength : tildeLength);
  return [`${fence}${info ? ` ${info}` : ""}`, text, fence];
}

function decodeSchemeCharacterReferences(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/&#([0-9]+);?/g, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/&colon;/gi, ":")
    .replace(/&(tab|newline);/gi, match => match.toLowerCase() === "&tab;" ? "\t" : "\n");
}

export function hasUnsafeMarkdownLinkScheme(destination: string): boolean {
  const normalized = decodeSchemeCharacterReferences(destination)
    .replace(/[\u0000-\u0020\u007f-\u009f\u2028\u2029]+/g, "")
    .toLowerCase();
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/)?.[1];
  return scheme !== undefined && UNSAFE_LINK_SCHEMES.has(scheme);
}

function escapeMarkdownCharacter(character: string): string {
  const codePoint = character.codePointAt(0) as number;
  const isStructuralWhitespace =
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029;
  if (isStructuralWhitespace) {
    return `&#${codePoint};`;
  }
  return INLINE_MARKDOWN_SYNTAX.has(character) ? `\\${character}` : character;
}

/** Escape untrusted text while leaving generated Markdown structure untouched. */
export function escapeMarkdownPlainText(value: string): string {
  let offset = 0;
  return Array.from(value, character => {
    const currentOffset = offset;
    offset += character.length;
    return character === "&" && ENTITY_AFTER_AMPERSAND.test(value.slice(currentOffset + 1))
      ? "\\&"
      : escapeMarkdownCharacter(character);
  })
    .join("")
    .replace(/(\\<[^<>]*?)>/g, "$1\\>")
    .replace(/(\\\])\(/g, "$1\\(")
    .replace(/(\\\]\\\([a-z][a-z0-9+.-]*):/gi, "$1\\:")
    .replace(/^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/, "$1\\$2")
    .replace(/^([ \t]{0,3})(>)/, "$1\\$2")
    .replace(/^([ \t]{0,3})([-+])(?=[ \t]|$)/, "$1\\$2")
    .replace(/^([ \t]{0,3})(\d{1,9})([.)])(?=[ \t]|$)/, "$1$2\\$3")
    .replace(/^([ \t]{0,3})-(?=(?:[ \t]*-){2,}[ \t]*$)/, "$1\\-");
}

export function escapeMarkdownLinkLabel(value: string): string {
  return escapeMarkdownPlainText(value);
}

export function escapeMarkdownTableCell(value: string): string {
  return escapeMarkdownPlainText(value).replace(/\|/g, "\\|");
}

export function escapeMarkdownLinkDestination(value: string): string {
  const escapedEntities = value
    .replace(ENTITY_LIKE_AMPERSAND, "&amp;")
    .replace(/\|/g, "%7C");
  if (/^[^\s<>()\\\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/.test(escapedEntities)) {
    return escapedEntities;
  }

  const escaped = escapedEntities
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, character => encodeURIComponent(character))
    .replace(/\u2028|\u2029/g, character => encodeURIComponent(character))
    .replace(/\\/g, "\\\\")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>");
  return `<${escaped}>`;
}

export function renderMarkdownLinkWithSafeLabel(labelMarkdown: string, destination: string): string | null {
  if (hasUnsafeMarkdownLinkScheme(destination)) {
    return null;
  }
  return `[${labelMarkdown}](${escapeMarkdownLinkDestination(destination)})`;
}

export function renderMarkdownLink(label: string, destination: string): string | null {
  return renderMarkdownLinkWithSafeLabel(escapeMarkdownLinkLabel(label), destination);
}

export function renderMarkdownImage(alt: string, destination: string): string | null {
  const link = renderMarkdownLink(alt, destination);
  return link === null ? null : `!${link}`;
}

export function escapeMarkdownHtmlCommentValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/-/g, "&#45;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n\u2028\u2029]/g, " ");
}
