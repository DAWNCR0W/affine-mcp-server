import MarkdownIt from "markdown-it";
import type { TextDelta } from "../markdown/types.js";
import { text } from "./mcp.js";

export const WRITE_RESPONSE_TOOLS = [
  "update_block", "delete_block", "append_block", "append_markdown", "move_block", "update_database_row",
] as const;
export type WriteResponseMode = "full" | "after" | "minimal";

/** Shape only successful receipts. Errors and partial-write recovery details stay intact. */
export function writeResponse(name: string, mode: WriteResponseMode | undefined, result: any) {
  if (mode === undefined || mode === "full" || result?.isError) return result;
  const payload = result?.structuredContent;
  if (!payload || payload.ok === false || payload.success === false ||
    ["partial", "failed", "not_applied"].includes(payload.status)) return result;
  if (mode === "minimal") {
    const ids = name === "delete_block" ? { deletedIds: payload.deletedIds }
      : name === "append_markdown" ? { blockIds: payload.blockIds }
      : { blockId: payload.blockId ?? payload.rowBlockId };
    return { ...result, ...text({ ok: true, ...ids, ...(payload.revision !== undefined ? { revision: payload.revision } : {}) }) };
  }
  const after = { ...payload };
  for (const key of ["previous", "deletedBlock", "deletedBlocks", "fromParentId", "fromIndex"]) delete after[key];
  return { ...result, ...text(after) };
}

export type ReadOptions = {
  view?: "full" | "compact" | "outline";
  includePlainText?: boolean;
  section?: string;
  tail?: number;
  afterBlockId?: string;
  limit?: number;
};
export type ReadBlock = {
  id: string; flavour: string | null; type: string | null; parentId: string | null;
  text: string | null; deltas: TextDelta[]; checked: boolean | null;
};

export function headingLevel(block: Pick<ReadBlock, "flavour" | "type">): number | null {
  return block.flavour === "affine:paragraph" && /^h[1-6]$/.test(block.type ?? "")
    ? Number(block.type![1]) : null;
}

export function validateReadSelection(options: ReadOptions & { blockIds?: string[]; includeMarkdown?: boolean }) {
  if (options.blockIds !== undefined && options.includeMarkdown) {
    throw new Error("includeMarkdown cannot be used with targeted blockIds.");
  }
  const selections = [options.blockIds, options.section, options.tail, options.afterBlockId]
    .filter(value => value !== undefined).length;
  if (selections > 1) throw new Error("Use only one of blockIds, section, tail, or afterBlockId.");
  if (options.limit !== undefined && [options.blockIds, options.section, options.tail].some(value => value !== undefined)) {
    throw new Error("limit can be used alone or with afterBlockId.");
  }
  if (options.includeMarkdown && (selections > 0 || options.limit !== undefined)) {
    throw new Error("includeMarkdown cannot be used with a block selection.");
  }
}

