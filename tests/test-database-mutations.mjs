import "./require-destructive-test-safety.mjs";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { z } from "zod/v3";
import { coordinateTool } from "../dist/toolCoordination.js";
import { toolOutputSchemaFor } from "../dist/toolOutputSchemas.js";
import { registerDocTools } from "../dist/tools/docs.js";

const workspaceId = "synthetic-workspace", docId = "synthetic-document";
const root = new Y.Doc(), doc = new Y.Doc();
const pages = new Y.Array();
root.getMap("meta").set("pages", pages);
pages.push([new Y.Map([["id", docId], ["updatedDate", 1]])]);
const docs = new Map([[workspaceId, root], [docId, doc]]);
const blocks = doc.getMap("blocks");
const blockPushes = [];
let timestamp = 1;

function seedBlock(id, flavour, children = []) {
  const block = new Y.Map([
    ["sys:id", id], ["sys:flavour", flavour], ["sys:version", 1],
    ["sys:children", Y.Array.from(children)],
  ]);
  blocks.set(id, block);
  return block;
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", socket => {
  socket.send('0{"sid":"fixture","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
  socket.on("message", message => {
    const packet = String(message);
    if (packet === "2") { socket.send("3"); return; }
    if (packet.startsWith("40")) { socket.send('40{"sid":"fixture"}'); return; }
    if (!packet.startsWith("42")) return;
    const start = packet.indexOf("["), ackId = packet.slice(2, start);
    const [event, params] = JSON.parse(packet.slice(start));
    let ack;
    if (event === "space:join") ack = [];
    else if (event === "space:load-doc") {
      const target = docs.get(params.docId);
      ack = [{ data: target ? { missing: Buffer.from(Y.encodeStateAsUpdate(target)).toString("base64") } : {} }];
    } else if (event === "space:push-doc-update") {
      assert.ok(docs.has(params.docId));
      blockPushes.push(params.docId);
      Y.applyUpdate(docs.get(params.docId), Buffer.from(params.update, "base64"));
      ack = [{ data: { accepted: true, timestamp: ++timestamp } }];
    } else {
      assert.fail(`Unexpected socket event ${event}`);
    }
    socket.send(`43${ackId}${JSON.stringify(ack)}`);
  });
});
await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
const endpoint = `http://127.0.0.1:${wss.address().port}/graphql`;
const gql = { async getConnectionAuth() { return { endpoint }; } };
const tools = new Map();
registerDocTools({ registerTool(name, definition, handler) {
  tools.set(name, coordinateTool(name, definition.inputSchema, handler, { gql, endpoint, workspaceId }));
} }, gql, { workspaceId });

async function invoke(name, args = {}) {
  const { inputSchema, handler } = tools.get(name);
  return handler(z.object(inputSchema).parse({ docId, ...args }), {});
}
async function call(name, args) {
  const result = await invoke(name, args);
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  assert.ok(toolOutputSchemaFor(name).safeParse(result.structuredContent).success, name);
  return result.structuredContent;
}
async function unchanged(action) {
  const snapshots = [...docs.values()].map(doc => Y.encodeStateAsUpdate(doc));
  const before = blockPushes.length;
  await action();
  assert.equal(blockPushes.length, before, "rejected mutation must not push content or metadata");
  assert.deepEqual([...docs.values()].map(doc => Y.encodeStateAsUpdate(doc)), snapshots);
}
const rejects = (name, args, pattern) => unchanged(() => assert.rejects(invoke(name, args), pattern));
const stale = (name, args) => unchanged(async () => {
  const response = await invoke(name, args);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.code, "STALE_DOCUMENT_REVISION");
});

