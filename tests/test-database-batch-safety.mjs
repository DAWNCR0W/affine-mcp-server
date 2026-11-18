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
let beforePagePush;
let rejectNextPagePush = false;
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
      if (payload.docId === docId) beforePagePush?.();
      pushes.push(payload.docId);
      if (payload.docId === docId && rejectNextPagePush) {
        rejectNextPagePush = false;
        ack = { data: { accepted: false, timestamp: ++timestamp } };
      } else {
        Y.applyUpdate(docs.get(payload.docId), Buffer.from(payload.update, "base64"));
        ack = { data: { accepted: true, timestamp: ++timestamp } };
      }
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
  const initial = await call("read_doc");
  assert.deepEqual(await call("get_doc_revision", { workspaceId: undefined }), { docId, revision: initial.revision });
  assert.deepEqual(await call("get_doc_revision", { docId: "missing-doc" }), { docId: "missing-doc", revision: null });
  const selected = await call("read_doc", { blockIds: ["tail", "absent", "anchor"] });
  assert.equal(selected.revision, initial.revision);
  assert.equal(selected.blockCount, 2);
  assert.equal(selected.title, null);
  assert.equal(selected.plainText, "Before database\nKeep this tail");
  assert.deepEqual(selected.blocks, initial.blocks.filter(block => ["anchor", "tail"].includes(block.id)));
  assert.deepEqual(selected.missingBlockIds, ["absent"]);
  const missing = await call("read_doc", { docId: "missing-doc", blockIds: ["tail"] });
  assert.equal(missing.revision, null);
  assert.deepEqual(missing.missingBlockIds, ["tail"]);
  await rejectedWithoutWrite("read_doc", { blockIds: ["tail"], includeMarkdown: true }, /includeMarkdown cannot/);

  const richText = [
    { insert: "Keep", attributes: { bold: true } },
    { insert: " ", attributes: { reference: { type: "LinkedPage", pageId: "linked-document" } } },
  ];
  await rejectedWithoutWrite("update_blocks", {
    expectedRevision: initial.revision,
    updates: [{ blockId: "tail", text: "Must roll back" }, { blockId: "anchor", checked: true }],
  }, /todo list block/);
  await rejectedWithoutWrite("update_blocks", {
    updates: [{ blockId: "tail", text: "one" }, { blockId: "tail", text: "two" }],
  }, /Duplicate block id/);

  const beforeBlockBatch = pushes.filter(id => id === docId).length;
  const batchEdit = await call("update_blocks", {
    expectedRevision: initial.revision,
    updates: [{ blockId: "tail", text: richText }, { blockId: "anchor", type: "heading", level: 2 }],
  });
  assert.equal(pushes.filter(id => id === docId).length - beforeBlockBatch, 1);
  assert.equal(batchEdit.updated, 2);
  assert.deepEqual(batchEdit.results.map(({ blockId, updated }) => [blockId, updated]), [["tail", true], ["anchor", true]]);
  assert.equal(batchEdit.results[1].block.type, "h2");
  assert.equal(batchEdit.results[1].block.text, "Before database");
  assert.deepEqual(batchEdit.results[0].changed, ["text"]);
  assert.equal(batchEdit.results[0].block.type, null, "a legacy block retains its omitted type property");
  assert.deepEqual(batchEdit.results[0].block.deltas, richText);
  assert.equal(batchEdit.results[0].previous.text, "Keep this tail");
  const verified = await call("read_doc", { blockIds: ["tail"] });
  assert.equal(verified.revision, batchEdit.revision);
  assert.deepEqual(verified.blocks[0].linkedDocIds, ["linked-document"]);
  assert.equal(verified.blocks[0].parentId, "note");
  await rejectedWithoutWrite("update_blocks", {
    expectedRevision: initial.revision,
    updates: [{ blockId: "tail", text: "must not write against stale input" }],
  }, /STALE_DOCUMENT_REVISION/);

  const noOp = await call("update_block", { blockId: "tail", text: richText, expectedRevision: batchEdit.revision });
  assert.equal(noOp.updated, false);
  assert.equal(noOp.revision, batchEdit.revision);
  assert.equal(pushes.filter(id => id === docId).length - beforeBlockBatch, 1, "no-op must not write");

  const noOpBatch = await call("update_blocks", {
    expectedRevision: noOp.revision,
    updates: [{ blockId: "anchor", level: 2 }, { blockId: "tail", text: richText }],
  });
  assert.equal(noOpBatch.updated, 0);
  assert.equal(noOpBatch.revision, noOp.revision);
  assert.equal(pushes.filter(id => id === docId).length - beforeBlockBatch, 1, "no-op batch must not write");

  const confirmed = await call("update_block", {
    blockId: "anchor", text: "Confirmed edit", expectedRevision: noOpBatch.revision,
  });
  assert.equal(confirmed.updated, true);
  assert.notEqual(confirmed.revision, noOpBatch.revision);
  assert.equal((await call("get_doc_revision")).revision, confirmed.revision);

  beforePagePush = () => {
    beforePagePush = undefined;
    blocks.get("tail").set("prop:text", new Y.Text("External edit"));
  };
  const single = await call("update_block", {
    blockId: "anchor", text: "Chained from the confirmed edit", expectedRevision: confirmed.revision,
  });
  assert.equal(single.updated, true);
  const afterExternalEdit = await call("read_doc");
  assert.notEqual(single.revision, afterExternalEdit.revision, "the receipt must exclude an unseen external edit");
  assert.equal(afterExternalEdit.blocks.find(block => block.id === "anchor").text, "Chained from the confirmed edit");
  await rejectedWithoutWrite("update_block", {
    expectedRevision: single.revision,
    blockId: "tail",
    text: "must not overwrite the unseen external edit",
  }, /STALE_DOCUMENT_REVISION/);

  const beforeTable = pushes.filter(id => id === docId).length;
  const tableBlock = await call("append_block", {
    type: "table", rows: 2, columns: 2,
    tableData: [["Header A", "Header B"], ["Cell A", "Cell B"]],
    expectedRevision: afterExternalEdit.revision,
  });
  assert.equal(pushes.filter(id => id === docId).length - beforeTable, 1);
  let tableRevision = tableBlock.revision;
  assert.equal((await call("read_doc")).revision, tableRevision, "table append returns the persisted document revision");
  const cell = await call("update_table_cell", {
    blockId: tableBlock.blockId, row: 1, column: 0, text: "Updated cell", expectedRevision: tableRevision,
  });
  assert.equal(cell.updated, true);
  assert.notEqual(cell.revision, tableRevision);
  tableRevision = cell.revision;
  assert.equal((await call("read_doc")).revision, tableRevision, "table cell edit returns the persisted revision");
  const beforeNoOpCell = pushes.filter(id => id === docId).length;
  const unchangedCell = await call("update_table_cell", {
    blockId: tableBlock.blockId, row: 1, column: 0, text: "Updated cell", expectedRevision: tableRevision,
  });
  assert.equal(unchangedCell.updated, false);
  assert.equal(unchangedCell.revision, tableRevision);
  assert.equal(pushes.filter(id => id === docId).length, beforeNoOpCell, "no-op cell edit must not push");
  assert.equal((await call("read_doc")).revision, tableRevision, "no-op cell revision matches the persisted snapshot");
  const widths = await call("update_table_column_widths", {
    blockId: tableBlock.blockId, widths: [120, 140], expectedRevision: tableRevision,
  });
  assert.equal(widths.updated, true);
  assert.notEqual(widths.revision, tableRevision);
  tableRevision = widths.revision;
  assert.equal((await call("read_doc")).revision, tableRevision, "column width edit returns the persisted revision");
  const unchangedWidths = await call("update_table_column_widths", {
    blockId: tableBlock.blockId, widths: [120, 140], expectedRevision: tableRevision,
  });
  assert.equal(unchangedWidths.updated, false);
  assert.equal(unchangedWidths.revision, tableRevision);
  assert.equal((await call("read_doc")).revision, tableRevision, "no-op width revision matches the persisted snapshot");

  beforePagePush = () => {
    beforePagePush = undefined;
    blocks.get("tail").set("prop:text", new Y.Text("Concurrent external edit during table update"));
  };
  const tableWithExternalEdit = await call("update_table_cell", {
    blockId: tableBlock.blockId, row: 1, column: 0, text: "Another cell edit", expectedRevision: tableRevision,
  });
  const afterTableAndExternalEdit = await call("get_doc_revision");
  assert.notEqual(tableWithExternalEdit.revision, afterTableAndExternalEdit.revision,
    "a table revision must exclude an external edit that arrived after loading the mutation snapshot");
  await rejectedWithoutWrite("update_table_cell", {
    blockId: tableBlock.blockId, row: 1, column: 0, text: "Must not write against the stale token",
    expectedRevision: tableWithExternalEdit.revision,
  }, /STALE_DOCUMENT_REVISION/);

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
  let databaseRevision = db.revision;
  assert.equal((await call("read_doc")).revision, databaseRevision, "database composition returns the persisted revision");
  assert.deepEqual(blocks.get("note").get("sys:children").toArray(), ["anchor", db.databaseBlockId, "tail", tableBlock.blockId]);
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

  databaseRevision = (await call("read_doc")).revision;
  const addedColumn = await call("add_database_column", {
    databaseBlockId: db.databaseBlockId, name: "Priority", type: "rich-text", expectedRevision: databaseRevision,
  });
  assert.equal(addedColumn.added, true);
  assert.notEqual(addedColumn.revision, databaseRevision);
  const staleDatabaseRevision = databaseRevision;
  databaseRevision = addedColumn.revision;
  assert.equal((await call("read_doc")).revision, databaseRevision, "database column edit returns the persisted revision");
  await rejectedWithoutWrite("add_database_column", {
    databaseBlockId: db.databaseBlockId, name: "Stale", type: "rich-text", expectedRevision: staleDatabaseRevision,
  }, /STALE_DOCUMENT_REVISION/);

  // A valid early row can add options locally; a late error must discard both.
  await rejectedWithoutWrite("add_database_rows", {
    databaseBlockId: db.databaseBlockId,
    rows: [{ cells: { title: "discarded", Status: "Rollback status", Count: 3 } }, { cells: { title: "bad", Count: "invalid" } }],
  }, /expected a number/);
  assert.equal((await call("read_database_columns", { databaseBlockId: db.databaseBlockId })).rowCount, 2);
  const beforeBatch = pushes.filter(id => id === docId).length;
  const batch = await call("add_database_rows", {
    databaseBlockId: db.databaseBlockId,
    expectedRevision: databaseRevision,
    rows: [
      { cells: { title: [{ insert: "bold row", attributes: { bold: true } }], Status: "Shared option", Count: 3 } },
      { cells: { Status: "Shared option", Count: 4 }, linkedDocId: "linked-document" },
    ],
  });
  assert.equal(batch.added, 2);
  assert.notEqual(batch.revision, databaseRevision);
  databaseRevision = batch.revision;
  assert.equal((await call("read_doc")).revision, databaseRevision, "database row batch returns the persisted revision");
  assert.equal(pushes.filter(id => id === docId).length - beforeBatch, 1);
  assertCreators(batch.rowBlockIds, db.databaseBlockId);
  assert.deepEqual(blocks.get(batch.rowBlockIds[0]).get("prop:text").toDelta(), [{ insert: "bold row", attributes: { bold: true } }]);
  assert.equal(blocks.get(batch.rowBlockIds[1]).get("prop:text").toDelta()[0].attributes.reference.pageId, "linked-document");
  const columns = await call("read_database_columns", { databaseBlockId: db.databaseBlockId });
  assert.equal(columns.columns.find(column => column.name === "Status").options.filter(option => option.value === "Shared option").length, 1);
  assert.deepEqual(numberColumn.get("data").toJSON(), { decimal: 2, format: "percent" },
    "batch row writes must preserve existing custom number formatting");

  const rowUpdate = await call("update_database_row", {
    databaseBlockId: db.databaseBlockId,
    rowBlockId: batch.rowBlockIds[0],
    cells: { Count: 6 },
    expectedRevision: databaseRevision,
  });
  assert.equal(rowUpdate.updated, true);
  assert.notEqual(rowUpdate.revision, databaseRevision);
  databaseRevision = rowUpdate.revision;
  assert.equal((await call("read_doc")).revision, databaseRevision, "database row edit returns the persisted revision");
  const unchangedRow = await call("update_database_row", {
    databaseBlockId: db.databaseBlockId,
    rowBlockId: batch.rowBlockIds[0],
    cells: {},
    expectedRevision: databaseRevision,
  });
  assert.equal(unchangedRow.revision, databaseRevision, "empty database row edit leaves revision unchanged");
  assert.equal((await call("read_doc")).revision, databaseRevision, "no-op row revision matches the persisted snapshot");

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

  const previousPageTitle = blocks.get("page").get("prop:title").toString();
  const metadataPage = root.getMap("meta").get("pages").get(0);
  rejectNextPagePush = true;
  const titleFailure = await rawCall("update_doc_title", { title: "Title metadata updated" });
  assert.equal(titleFailure.isError, true);
  const partialTitle = payloadOf(titleFailure);
  assert.equal(partialTitle.status, "partial");
  assert.equal(partialTitle.metadataUpdated, true);
  assert.equal(Object.hasOwn(partialTitle, "revision"), false, "partial title receipts must omit a revision");
  assert.equal(metadataPage.get("title"), "Title metadata updated", "workspace title metadata was acknowledged");
  assert.equal(blocks.get("page").get("prop:title").toString(), previousPageTitle, "uncertain page update was not applied in this fixture");
  console.log("PASS: atomic database and block batches, targeted reads, rich cells and revision chaining");
} finally {
  await client.close();
  await server.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const doc of docs.values()) doc.destroy();
}
