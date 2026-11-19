import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Target = { workspaceId?: string; docId: string; databaseBlockId: string };
type Result = { columnId: string } | { viewId: string };
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  if (value && typeof value === "object" && !(value instanceof Y.AbstractType) && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return undefined;
}

function field(value: unknown, key: string): unknown {
  return value instanceof Y.Map ? value.get(key) : record(value)?.[key];
}

function array(value: unknown): unknown[] {
  if (value instanceof Y.Array) return value.toArray();
  return Array.isArray(value) ? value : [];
}

function setField(value: unknown, key: string, next: unknown, replace: (value: JsonRecord) => void) {
  if (value instanceof Y.Map) value.set(key, next);
  else replace({ ...record(value), [key]: next });
}

function replaceAt(list: Y.Array<unknown>, index: number, next: unknown) {
  list.delete(index, 1);
  list.insert(index, [next]);
}

function databaseArray(block: Y.Map<unknown>, name: "columns" | "views"): Y.Array<unknown> {
  const value = block.get(`prop:${name}`);
  if (!(value instanceof Y.Array)) throw new Error(`Database has no ${name} array.`);
  return value;
}

function findIndex(list: Y.Array<unknown>, id: string, kind: string) {
  const index = list.toArray().findIndex(entry => field(entry, "id") === id);
  if (index < 0) throw new Error(`Database ${kind} '${id}' not found.`);
  return index;
}

function references(value: unknown, ids: Set<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (value instanceof Y.Map) return [...value.values()].some(item => references(item, ids));
  if (value instanceof Y.Array || Array.isArray(value)) return array(value).some(item => references(item, ids));
  return Object.values(record(value) ?? {}).some(item => references(item, ids));
}

function ensureNoViewDependency(block: Y.Map<unknown>, ids: Set<string>, kind: "column" | "option") {
  for (const view of databaseArray(block, "views").toArray()) {
    for (const key of ["header", "filter", "sort", "groupBy", "groupProperties", "group", "subGroupBy"]) {
      if (references(field(view, key), ids)) {
        throw new Error(`Cannot remove a ${kind} used by view '${field(view, "id")}' (${key}).`);
      }
    }
  }
}

function rowCells(block: Y.Map<unknown>) {
  const cells = block.get("prop:cells");
  if (!(cells instanceof Y.Map)) throw new Error("Database has no cells map.");
  return cells;
}

function planOptionCleanup(block: Y.Map<unknown>, columnId: string, type: string, removed: Set<string>, force: boolean) {
  const cells = rowCells(block);
  const updates: Array<() => void> = [];
  for (const [rowId, row] of cells) {
    const cell = field(row, columnId);
    const value = field(cell, "value");
    const selected = type === "select" ? [value] : array(value);
    const keep = selected.filter(id => typeof id !== "string" || !removed.has(id));
    if (selected.length === keep.length) continue;
    if (!force) throw new Error("A removed option is still selected by rows. Pass force: true to clear those selections.");
    updates.push(() => {
      if (value instanceof Y.Array && type === "multi-select") {
        for (let i = selected.length - 1; i >= 0; i--) {
          const id = selected[i];
          if (typeof id === "string" && removed.has(id)) value.delete(i, 1);
        }
        return;
      }
      setField(cell, "value", type === "select" ? null : keep, nextCell => {
        setField(row, columnId, nextCell, nextRow => cells.set(rowId, nextRow));
      });
    });
  }
  return updates;
}

const optionId = z.string().min(1);
const optionChanges = z.array(z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), optionId, name: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal("delete"), optionId }).strict(),
])).min(1).max(200);

