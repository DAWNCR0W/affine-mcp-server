/**
 * Pure utility functions for AFFiNE table block handling.
 *
 * Extracted so that both the production tool code (src/tools/docs.ts)
 * and the regression tests (tests/test-table-format.mjs) share the
 * same implementation.
 */
import * as Y from "yjs";

export function makeText(content: string): Y.Text {
  const yText = new Y.Text();
  if (content.length > 0) {
    yText.insert(0, content);
  }
  return yText;
}

export function richTextValueToString(value: unknown): string {
  if (value instanceof Y.Text) {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry && typeof entry === "object" && typeof (entry as any).insert === "string") {
          return (entry as any).insert as string;
        }
        return "";
      })
      .join("");
  }
  if (value && typeof value === "object" && typeof (value as any).insert === "string") {
    return (value as any).insert as string;
  }
  return "";
}

export function mapEntries(value: unknown): Array<[string, any]> {
  if (value instanceof Y.Map) {
    const entries: Array<[string, any]> = [];
    value.forEach((mapValue: unknown, key: string) => {
      entries.push([key, mapValue]);
    });
    return entries;
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, any>);
  }
  return [];
}

/**
 * Extract a 2D string table from an AFFiNE table block.
 *
 * Reads the flat-key format first (prop:rows.{id}.order, etc.) and
 * then merges any legacy nested properties (prop:rows as a single
 * object).  Flat-key values take precedence when both formats are
 * present for the same ID.
 */
export function extractTableData(block: Y.Map<any>): string[][] | null {
  const rowMap = new Map<string, string>(); // rowId → order
  const colMap = new Map<string, string>(); // columnId → order
  const cells = new Map<string, string>();  // "rowId:columnId" → text

  // Note: generateId() only produces [A-Za-z0-9_-], so dots and colons
  // in the flat-key delimiter positions are unambiguous.
  for (const key of block.keys()) {
    // Flat key format: prop:rows.{rowId}.order
    const rowMatch = key.match(/^prop:rows\.([^.]+)\.order$/);
    if (rowMatch) {
      const rowId = rowMatch[1];
      const order = block.get(key);
      rowMap.set(rowId, typeof order === "string" ? order : String(order ?? rowId));
      continue;
    }
    // Flat key format: prop:columns.{colId}.order
    const colMatch = key.match(/^prop:columns\.([^.]+)\.order$/);
    if (colMatch) {
      const colId = colMatch[1];
      const order = block.get(key);
      colMap.set(colId, typeof order === "string" ? order : String(order ?? colId));
      continue;
    }
    // Flat key format: prop:cells.{rowId}:{colId}.text
    const cellMatch = key.match(/^prop:cells\.([^.]+)\.text$/);
    if (cellMatch) {
      const cellKey = cellMatch[1]; // "rowId:colId"
      const textVal = block.get(key);
      cells.set(cellKey, richTextValueToString(textVal));
      continue;
    }
  }

  // Merge legacy nested format (prop:rows, prop:columns, prop:cells as objects)
  // so that mixed old/new table structures are handled safely.
  {
    const rowsValue = block.get("prop:rows");
    for (const [rowId, payload] of mapEntries(rowsValue)) {
      if (rowMap.has(rowId)) continue; // flat-key takes precedence
      const order = payload && typeof payload === "object" && typeof (payload as any).order === "string"
        ? (payload as any).order : rowId;
      rowMap.set(rowId, order);
    }
  }
  {
    const columnsValue = block.get("prop:columns");
    for (const [colId, payload] of mapEntries(columnsValue)) {
      if (colMap.has(colId)) continue; // flat-key takes precedence
      const order = payload && typeof payload === "object" && typeof (payload as any).order === "string"
        ? (payload as any).order : colId;
      colMap.set(colId, order);
    }
  }
  {
    const cellsValue = block.get("prop:cells");
    for (const [cellKey, payload] of mapEntries(cellsValue)) {
      if (cells.has(cellKey)) continue; // flat-key takes precedence
      if (payload instanceof Y.Map) {
        cells.set(cellKey, richTextValueToString(payload.get("text")));
        continue;
      }
      if (payload && typeof payload === "object" && "text" in payload) {
        cells.set(cellKey, richTextValueToString((payload as any).text));
      }
    }
  }

  const rowEntries = [...rowMap.entries()]
    .map(([rowId, order]) => ({ rowId, order }))
    .sort((a, b) => a.order.localeCompare(b.order));

  const columnEntries = [...colMap.entries()]
    .map(([columnId, order]) => ({ columnId, order }))
    .sort((a, b) => a.order.localeCompare(b.order));

  if (rowEntries.length === 0 || columnEntries.length === 0) {
    return null;
  }

  const tableData: string[][] = [];
  for (const { rowId } of rowEntries) {
    const row: string[] = [];
    for (const { columnId } of columnEntries) {
      row.push(cells.get(`${rowId}:${columnId}`) ?? "");
    }
    tableData.push(row);
  }

  return tableData;
}
