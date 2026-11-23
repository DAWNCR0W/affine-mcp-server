import type * as Y from "yjs";
import { isInlineEmbedDelta, normalizeLinkedPageReferenceDeltas } from "../markdown/richText.js";
import type { TextDelta } from "../markdown/types.js";

export type BlockTextEdit = { old_str: string; new_str: string | TextDelta[] };

export function applyBlockTextEdit(text: Y.Text, edit: BlockTextEdit, index: number): boolean {
  const runs = text.toDelta() as Array<{ insert: string | object; attributes?: TextDelta["attributes"] }>;
  // Keep native Yjs embeds at their one-unit position even though toString omits them.
  const plain = runs.map(run => typeof run.insert === "string" ? run.insert : "\uFFFC").join("");
  const start = plain.indexOf(edit.old_str);
  const errorPrefix = `Edit ${index + 1}: old_str`;
  if (start < 0 || plain.indexOf(edit.old_str, start + 1) >= 0) {
    throw new Error(`${errorPrefix} must match exactly once in the block text.`);
  }
  const end = start + edit.old_str.length;
  if (splitsSurrogate(plain, start) || splitsSurrogate(plain, end)) {
    throw new Error(`${errorPrefix} cuts through a Unicode character.`);
  }

  let firstAttributes: TextDelta["attributes"];
  let offset = 0;
  for (const run of runs) {
    const next = offset + (typeof run.insert === "string" ? run.insert.length : 1);
    if (offset >= end) break;
    if (next > start) {
      if (typeof run.insert !== "string") {
        throw new Error(`${errorPrefix} overlaps an embedded object.`);
      }
      if (offset <= start) firstAttributes = run.attributes;
      if (isInlineEmbedDelta({ insert: run.insert, attributes: run.attributes }) &&
          (offset < start || next > end)) {
        throw new Error(`${errorPrefix} cuts through a LinkedPage reference or inline math run.`);
      }
    }
    offset = next;
  }

  if (typeof edit.new_str === "string" && edit.old_str === edit.new_str) return false;
  if (typeof edit.new_str === "string" && edit.new_str &&
      isInlineEmbedDelta({ insert: "", attributes: firstAttributes })) {
    throw new Error(`Edit ${index + 1}: a plain replacement cannot inherit LinkedPage or inline math attributes. Use a delta array.`);
  }
  const replacement = typeof edit.new_str === "string"
    ? [{ insert: edit.new_str, attributes: firstAttributes }]
    : normalizeLinkedPageReferenceDeltas(edit.new_str);

  text.delete(start, end - start);
  let cursor = start;
  for (const { insert, attributes } of replacement) {
    if (!insert) continue;
    text.insert(cursor, insert, attributes ?? {});
    cursor += insert.length;
  }
  return true;
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
