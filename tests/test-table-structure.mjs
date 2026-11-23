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
  seedBlock("page", "affine:page", ["note"]);
  seedBlock("note", "affine:note").set("sys:parent", "page");
  const capability = await call("get_capabilities");
  assert.deepEqual(capability.docs.tableMutation, { rows: true, columns: true, maxRowsOnCreate: 1000 });

  const formatted = [
    [{ insert: "Bold", attributes: { bold: true } }],
    [{ insert: "Link", attributes: { link: "https://example.com" } }],
    [{ insert: " ", attributes: { reference: { type: "LinkedPage", pageId: "synthetic-linked-page" } } }],
  ];
  const text = value => [{ insert: value }];
  const created = await call("append_block", {
    type: "table", rows: 3, columns: 3,
    tableCellDeltas: [["Task", "Details", "Page"].map(text), formatted, ["Old", "Discard", ""].map(text)],
  });
  const { blockId } = created;
  const table = blocks.get(blockId);
  const read = async () => {
    const result = await call("read_doc", { blockIds: [blockId] });
    assert.equal(result.blocks[0].id, blockId);
    return result;
  };
  const mutate = async (name, args) => {
    const { revision } = await read();
    const before = blockPushes.filter(id => id === docId).length;
    const result = await call(name, { blockId, expectedRevision: revision, ...args });
    if (name !== "add_table_rows") assert.equal(result.ok, true);
    assert.equal(result.blockId, blockId);
    assert.equal(result.revision, (await read()).revision);
    assert.equal(blockPushes.filter(id => id === docId).length, before + 1);
    return result;
  };
  const widths = await call("update_table_column_widths", { blockId, widths: [180, 260, 380] });
  const before = (await read()).blocks[0];
  const storedCells = [...table.entries()].filter(([key]) => key.startsWith("prop:cells."));
  const appended = await mutate("add_table_rows", { rows: [["Tail", "", ""]] });
  assert.equal(appended.index, 3);
  assert.deepEqual(Object.keys(appended).sort(), ["added", "blockId", "columnCount", "index", "revision", "rowCount", "rowIds"]);
  await stale("add_table_rows", { blockId, rows: [["Stale", "", ""]], expectedRevision: widths.revision });
  const inserted = await mutate("add_table_rows", { index: 1, rows: [[text("New"), [], []]] });
  assert.equal(inserted.index, 1);
  let snapshot = (await read()).blocks[0];
  assert.equal(JSON.stringify(snapshot.tableCellDeltas[2]), JSON.stringify(before.tableCellDeltas[1]));
  for (const [key, value] of storedCells) assert.equal(table.get(key), value, key);

  const oldCell = storedCells.find(([, value]) => value.toString() === "Old")[0];
  await mutate("delete_table_row", { index: 3 });
  assert.ok(!table.has(oldCell));
  const column = await mutate("insert_table_column", { index: 1, header: "Added", width: 300 });
  snapshot = (await read()).blocks[0];
  assert.deepEqual(snapshot.tableData, [
    ["Task", "Added", "Details", "Page"], ["New", "", "", ""],
    ["Bold", "", "Link", " "], ["Tail", "", "", ""],
  ]);
  assert.deepEqual(snapshot.tableColumnWidths, [180, 300, 260, 380]);
  assert.deepEqual(snapshot.tableCellDeltas[0][1], [{ insert: "Added", attributes: { bold: true } }]);
  await mutate("delete_table_column", { index: 1 });
  snapshot = (await read()).blocks[0];
  assert.deepEqual(snapshot.tableColumnWidths, [180, 260, 380]);
  assert.ok(![...table.keys()].some(key => key.includes(column.columnId)));
  assert.equal(JSON.stringify(snapshot.tableCellDeltas[2]), JSON.stringify(formatted));

  await rejects("delete_table_row", { blockId, index: 4 }, /row index 4 is out of range/);
  await rejects("insert_table_column", { blockId, index: 9 }, /column index 9 is out of range/);
  await rejects("add_table_rows", { blockId, rows: [["short"]] }, /expected 3 columns/);
  await rejects("add_table_rows", { blockId, rows: [["valid", "", ""], ["short"]] }, /expected 3 columns/);
  await rejects("add_table_rows", { blockId, index: 0, rows: [["Header", "", ""]] }, /greater than or equal to 1/);
  await rejects("add_table_rows", { blockId, rows: [[[], [], [
    { insert: "invalid", attributes: { reference: { type: "LinkedPage", pageId: "fixture" } } },
  ]]] }, /native reference sentinel/);

  for (let length = snapshot.tableData.length; length <= 20; length++) {
    await call("add_table_rows", { blockId, rows: [["", "", ""]] });
  }
  assert.equal((await read()).blocks[0].tableData.length, 21);

  const large = await call("append_block", { type: "table", rows: 21, columns: 21 });
  const largeBlock = (await call("read_doc", { blockIds: [large.blockId] })).blocks[0];
  assert.equal(largeBlock.tableData.length, 21);
  assert.equal(largeBlock.tableData[0].length, 21);
  await rejects("append_block", { type: "table", rows: 101, columns: 50 }, /at most 5000 cells/);

  // Exercise the older nested layout, including pre-fractional order keys.
  const nestedId = "nested-table";
  const nested = seedBlock(nestedId, "affine:table");
  nested.set("prop:rows", new Y.Map([["header", { rowId: "header", order: "r0000" }], ["data", { rowId: "data", order: "r0001" }]]));
  nested.set("prop:columns", { column: { columnId: "column", order: "c0000", width: 250 } });
  nested.set("prop:cells", new Y.Map([
    ["header:column", new Y.Map([["text", new Y.Text("Heading")]])],
    ["data:column", new Y.Map([["text", new Y.Text("Original")]])],
  ]));
  await call("add_table_rows", { blockId: nestedId, index: 1, rows: [["Inserted"]] });
  const readNested = async () => (await call("read_doc", { blockIds: [nestedId] })).blocks[0];
  assert.deepEqual((await readNested()).tableData, [["Heading"], ["Inserted"], ["Original"]]);
  await call("delete_table_row", { blockId: nestedId, index: 2 });
  await call("delete_table_row", { blockId: nestedId, index: 1 });
  assert.deepEqual((await readNested()).tableData, [["Heading"]]);
  assert.deepEqual((await readNested()).tableColumnWidths, [250]);
  assert.deepEqual([...nested.get("prop:cells").keys()], ["header:column"]);
  await rejects("delete_table_row", { blockId: nestedId, index: 0 }, /final table row/);
  await rejects("delete_table_column", { blockId: nestedId, index: 0 }, /final table column/);

  const objectId = "object-table";
  const objectTable = seedBlock(objectId, "affine:table");
  objectTable.set("prop:rows", { header: { rowId: "header", order: "r0000" } });
  objectTable.set("prop:columns", { column: { columnId: "column", order: "c0000", width: 240 } });
  objectTable.set("prop:cells", { "header:column": { text: "Heading" } });
  const batch = await call("add_table_rows", { blockId: objectId, rows: [["First"], ["Second"]] });
  assert.equal(batch.added, 2);
  const objectSnapshot = (await call("read_doc", { blockIds: [objectId] })).blocks[0];
  assert.deepEqual(objectSnapshot.tableData, [["Heading"], ["First"], ["Second"]]);
  assert.deepEqual(objectSnapshot.tableColumnWidths, [240]);
  console.log("PASS: native table mutations, rich text, widths, revisions, larger tables and header-only tables");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const value of docs.values()) value.destroy();
}