function updateColumn(block: Y.Map<unknown>, args: {
  columnId: string;
  name?: string;
  optionChanges?: z.infer<typeof optionChanges>;
  force?: boolean;
}) {
  const columns = databaseArray(block, "columns");
  const index = findIndex(columns, args.columnId, "column");
  const column = columns.get(index);
  let updated: unknown = column;
  const replaceColumn = (next: JsonRecord) => { updated = next; };
  const name = args.name;
  if (name !== undefined) {
    const nameKey = name.toLowerCase();
    if (nameKey === "title" && field(column, "type") !== "title") {
      throw new Error("The name 'Title' is reserved for the row title.");
    }
    const otherColumns = columns.toArray().filter((_, i) => i !== index);
    // Cell tools try an exact display name before an ID, then a normalized name.
    if (otherColumns.some(other => field(other, "id") === name)) {
      throw new Error(`Column name '${name}' matches another column's ID.`);
    }
    if (otherColumns.some(other => String(field(other, "name") ?? "").trim().toLowerCase() === nameKey)) {
      throw new Error(`Column '${name}' already exists.`);
    }
  } else if (!args.optionChanges) {
    throw new Error("Provide name or optionChanges.");
  }

  if (args.optionChanges) {
    const type = field(column, "type");
    if (type !== "select" && type !== "multi-select") {
      throw new Error("optionChanges requires a select or multi-select column.");
    }
    const data = field(column, "data");
    const rawOptions = field(data, "options");
    const options = array(rawOptions);
    const byId = new Map(options.map(option => [field(option, "id"), option]));
    const changes = new Map(args.optionChanges.map(change => [change.optionId, change]));
    if (changes.size !== args.optionChanges.length) throw new Error("optionChanges contains duplicate option IDs.");
    for (const id of changes.keys()) {
      if (!byId.has(id)) throw new Error(`Select option '${id}' not found.`);
    }

    const removed = new Set(args.optionChanges.filter(change => change.action === "delete").map(change => change.optionId));
    const labels = new Map<unknown, number>();
    for (const option of options) {
      const id = field(option, "id");
      const change = typeof id === "string" ? changes.get(id) : undefined;
      if (change?.action === "delete") continue;
      const label = change?.action === "rename" ? change.name : field(option, "value");
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
    for (const change of args.optionChanges) {
      if (change.action === "rename" && labels.get(change.name)! > 1) {
        throw new Error(`Option '${change.name}' already exists.`);
      }
    }
    const cleanup = removed.size === 0 ? [] : planOptionCleanup(block, args.columnId, type, removed, args.force === true);
    if (removed.size) ensureNoViewDependency(block, removed, "option");

    const rename = (option: unknown, label: string, replace: (next: JsonRecord) => void) => {
      if (field(option, "value") !== label) setField(option, "value", label, replace);
    };
    if (rawOptions instanceof Y.Array) {
      for (let i = options.length - 1; i >= 0; i--) {
        const change = changes.get(field(options[i], "id") as string);
        if (change?.action === "delete") rawOptions.delete(i, 1);
        if (change?.action === "rename") rename(options[i], change.name, next => replaceAt(rawOptions, i, next));
      }
    } else {
      const next = options.flatMap(option => {
        const change = changes.get(field(option, "id") as string);
        if (change?.action === "delete") return [];
        if (change?.action === "rename") return [{ ...record(option), value: change.name }];
        return [option];
      });
      setField(data, "options", next, nextData => setField(updated, "data", nextData, replaceColumn));
    }
    for (const apply of cleanup) apply();
  }

  if (name !== undefined && field(updated, "name") !== name) setField(updated, "name", name, replaceColumn);
  if (updated !== column) replaceAt(columns, index, updated);
  return { columnId: args.columnId };
}

function deleteColumn(block: Y.Map<unknown>, columnId: string) {
  const columns = databaseArray(block, "columns");
  const index = findIndex(columns, columnId, "column");
  if (field(columns.get(index), "type") === "title" || columnId === "title") {
    throw new Error("Cannot delete the database title column.");
  }
  ensureNoViewDependency(block, new Set([columnId]), "column");
  const views = databaseArray(block, "views");
  const cells = rowCells(block);

  columns.delete(index, 1);
  for (const [rowId, row] of [...cells]) {
    if (row instanceof Y.Map) row.delete(columnId);
    else if (Object.hasOwn(record(row) ?? {}, columnId)) {
      const next = { ...record(row) };
      delete next[columnId];
      cells.set(rowId, next);
    }
  }
  views.toArray().forEach((view, viewIndex) => {
    const entries = field(view, "columns");
    if (entries instanceof Y.Array) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (field(entries.get(i), "id") === columnId) entries.delete(i, 1);
      }
    } else if (Array.isArray(entries) && entries.some(entry => field(entry, "id") === columnId)) {
      setField(view, "columns", entries.filter(entry => field(entry, "id") !== columnId),
        next => replaceAt(views, viewIndex, next));
    }
  });
  return { columnId };
}

