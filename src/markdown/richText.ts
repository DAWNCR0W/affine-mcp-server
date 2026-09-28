import * as Y from "yjs";

import type { TextDelta, TextDeltaAttributes } from "./types.js";

export const AFFINE_LINKED_PAGE_REFERENCE_NODE = " ";

export function isLinkedPageReferenceDelta(delta: TextDelta): boolean {
  const reference = delta.attributes?.reference;
  return !!reference && typeof reference === "object" && !Array.isArray(reference) &&
    (reference as { type?: unknown }).type === "LinkedPage";
}

/**
 * AFFiNE stores each LinkedPage reference as one ASCII space. Yjs can coalesce
 * adjacent references with identical attributes into multiple spaces, so keep
 * those intact. Earlier server versions emitted zero-width spaces; normalize
 * only that exact legacy form and reject visible labels that AFFiNE cannot
 * render as a reference node.
 */
export function normalizeLinkedPageReferenceDeltas(deltas: TextDelta[]): TextDelta[] {
  return deltas.map(delta => {
    const reference = delta.attributes?.reference;
    if (
      !reference ||
      typeof reference !== "object" ||
      Array.isArray(reference) ||
      (reference as { type?: unknown }).type !== "LinkedPage"
    ) {
      return delta;
    }

    const pageId = (reference as { pageId?: unknown }).pageId;
    if (typeof pageId !== "string" || pageId.trim().length === 0) {
      throw new Error(
        'LinkedPage reference deltas require a non-empty string pageId in attributes.reference; use linkedDocId for database row links.',
      );
    }

    if (/^ +$/.test(delta.insert)) {
      return delta;
    }
    if (/^\u200B+$/.test(delta.insert)) {
      return { ...delta, insert: " ".repeat(delta.insert.length) };
    }

    throw new Error(
      'LinkedPage reference deltas must use AFFiNE\'s native reference sentinel (insert: " "); the page label is resolved from pageId.',
    );
  });
}

function normalizeAttributes(value: unknown): TextDeltaAttributes | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as Record<string, unknown>) };
}

function normalizeDelta(value: unknown): TextDelta | null {
  if (typeof value === "string") {
    return { insert: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const insert = (value as { insert?: unknown }).insert;
  if (typeof insert !== "string") {
    return null;
  }
  const attributes = normalizeAttributes((value as { attributes?: unknown }).attributes);
  return attributes ? { insert, attributes } : { insert };
}

export function richTextValueToDeltas(value: unknown): TextDelta[] | null {
  if (value instanceof Y.Text) {
    return value
      .toDelta()
      .map((delta: unknown) => normalizeDelta(delta))
      .filter((delta: TextDelta | null): delta is TextDelta => delta !== null);
  }
  if (typeof value === "string") {
    return [{ insert: value }];
  }
  if (Array.isArray(value)) {
    return value.map(normalizeDelta).filter((delta): delta is TextDelta => delta !== null);
  }
  const delta = normalizeDelta(value);
  return delta ? [delta] : null;
}

export function richTextValueToString(value: unknown): string {
  const deltas = richTextValueToDeltas(value);
  return deltas?.map(delta => delta.insert).join("") ?? "";
}