export function selectReadBlocks<T extends ReadBlock>(blocks: T[], options: ReadOptions): T[] {
  const content = blocks.filter(block => !["affine:page", "affine:surface", "affine:note"].includes(block.flavour ?? ""));
  if (options.section !== undefined) {
    const start = content.findIndex(block => block.id === options.section);
    const level = start < 0 ? null : headingLevel(content[start]);
    if (level === null) throw new Error(`Section heading '${options.section}' not found.`);
    const end = content.findIndex((block, index) => index > start && (headingLevel(block) ?? 7) <= level);
    return content.slice(start, end < 0 ? undefined : end);
  }
  if (options.tail !== undefined) {
    const byId = new Map(blocks.map(block => [block.id, block]));
    const roots = content.filter(block => block.parentId === null ||
      !byId.has(block.parentId) || byId.get(block.parentId)?.flavour === "affine:note");
    const selected = new Set(roots.slice(-options.tail).map(block => block.id));
    return content.filter(block => {
      const seen = new Set<string>();
      let current: T | undefined = block;
      while (current && !seen.has(current.id)) {
        if (selected.has(current.id)) return true;
        seen.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return false;
    });
  }
  if (options.afterBlockId !== undefined || options.limit !== undefined) {
    const anchor = options.afterBlockId === undefined ? -1 : content.findIndex(block => block.id === options.afterBlockId);
    if (options.afterBlockId !== undefined && anchor < 0) throw new Error(`Block '${options.afterBlockId}' not found in document content.`);
    return content.slice(anchor + 1, options.limit === undefined ? undefined : anchor + 1 + options.limit);
  }
  return blocks;
}

export function readBlockView(block: ReadBlock, view: ReadOptions["view"]) {
  if (view === undefined || view === "full") return block;
  return {
    id: block.id, flavour: block.flavour, type: block.type, parentId: block.parentId,
    text: view === "outline" && headingLevel(block) === null && block.text !== null
      ? Array.from(block.text).slice(0, 80).join("") : block.text,
    ...(typeof block.checked === "boolean" ? { checked: block.checked } : {}),
    ...(view === "compact" && block.deltas.some(delta => Object.keys(delta.attributes ?? {}).length > 0)
      ? { deltas: block.deltas } : {}),
  };
}

export type MarkdownReadOptions = { tailSections?: number; fromHeading?: string; maxChars?: number };
const markdownParser = new MarkdownIt();
export const TRUNCATION_MARKER = "\n\n[... truncated ...]";

/** Parse Markdown headings so fenced code and Setext headings are handled correctly. */
export function selectMarkdown(markdown: string, options: MarkdownReadOptions) {
  if (options.tailSections !== undefined && options.fromHeading !== undefined) {
    throw new Error("Use only one of tailSections or fromHeading.");
  }
  let selected = markdown;
  if (options.tailSections !== undefined || options.fromHeading !== undefined) {
    const tokens = markdownParser.parse(markdown, {});
    const headings = tokens.flatMap((token, index) => token.type === "heading_open" && token.map ? [{
      level: Number(token.tag.slice(1)), line: token.map[0],
      title: (tokens[index + 1]?.children ?? []).map(child => child.type === "softbreak" ? " " : child.content).join(""),
    }] : []);
    let line: number | undefined;
    if (options.fromHeading !== undefined) {
      line = headings.find(heading => heading.title === options.fromHeading)?.line;
      if (line === undefined) throw new Error(`Heading '${options.fromHeading}' not found.`);
    } else if (headings.length) {
      const shallowest = Math.min(...headings.map(heading => heading.level));
      line = headings.filter(heading => heading.level === shallowest).slice(-options.tailSections!)[0].line;
    }
    if (line !== undefined) selected = markdown.split("\n").slice(line).join("\n");
  }
  if (options.maxChars === undefined) return { markdown: selected };
  const chars = Array.from(selected);
  const truncated = chars.length > options.maxChars;
  const marker = options.maxChars >= Array.from(TRUNCATION_MARKER).length ? TRUNCATION_MARKER : "…";
  return {
    markdown: truncated ? chars.slice(0, options.maxChars - Array.from(marker).length).join("") + marker : selected,
    truncated,
  };
}

export type DatabaseWhere = { column: string; op: "eq" | "ne" | "in" | "lt" | "lte" | "gt" | "gte" | "contains" | "empty"; value?: unknown };
export type DatabaseSort = { column: string; dir: "asc" | "desc" };

export function displayCell(cell: Record<string, unknown> | undefined, rawValue?: unknown): unknown {
  if (!cell) return null;
  // The legacy decoder coerces null numeric/date cells to zero. Preserve its
  // full response bytes, but use the actual empty value for opt-in queries.
  if (rawValue === null || ((cell.type === "date" || cell.type === "number") && rawValue === "")) return null;
  if (cell.type === "date" || cell.type === "created-time") {
    const date = typeof cell.value === "number" ? new Date(cell.value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return cell.value ?? null;
}

export function hasReferences(deltas: unknown): deltas is TextDelta[] {
  return Array.isArray(deltas) && deltas.some(delta => delta?.attributes?.reference);
}

/** ISO day inputs compare at day precision; timestamps compare as instants in UTC. */
export function compareValue(value: unknown, operand: unknown, isDate: boolean): unknown {
  if (!isDate || value === null || operand === null) return value;
  if (typeof operand !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(operand) ||
    !Number.isFinite(Date.parse(operand)) || new Date(operand.slice(0, 10)).toISOString().slice(0, 10) !== operand.slice(0, 10)) {
    throw new Error("Date filters require a valid ISO date or timestamp.");
  }
  return operand.length === 10 ? String(value).slice(0, 10) : Date.parse(String(value));
}

export function matchesDatabaseFilter(value: unknown, filter: DatabaseWhere, isDate: boolean): boolean {
  const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  if (filter.op === "empty") return empty;
  const eq = (operand: unknown) => {
    const left = compareValue(value, operand, isDate);
    const right = isDate ? compareValue(operand, operand, true) : operand;
    return Array.isArray(left) ? left.includes(right) : left === right;
  };
  if (filter.op === "eq") return eq(filter.value);
  if (filter.op === "ne") return !eq(filter.value);
  if (filter.op === "in") return (filter.value as unknown[]).some(eq);
  if (empty) return false;
  if (filter.op === "contains") return Array.isArray(value)
    ? value.includes(filter.value) : typeof value === "string" && value.includes(String(filter.value));
  const left = compareValue(value, filter.value, isDate);
  const right = isDate ? compareValue(filter.value, filter.value, true) : filter.value;
  if (!((typeof left === "string" && typeof right === "string") || (typeof left === "number" && typeof right === "number"))) return false;
  switch (filter.op) {
    case "lt": return left < right;
    case "lte": return left <= right;
    case "gt": return left > right;
    case "gte": return left >= right;
  }
}