function updateView(block: Y.Map<unknown>, args: {
  viewId: string; columnOrder?: string[]; hiddenColumnIds?: string[];
}) {
  const views = databaseArray(block, "views");
  const index = findIndex(views, args.viewId, "view");
  const view = views.get(index);
  const mode = field(view, "mode");
  if (mode !== "table" && mode !== "kanban") {
    throw new Error("View column mutation supports table and kanban views.");
  }
  if (!args.columnOrder && !args.hiddenColumnIds) throw new Error("Provide columnOrder or hiddenColumnIds.");
  const rawEntries = field(view, "columns");
  const entries = array(rawEntries);
  const byId = new Map<string, unknown>();
  for (const entry of entries) {
    const id = field(entry, "id");
    if (typeof id !== "string" || byId.has(id)) throw new Error("View has an invalid or duplicate column ID.");
    byId.set(id, entry);
  }
  // AFFiNE appends implicit database properties after the stored view columns.
  for (const column of databaseArray(block, "columns").toArray()) {
    const id = field(column, "id");
    if (typeof id !== "string" || byId.has(id)) continue;
    // Match the defaults on AFFiNE's table view when materializing a property.
    const width = field(column, "type") === "title" ? 260 : 180;
    byId.set(id, mode === "table" ? { id, width } : { id });
  }
  const callOrder = args.columnOrder;
  if (callOrder && (callOrder.length !== byId.size || new Set(callOrder).size !== byId.size ||
      callOrder.some(id => !byId.has(id)))) {
    throw new Error("columnOrder must contain each view column ID exactly once.");
  }
  const hidden = args.hiddenColumnIds && new Set(args.hiddenColumnIds);
  if (hidden && (hidden.size !== args.hiddenColumnIds?.length || [...hidden].some(id => !byId.has(id)))) {
    throw new Error("hiddenColumnIds must contain distinct view column IDs.");
  }

  const order = callOrder ?? [...byId.keys()];
  const sameOrder = order.length === entries.length && order.every((id, i) => entries[i] === byId.get(id));
  if (sameOrder && (!hidden || order.every(id => (field(byId.get(id), "hide") === true) === hidden.has(id)))) {
    return { viewId: args.viewId };
  }
  if (rawEntries instanceof Y.Array && sameOrder) {
    if (hidden) entries.forEach((entry, i) => {
      const hide = hidden.has(order[i]);
      if ((field(entry, "hide") === true) !== hide) setField(entry, "hide", hide, next => replaceAt(rawEntries, i, next));
    });
  } else {
    // Yjs shared types cannot be reinserted after deletion. Clone just the
    // entries in this view's ordered column list and preserve its other fields.
    const next = order.map(id => {
      const entry = byId.get(id);
      if (entry instanceof Y.Map) {
        const copy = entry.clone();
        if (hidden) copy.set("hide", hidden.has(id));
        return copy;
      }
      return hidden ? { ...record(entry), hide: hidden.has(id) } : entry;
    });
    if (rawEntries instanceof Y.Array) {
      rawEntries.delete(0, rawEntries.length);
      rawEntries.push(next);
    } else {
      setField(view, "columns", next, replacement => replaceAt(views, index, replacement));
    }
  }
  return { viewId: args.viewId };
}

export function registerDatabaseMutationTools(server: McpServer, deps: {
  docId: z.ZodType<string>;
  mutate: (target: Target, edit: (block: Y.Map<unknown>) => Result) => Promise<CallToolResult>;
}) {
  const id = z.string().min(1);
  const target = { workspaceId: z.string().optional(), docId: deps.docId, databaseBlockId: id };
  server.registerTool("update_database_column", {
    title: "Update Database Column",
    description: "Rename a database column or rename and remove its select options by stable ID. Removing a selected option requires force.",
    inputSchema: {
      ...target,
      columnId: id,
      name: z.string().trim().min(1).optional(),
      optionChanges: optionChanges.optional(),
      force: z.boolean().optional().describe("On option removal, clear only selections that reference the removed IDs. View dependencies still prevent removal."),
    },
  }, args => deps.mutate(args, block => updateColumn(block, args)));

  server.registerTool("delete_database_column", {
    title: "Delete Database Column",
    description: "Delete a non-title column, its cells, and its entries in view column lists. Columns used by other view settings cannot be deleted.",
    inputSchema: { ...target, columnId: id },
  }, args => deps.mutate(args, block => deleteColumn(block, args.columnId)));

  server.registerTool("update_database_view", {
    title: "Update Database View Columns",
    description: "Set column order and visibility on an existing table or kanban database view.",
    inputSchema: {
      ...target,
      viewId: id,
      columnOrder: z.array(id).optional().describe("Complete list of column IDs in desired order, including hidden columns and implicit database columns."),
      hiddenColumnIds: z.array(id).optional().describe("Complete set of hidden column IDs. Pass [] to show every column, or omit to preserve visibility."),
    },
  }, args => deps.mutate(args, block => updateView(block, args)));
}
