import * as Y from "yjs";

import type { TextDelta, TextDeltaAttributes } from "./types.js";

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
