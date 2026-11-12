#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocTools } from "../dist/tools/docs.js";
import { coordinateTool } from "../dist/toolCoordination.js";
import { toolOutputSchemaFor } from "../dist/toolOutputSchemas.js";

// Exercise registered MCP handlers, revision coordination, and the actual Yjs
// socket protocol against disposable loopback documents, without AFFiNE access.
const workspaceId = "database-safety-workspace";
const docId = "database-safety-document";
const authorId = "database-safety-author";
function arrayOf(values) {
  const array = new Y.Array();
  array.push(values);
  return array;
}
const root = new Y.Doc();
root.getMap("meta").set("pages", arrayOf([
  new Y.Map([["id", docId], ["title", "Database fixture"], ["createDate", 1], ["updatedDate", 1]]),
]));
const page = new Y.Doc();
const blocks = page.getMap("blocks");
function seedBlock(id, flavour, children = [], text) {
  const block = new Y.Map([
    ["sys:id", id], ["sys:flavour", flavour], ["sys:version", 1], ["sys:parent", null],
    ["sys:children", arrayOf(children)],
  ]);
  if (text !== undefined) block.set("prop:text", new Y.Text(text));
  blocks.set(id, block);
  return block;
}
seedBlock("page", "affine:page", ["note"]).set("prop:title", new Y.Text("Database fixture"));
seedBlock("note", "affine:note", ["anchor", "tail"]);
seedBlock("anchor", "affine:paragraph", [], "Before database");
seedBlock("tail", "affine:paragraph", [], "Keep this tail");
const docs = new Map([[workspaceId, root], [docId, page]]);
const pushes = [];
let timestamp = 1;
let identityQueries = 0;
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", socket => {
  socket.send(`0${JSON.stringify({ sid: "database-engine", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  socket.on("message", message => {
    const packet = String(message);
    if (packet === "2") { socket.send("3"); return; }
    if (packet.startsWith("40")) { socket.send('40{"sid":"database-socket"}'); return; }
    if (!packet.startsWith("42")) return;
    const index = packet.indexOf("[");
    const ackId = packet.slice(2, index);
    const [event, payload = {}] = JSON.parse(packet.slice(index));
    let ack;
    if (event === "space:join") ack = undefined;
    else if (event === "space:load-doc") {
      const doc = docs.get(payload.docId);
      ack = { data: doc ? { missing: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") } : {} };
    } else if (event === "space:push-doc-update") {
      assert.ok(docs.has(payload.docId), "tests must only mutate their disposable fixtures");
      pushes.push(payload.docId);
      Y.applyUpdate(docs.get(payload.docId), Buffer.from(payload.update, "base64"));
      ack = { data: { timestamp: ++timestamp } };
    } else throw new Error(`Unexpected event ${event}`);
    socket.send(`43${ackId}${JSON.stringify(ack === undefined ? [] : [ack])}`);
  });
});
await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
const endpoint = `http://127.0.0.1:${wss.address().port}/graphql`;
const gql = {
  async getConnectionAuth() { return { endpoint }; },
  async request(query) {
    assert.match(query, /currentUser\s*\{\s*id\s*\}/);
    identityQueries++;
    return { currentUser: { id: authorId } };
  },
};
const server = new McpServer({ name: "database-safety", version: "1.0.0" });
const register = server.registerTool.bind(server);
server.registerTool = (name, definition, handler) => {
  const coordinated = coordinateTool(name, definition.inputSchema, handler, { gql, endpoint, workspaceId });
  return register(name, { ...definition, inputSchema: coordinated.inputSchema, outputSchema: toolOutputSchemaFor(name) }, coordinated.handler);
};
registerDocTools(server, gql, { workspaceId });
const client = new Client({ name: "database-safety", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
function payloadOf(result) {
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text);
}
async function rawCall(name, args = {}) {
  return client.callTool({ name, arguments: { workspaceId, docId, ...args } });
}
async function call(name, args = {}) {
  const result = await rawCall(name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return payloadOf(result);
}
const snapshots = () => new Map([...docs].map(([id, doc]) => [id, Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")]));
async function rejectedWithoutWrite(name, args, pattern) {
  const before = snapshots();
  const beforePushes = pushes.length;
  const result = await rawCall(name, args);
  assert.equal(result.isError, true, `${name} must reject invalid input`);
  assert.match(result.content.find(item => item.type === "text").text, pattern);
  assert.equal(pushes.length, beforePushes, "invalid inputs must not push content or workspace metadata");
  assert.deepEqual(snapshots(), before, "invalid inputs must leave every persisted Yjs snapshot unchanged");
  return result;
}
function assertCreators(rowIds, databaseBlockId) {
  for (const rowId of rowIds) {
    const row = blocks.get(rowId);
    assert.equal(row.get("sys:parent"), databaseBlockId);
    assert.equal(row.get("prop:meta:createdBy"), authorId);
    assert.ok(row.get("prop:meta:createdAt") > 1);
  }
}
const customColumns = [{ name: "Status", type: "select", options: ["Todo"] }, { name: "Count", type: "number" }];
try {
  await rejectedWithoutWrite("compose_database_from_intent", {
    intent: "table", columns: [{ name: "Title", type: "rich-text" }], seedRows: [],
  }, /Column 'Title' already exists/);
  await rejectedWithoutWrite("compose_database_from_intent", {
    intent: "table", columns: [{ name: "Count", type: "number" }, { name: "Count", type: "rich-text" }], seedRows: [],
  }, /Column 'Count' already exists/);
  for (const columns of [
    [{ name: "Status", type: "select", options: ["Todo"] }, { name: "Status", type: "select", options: ["Done"] }],
    [{ name: " Status ", type: "select" }, { name: "status", type: "select" }],
    [{ name: " title ", type: "rich-text" }],
    [{ name: "TITLE", type: "select", options: ["Unexpected"] }],
  ]) {
    const beforeIdentity = identityQueries;
    await rejectedWithoutWrite("compose_database_from_intent", {
      intent: "table", columns, seedRows: [{ title: "must not create a row" }],
    }, /Column .* already exists/);
    assert.equal(identityQueries, beforeIdentity, "duplicate names must fail before identity lookup or document mutation");
  }
  await rejectedWithoutWrite("compose_database_from_intent", {
    intent: "table", columns: customColumns,
    seedRows: [{ title: "discarded", Status: "Discarded option", Count: 1 }, { title: "bad", Count: "not-a-number" }],
  }, /expected a number/);
  await rejectedWithoutWrite("compose_database_from_intent", {
    intent: "table", columns: customColumns, seedRows: [{ title: "bad", Missing: "unknown column" }],
  }, /Column 'Missing' not found/);
  await rejectedWithoutWrite("compose_database_from_intent", {
    intent: "table", columns: customColumns, seedRows: [], placement: { parentId: "missing" },
  }, /parent block 'missing'/);
  assert.equal([...blocks.values()].filter(block => block.get("sys:flavour") === "affine:database").length, 0);

  const beforeCompose = pushes.filter(id => id === docId).length;
  const db = await call("compose_database_from_intent", {
    intent: "table", title: "Tasks", columns: customColumns,
    seedRows: [{ title: "first", Status: "Todo", Count: 1 }, { title: "second", Status: "New status", Count: 2 }],
    placement: { beforeBlockId: "tail" },
  });
  assert.equal(pushes.filter(id => id === docId).length - beforeCompose, 1, "database, schema and seed rows must share one content update");
  assert.equal(db.stats.seededRowCount, 2);
  assert.equal(db.stats.addedColumnCount, customColumns.length, "unique custom columns are each added exactly once");
  assert.deepEqual(db.columns.map(column => column.name), ["Title", "Status", "Count"]);
  assert.equal(db.views[0].mode, "table");
  assert.equal(db.views[0].name, "Tasks");
  assert.deepEqual(blocks.get("note").get("sys:children").toArray(), ["anchor", db.databaseBlockId, "tail"]);
  assertCreators(db.rowBlockIds, db.databaseBlockId);
  const read = await call("read_database_cells", { databaseBlockId: db.databaseBlockId });
  assert.deepEqual(read.rows.map(row => [row.title, row.cells.Count.value, row.cells.Status.value]), [
    ["first", 1, "Todo"], ["second", 2, "New status"],
  ]);
  const numberColumn = blocks.get(db.databaseBlockId).get("prop:columns").toArray().find(column => column.get("name") === "Count");
  assert.deepEqual(numberColumn.get("data").toJSON(), { decimal: 0, format: "number" },
    "composed number columns must retain BlockSuite defaults from #458");
  numberColumn.get("data").set("decimal", 2);
  numberColumn.get("data").set("format", "percent");

  // A valid early row can add options locally; a late error must discard both.
  await rejectedWithoutWrite("add_database_rows", {
    databaseBlockId: db.databaseBlockId,
    rows: [{ cells: { title: "discarded", Status: "Rollback status", Count: 3 } }, { cells: { title: "bad", Count: "invalid" } }],
  }, /expected a number/);
  assert.equal((await call("read_database_columns", { databaseBlockId: db.databaseBlockId })).rowCount, 2);
  const beforeBatch = pushes.filter(id => id === docId).length;
  const batch = await call("add_database_rows", {
    databaseBlockId: db.databaseBlockId,
    rows: [
      { cells: { title: [{ insert: "bold row", attributes: { bold: true } }], Status: "Shared option", Count: 3 } },
      { cells: { Status: "Shared option", Count: 4 }, linkedDocId: "linked-document" },
    ],
  });
  assert.equal(batch.added, 2);
  assert.equal(pushes.filter(id => id === docId).length - beforeBatch, 1);
  assertCreators(batch.rowBlockIds, db.databaseBlockId);
  assert.deepEqual(blocks.get(batch.rowBlockIds[0]).get("prop:text").toDelta(), [{ insert: "bold row", attributes: { bold: true } }]);
  assert.equal(blocks.get(batch.rowBlockIds[1]).get("prop:text").toDelta()[0].attributes.reference.pageId, "linked-document");
  const columns = await call("read_database_columns", { databaseBlockId: db.databaseBlockId });
  assert.equal(columns.columns.find(column => column.name === "Status").options.filter(option => option.value === "Shared option").length, 1);
  assert.deepEqual(numberColumn.get("data").toJSON(), { decimal: 2, format: "percent" },
    "batch row writes must preserve existing custom number formatting");

  // Real MCP schema parsing must retain expectedRevision before the registered
  // batch handler runs. A stale request must not query identity or write rows.
  const tool = (await client.listTools()).tools.find(entry => entry.name === "add_database_rows");
  assert.ok(tool.inputSchema.properties.expectedRevision);
  const beforeIdentity = identityQueries;
  const stale = await rejectedWithoutWrite("add_database_rows", {
    databaseBlockId: db.databaseBlockId, rows: [{ cells: { title: "blocked" } }], expectedRevision: "0".repeat(64),
  }, /STALE_DOCUMENT_REVISION/);
  assert.equal(payloadOf(stale).code, "STALE_DOCUMENT_REVISION");
  assert.equal(identityQueries, beforeIdentity);
  numberColumn.delete("data"); // Simulate a column created before #458.
  const revision = (await call("read_doc")).revision;
  const accepted = await call("add_database_rows", {
    databaseBlockId: db.databaseBlockId, rows: [{ cells: { title: "current revision", Count: 5 } }], expectedRevision: revision,
  });
  assert.equal(accepted.added, 1);
  assert.deepEqual(numberColumn.get("data").toJSON(), { decimal: 0, format: "number" },
    "batch row writes must repair legacy number columns with missing property data");
  assert.notEqual((await call("read_doc")).revision, revision);
  await rejectedWithoutWrite("add_database_rows", {
    databaseBlockId: db.databaseBlockId, rows: [{ cells: { title: "stale reuse" } }], expectedRevision: revision,
  }, /STALE_DOCUMENT_REVISION/);

  for (const intent of ["task_board", "issue_tracker"]) {
    const beforePreset = pushes.filter(id => id === docId).length;
    const preset = await call("compose_database_from_intent", { intent });
    assert.equal(pushes.filter(id => id === docId).length - beforePreset, 1, `${intent} must also initialize atomically`);
    assert.equal(preset.stats.seededRowCount, 3);
    assert.equal(preset.views[0].mode, "kanban");
    assert.equal(preset.columns[0].type, "title");
    assertCreators(preset.rowBlockIds, preset.databaseBlockId);
  }
  console.log("PASS: atomic database composition and row batches, metadata, rich cells and stale-revision rejection");
} finally {
  await client.close();
  await server.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const doc of docs.values()) doc.destroy();
}