try {
  seedBlock("page", "affine:page", ["database"]);
  const databaseBlockId = "database";
  const db = seedBlock(databaseBlockId, "affine:database", ["row-a", "row-b"]);
  for (const row of ["row-a", "row-b"]) {
    const r = seedBlock(row, "affine:paragraph");
    r.set("sys:parent", databaseBlockId);
    r.set("prop:text", new Y.Text(row));
  }
  const yMap = values => new Y.Map(Object.entries(values));
  const option = (id, value) => ({ id, value, color: "var(--affine-tag-blue)" });
  const columns = Y.Array.from([
    yMap({ id: "title", name: "Title", type: "title" }),
    yMap({ id: "status", name: " Current Status ", type: "select", data: yMap({
      options: Y.Array.from([yMap(option("deferred", "Deferred")), option("active", "Active")]),
    }) }),
    { id: "tags", name: "Tags", type: "multi-select", data: {
      options: [option("legacy", "Legacy"), option("keep", "Keep")],
    } },
    yMap({ id: "estimate", name: "Estimate", type: "number" }),
    yMap({ id: "notes", name: "Notes", type: "rich-text" }),
  ]);
  const viewIds = ["title", "status", "tags", "estimate", "notes"];
  const viewColumns = Y.Array.from(viewIds.map((id, i) => yMap({ id, width: 200 + i, custom: true })));
  const filter = { type: "group", op: "and", conditions: [{
    type: "filter", left: { type: "ref", name: "status" }, function: "is",
    args: [{ type: "literal", value: "active" }],
  }] };
  const sort = { sortBy: [{ ref: { type: "ref", name: "notes" }, desc: false }], manuallySort: [] };
  const tableView = yMap({
    id: "table-view", name: "Table", mode: "table", columns: viewColumns, filter, sort,
    header: { titleColumn: "title", iconColumn: "type" },
  });
  const plainView = { id: "board", name: "Board", mode: "kanban", columns: [
    { id: "title" }, { id: "status" }, { id: "estimate", hide: true, width: 360 },
  ], groupBy: { type: "groupBy", columnId: "status", name: "select" } };
  const views = Y.Array.from([tableView, plainView]);
  const rich = new Y.Text();
  const formatted = [{ insert: "Keep", attributes: { bold: true, link: "https://example.com" } }];
  rich.applyDelta(formatted);
  const cell = (columnId, value) => yMap({ columnId, value });
  const rowA = yMap({
    status: cell("status", "deferred"), tags: cell("tags", Y.Array.from(["legacy", "keep"])),
    estimate: cell("estimate", 10), notes: cell("notes", rich),
  });
  const rowB = yMap({
    status: { columnId: "status", value: "active" },
    tags: { columnId: "tags", value: ["legacy"] },
    estimate: { columnId: "estimate", value: 20 },
  });
  db.set("prop:columns", columns);
  db.set("prop:views", views);
  db.set("prop:cells", yMap({ "row-a": rowA, "row-b": rowB }));

  const capabilities = await call("get_capabilities");
  assert.equal(capabilities.database.columnMutation, true);
  assert.equal(capabilities.database.viewColumnMutation, true);
  assert.equal(capabilities.database.advancedViewMutation, false);
  const read = () => call("read_database_columns", { databaseBlockId });
  const readCells = () => call("read_database_cells", { databaseBlockId });
  const revision = async () => (await call("get_doc_revision")).revision;
  const mutate = async (name, args) => {
    const before = blockPushes.filter(id => id === docId).length;
    const result = await call(name, { databaseBlockId, expectedRevision: await revision(), ...args });
    assert.equal(result.blockId, databaseBlockId);
    assert.equal(result.ok, true);
    assert.equal(result.revision, await revision());
    assert.equal(blockPushes.filter(id => id === docId).length, before + 1);
    return result;
  };
  const oldRevision = await revision();
  await rejects("update_database_column", { databaseBlockId, columnId: "notes", name: "Title" }, /reserved for the row title/);
  await rejects("update_database_column", { databaseBlockId, columnId: "notes", name: "status" }, /matches another column's ID/);
  await rejects("update_database_column", { databaseBlockId, columnId: "notes", name: "current status" }, /already exists/);
  for (const key of ["status", "CURRENT STATUS"]) {
    const { rows } = await call("read_database_cells", { databaseBlockId, columns: [key] });
    assert.deepEqual(Object.values(rows[0].cells).map(cell => cell.columnId), ["status"]);
  }
  await mutate("update_database_column", { columnId: "status", name: "Stage",
    optionChanges: [{ action: "rename", optionId: "deferred", name: "On hold" }] });
  assert.deepEqual((await read()).columns[1].options[0], option("deferred", "On hold"));
  assert.deepEqual((await readCells()).rows[0].cells.Stage, {
    columnId: "status", type: "select", value: "On hold", optionId: "deferred",
  });
  await stale("update_database_view", { databaseBlockId, viewId: "table-view", hiddenColumnIds: [], expectedRevision: oldRevision });

  const removeDeferred = { databaseBlockId, columnId: "status",
    optionChanges: [{ action: "delete", optionId: "deferred" }] };
  await rejects("update_database_column", { ...removeDeferred, name: "Must stay Stage" }, /force: true/);
  await mutate("update_database_column", { ...removeDeferred, force: true });
  assert.equal((await readCells()).rows[0].cells.Stage.value, null);
  assert.equal((await readCells()).rows[1].cells.Stage.optionId, "active");
  await rejects("update_database_column", { ...removeDeferred, force: true }, /not found/);
  await rejects("update_database_column", { ...removeDeferred, force: true,
    optionChanges: [{ action: "delete", optionId: "active" }] }, /used by view/);

  const removeLegacy = { databaseBlockId, columnId: "tags", optionChanges: [{ action: "delete", optionId: "legacy" }] };
  await rejects("update_database_column", removeLegacy, /force: true/);
  await mutate("update_database_column", { ...removeLegacy, force: true });
  const { rows } = await readCells();
  assert.deepEqual(rows[0].cells.Tags.optionIds, ["keep"]);
  assert.deepEqual(rows[1].cells.Tags.optionIds, []);
  assert.deepEqual(rows[0].cells.Notes.deltas, formatted);

  await rejects("delete_database_column", { databaseBlockId, columnId: "title" }, /title column/);
  await rejects("delete_database_column", { databaseBlockId, columnId: "status" }, /used by view/);
  await rejects("delete_database_column", { databaseBlockId, columnId: "notes" }, /used by view/);
  await mutate("delete_database_column", { columnId: "estimate" });
  assert.ok(!rowA.has("estimate") && !rowB.has("estimate"));
  assert.ok(!(await read()).views.some(view => view.columnIds.includes("estimate")));

  const args = { databaseBlockId, viewId: "table-view" };
  await rejects("update_database_view", { ...args, columnOrder: ["title", "status"] }, /exactly once/);
  await rejects("update_database_view", { ...args, hiddenColumnIds: ["missing"] }, /distinct view column IDs/);
  const reordered = ["title", "notes", "tags", "status"];
  await mutate("update_database_view", { ...args, columnOrder: reordered, hiddenColumnIds: ["tags", "status"] });
  const view = (await read()).views[0];
  assert.equal(view.id, "table-view");
  assert.deepEqual(view.columnIds, reordered);
  assert.deepEqual(view.columns.map(({ width, hidden }) => [width, hidden]),
    [[200, false], [204, false], [202, true], [201, true]]);
  assert.equal(tableView.get("columns").get(1).get("custom"), true);
  assert.deepEqual(tableView.get("filter"), filter);
  assert.deepEqual(tableView.get("sort"), sort);
  await mutate("update_database_view", { ...args, hiddenColumnIds: [] });
  assert.ok((await read()).views[0].columns.every(column => !column.hidden));
  const unchangedRevision = await revision();
  assert.equal((await mutate("update_database_view", { ...args, hiddenColumnIds: [] })).revision, unchangedRevision);
  await mutate("update_database_view", { viewId: "board", columnOrder: reordered, hiddenColumnIds: ["notes"] });
  const board = (await read()).views[1];
  assert.deepEqual(board.columnIds, reordered);
  assert.equal(board.columns[1].hidden, true);
  assert.deepEqual(views.get(1).groupBy, plainView.groupBy);
  assert.deepEqual((await readCells()).rows[0].cells.Notes.deltas, formatted);
  console.log("PASS: database maintenance, select options, view columns, persisted deltas and stale writes");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const value of docs.values()) value.destroy();
}
