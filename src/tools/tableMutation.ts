import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";
import { z } from "zod/v3";
import type { TextDelta } from "../markdown/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const MAX_TABLE_ROWS = 1000;
export const MAX_TABLE_COLUMNS = 100;
export const MAX_TABLE_CELLS = 5000;

type Block = Y.Map<unknown>;
type Axis = "row" | "column";
type Entry = { id: string; order: string };
type Target = { workspaceId?: string; docId: string; blockId: string };
type MutationResult = { index: number; rowId?: string; columnId?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function field(value: unknown, key: string): unknown {
  return value instanceof Y.Map ? value.get(key) : record(value)?.[key];
}

function orderedEntries(entries: Array<[string, unknown]>): Entry[] {
  return entries.map(([id, rawOrder]) => ({ id, order: typeof rawOrder === "string" ? rawOrder : id }))
    .sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
}

function nestedAxis(block: Block, axis: Axis) {
  const prop = `prop:${axis}s`;
  const container = block.get(prop);
  const values = container instanceof Y.Map ? [...container.entries()] : Object.entries(record(container) ?? {});
  const entries = orderedEntries(values.map(([id, entry]) => [id, field(entry, "order")]));
  return {
    entries,
    write(id: string, properties: Record<string, unknown>) {
      if (container instanceof Y.Map) {
        const current = container.get(id);
        if (current instanceof Y.Map) {
          for (const [key, value] of Object.entries(properties)) current.set(key, value);
        } else if (record(current)) {
          container.set(id, { ...record(current), ...properties });
        } else {
          container.set(id, new Y.Map(Object.entries(properties)));
        }
      } else {
        const current = record(block.get(prop)) ?? {};
        block.set(prop, { ...current, [id]: { ...record(current[id]), ...properties } });
      }
    },
    remove(id: string) {
      if (container instanceof Y.Map) {
        container.delete(id);
      } else {
        const current = { ...record(block.get(prop)) };
        delete current[id];
        block.set(prop, current);
      }
    },
  };
}

function flatAxis(block: Block, axis: Axis) {
  const prefix = `prop:${axis}s.`;
  const entries = orderedEntries([...block.entries()].flatMap(([key, value]) => {
    if (!key.startsWith(prefix) || !key.endsWith(".order")) return [];
    const id = key.slice(prefix.length, -".order".length);
    return id && !id.includes(".") ? [[id, value]] : [];
  }));
  return {
    entries,
    write(id: string, properties: Record<string, unknown>) {
      for (const [key, value] of Object.entries(properties)) block.set(`${prefix}${id}.${key}`, value);
    },
    remove(id: string) {
      for (const key of [...block.keys()]) if (key.startsWith(`${prefix}${id}.`)) block.delete(key);
    },
  };
}

function tableLayout(block: Block) {
  const nestedRows = nestedAxis(block, "row");
  const nestedColumns = nestedAxis(block, "column");
  const nested = nestedRows.entries.length > 0 && nestedColumns.entries.length > 0;
  const row = nested ? nestedRows : flatAxis(block, "row");
  const column = nested ? nestedColumns : flatAxis(block, "column");
  if (!row.entries.length || !column.entries.length) {
    throw new Error("Table has no readable row/column layout.");
  }
  return {
    row,
    column,
    insertCell(key: string, text: Y.Text) {
      if (!nested) {
        block.set(`prop:cells.${key}.text`, text);
        return;
      }
      const existing = block.get("prop:cells");
      const cells: Y.Map<unknown> = existing instanceof Y.Map ? existing : new Y.Map(Object.entries(record(existing) ?? {}));
      if (cells !== existing) block.set("prop:cells", cells);
      cells.set(key, new Y.Map([["text", text]]));
    },
    deleteCells(axis: Axis, id: string) {
      const matches = (key: string) => axis === "row" ? key.startsWith(`${id}:`) : key.endsWith(`:${id}`);
      if (nested) {
        const cells = block.get("prop:cells");
        if (cells instanceof Y.Map) {
          for (const key of [...cells.keys()]) if (matches(key)) cells.delete(key);
        } else if (record(cells)) {
          block.set("prop:cells", Object.fromEntries(Object.entries(record(cells)!).filter(([key]) => !matches(key))));
        }
      } else {
        for (const key of [...block.keys()]) {
          const cell = /^prop:cells\.([^.]+)\./.exec(key)?.[1];
          if (cell && matches(cell)) block.delete(key);
        }
      }
    },
  };
}

function checkIndex(axis: Axis, index: number, max: number) {
  if (index < 0 || index > max) throw new Error(`Table ${axis} index ${index} is out of range (expected 0-${max}).`);
}

function insertionOrder(entries: Entry[], index: number) {
  try {
    return { order: generateKeyBetween(entries[index - 1]?.order ?? null, entries[index]?.order ?? null) };
  } catch {
    // Older servers used non-fractional order keys. Preserve the visible order
    // and IDs when repairing such a table so its entries stay editable in AFFiNE.
    const keys = generateNKeysBetween(null, null, entries.length + 1);
    const [order] = keys.splice(index, 1);
    return { order, replacementOrders: keys };
  }
}

export function registerTableMutationTools(server: McpServer, deps: {
  docId: z.ZodType<string>;
  delta: z.ZodType<TextDelta>;
  width: z.ZodType<number>;
  generateId: () => string;
  makeCellText: (content: string | TextDelta[], header: boolean) => Y.Text;
  mutate: (target: Target, edit: (block: Block) => MutationResult) => Promise<CallToolResult>;
}) {
  const target = { workspaceId: z.string().optional(), docId: deps.docId, blockId: z.string().min(1) };
  const index = z.number().int().nonnegative().describe("Zero-based index.");
  const insertIndex = index.optional().describe("Zero-based insertion position. Omit to append.");
  const deltas = z.array(deps.delta);
  const richText = z.union([z.string(), deltas]);

  function insert(axis: Axis, args: Target & { index?: number }, initial?: (count: number) => Array<string | TextDelta[]>, width?: number) {
    return deps.mutate(args, block => {
      const table = tableLayout(block);
      const { entries, write } = table[axis];
      const opposite = table[axis === "row" ? "column" : "row"].entries;
      const at = args.index ?? entries.length;
      checkIndex(axis, at, entries.length);
      const contents = initial?.(opposite.length);
      const texts = opposite.map((_, i) => deps.makeCellText(contents?.[i] ?? "", axis === "row" ? at === 0 : i === 0));
      const { order, replacementOrders } = insertionOrder(entries, at);
      const id = deps.generateId();
      if (replacementOrders) entries.forEach((entry, i) => write(entry.id, { order: replacementOrders[i] }));
      const idField = axis === "row" ? "rowId" : "columnId";
      write(id, { [idField]: id, order, ...(width === undefined ? {} : { width }) });
      opposite.forEach(({ id: otherId }, i) => {
        const key = axis === "row" ? `${id}:${otherId}` : `${otherId}:${id}`;
        table.insertCell(key, texts[i]);
      });
      return { [idField]: id, index: at };
    });
  }

  function remove(axis: Axis, args: Target & { index: number }) {
    return deps.mutate(args, block => {
      const table = tableLayout(block);
      const { entries, remove } = table[axis];
      checkIndex(axis, args.index, entries.length - 1);
      if (entries.length === 1) throw new Error(`Cannot delete the final table ${axis}.`);
      const { id } = entries[args.index];
      remove(id);
      table.deleteCells(axis, id);
      return { [axis === "row" ? "rowId" : "columnId"]: id, index: args.index };
    });
  }

  server.registerTool("insert_table_row", {
    title: "Insert Table Row",
    description: "Insert a row into a native AFFiNE table while preserving the block ID and existing cells. The row is appended by default.",
    inputSchema: {
      ...target, index: insertIndex,
      cells: z.array(z.string()).optional().describe("Provide one plain-text cell per column, or omit to create empty cells."),
      cellDeltas: z.array(deltas).optional().describe('Provide one delta array per column instead of cells. For LinkedPage references use insert: " " and a pageId.'),
    },
  }, args => insert("row", args, count => {
    if (args.cells !== undefined && args.cellDeltas !== undefined) throw new Error("Provide cells or cellDeltas, not both.");
    const contents = args.cellDeltas ?? args.cells;
    if (contents && contents.length !== count) throw new Error(`Row content must contain exactly ${count} cells.`);
    return contents ?? [];
  }));

  server.registerTool("delete_table_row", {
    title: "Delete Table Row",
    description: "Delete a row and its cells from a native AFFiNE table. A header-only table is valid. The final row is protected.",
    inputSchema: { ...target, index },
  }, args => remove("row", args));

  server.registerTool("insert_table_column", {
    title: "Insert Table Column",
    description: "Insert a column into a native AFFiNE table while preserving existing cells and widths. The column is appended by default.",
    inputSchema: {
      ...target, index: insertIndex,
      header: richText.optional().describe("Initial first-row cell. All other cells start empty."),
      width: deps.width.optional().describe("Width in pixels. Omit to use automatic sizing."),
    },
  }, args => insert("column", args, () => [args.header ?? ""], args.width));

  server.registerTool("delete_table_column", {
    title: "Delete Table Column",
    description: "Delete a column and its cells from a native AFFiNE table. The final column is protected.",
    inputSchema: { ...target, index },
  }, args => remove("column", args));
}
