import { generateKeyBetween } from "fractional-indexing";

/** Accept native base-62 layer keys, including long legacy fractional suffixes. */
export function isValidSurfaceIndex(index: string): boolean {
  if (!/^[A-Za-z][0-9A-Za-z]+$/.test(index)) return false;
  try {
    // The allocator validates head length, integer length and fractional zeros.
    // Check the alphabet separately: its lookup table assumes valid digits.
    generateKeyBetween(index, null);
    return true;
  } catch {
    return false;
  }
}

/** One element of a batch; `key` is a caller-chosen local name later connectors may reference. */
export type BatchItem = { key?: string; type?: string; sourceId?: string; targetId?: string; [field: string]: unknown };

/**
 * Adds items in order, resolving local keys used as connector `sourceId`/`targetId`.
 * Pre: keys are non-blank and unique; a connector may only reference keys of earlier items.
 * Post: results are in input order; any other id is passed through as an existing element id.
 */
export function addBatch<R extends { elementId: string }>(
  items: BatchItem[],
  addOne: (item: BatchItem) => R,
): Array<R & { key?: string }> {
  const position = new Map<string, number>();
  items.forEach(({ key }, index) => {
    if (key === undefined) return;
    if (!key.trim()) throw new Error(`Batch item ${index}: key must not be blank`);
    if (position.has(key)) throw new Error(`Batch item ${index}: duplicate key "${key}"`);
    position.set(key, index);
  });
  const endpoints = (item: BatchItem) => (["sourceId", "targetId"] as const).filter(field => item.type === "connector" && typeof item[field] === "string");
  items.forEach((item, index) => endpoints(item).forEach(field => {
    if ((position.get(item[field]!) ?? -1) >= index) throw new Error(`Batch item ${index}: ${field} "${item[field]}" must reference an earlier item`);
  }));
  const ids = new Map<string, string>();
  return items.map(({ key, ...item }) => {
    for (const field of endpoints(item)) item[field] = ids.get(item[field]!) ?? item[field];
    const result = addOne(item);
    if (key !== undefined) ids.set(key, result.elementId);
    return key === undefined ? result : { ...result, key };
  });
}

const COMPACT_FIELDS = ["id", "type", "index", "xywh", "bounds", "labelXYWH", "text", "source", "target", "children", "title", "style", "layoutType"];

/** Keeps only the fields needed to locate and link an element; drops style data. */
export function compactSurfaceElement(element: Record<string, any>): Record<string, any> {
  return Object.fromEntries(COMPACT_FIELDS.filter(field => element[field] !== undefined).map(field => [field, element[field]]));
}
