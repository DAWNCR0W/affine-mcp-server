#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { coordinateTool } from "../dist/toolCoordination.js";
import { registerDocTools } from "../dist/tools/docs.js";
import { documentRevision } from "../dist/util/documentRevision.js";

// Run real handlers, revision checks, and Yjs updates against loopback fixtures.
const workspaceId = "database-view-workspace";
const root = new Y.Doc();
root.getMap("meta").set("pages", new Y.Array());
const docs = new Map([[workspaceId, root]]);
let pushes = 0;
let timestamp = 1;
let handlerCalls = 0;

function seedDatabase(docId, columns = [], views = [{ id: "existing-view", mode: "table" }]) {
  const doc = new Y.Doc();
  const block = new Y.Map();
  const storedColumns = new Y.Array();
  storedColumns.push(columns.map(column => new Y.Map(Object.entries(column))));
  const storedViews = new Y.Array();
  storedViews.push(views.map(view => new Y.Map(Object.entries(view))));
  for (const [key, value] of Object.entries({
    "sys:id": "database", "sys:flavour": "affine:database", "sys:version": 1,
    "sys:parent": null, "sys:children": new Y.Array(),
    "prop:columns": storedColumns, "prop:views": storedViews, "prop:cells": new Y.Map(),
  })) block.set(key, value);
  doc.getMap("blocks").set("database", block);
  root.getMap("meta").get("pages").push([new Y.Map([
    ["id", docId], ["updatedDate", 1],
  ])]);
  docs.set(docId, doc);
  return block;
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", socket => {
  socket.send(`0${JSON.stringify({ sid: "view-engine", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  socket.on("message", message => {
    const packet = String(message);
    if (packet === "2") { socket.send("3"); return; }
    if (packet.startsWith("40")) { socket.send('40{"sid":"view-socket"}'); return; }
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
      assert.ok(docs.has(payload.docId), "mutations must target an existing fixture");
      pushes++;
      Y.applyUpdate(docs.get(payload.docId), Buffer.from(payload.update, "base64"));
      ack = { data: { timestamp: ++timestamp } };
    } else throw new Error(`Unexpected event ${event}`);
    socket.send(`43${ackId}${JSON.stringify(ack === undefined ? [] : [ack])}`);
  });
});
await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
const endpoint = `http://127.0.0.1:${wss.address().port}/graphql`;
const gql = { async getConnectionAuth() { return { endpoint }; } };
const tools = new Map();
registerDocTools({ registerTool(name, definition, handler) {
  const coordinated = coordinateTool(name, definition.inputSchema, async (args, extra) => {
    if (name === "add_database_view") handlerCalls++;
    return handler(args, extra);
  }, { gql, endpoint, workspaceId });
  tools.set(name, coordinated);
} }, gql, { workspaceId });

const schema = z.object(tools.get("add_database_view").inputSchema);
const argsFor = (docId, rest = {}) => ({ docId, databaseBlockId: "database", ...rest });
const payloadOf = result => result.structuredContent ?? JSON.parse(result.content[0].text);
async function rawCall(args) {
  return tools.get("add_database_view").handler(schema.parse(args), {});
}
async function call(args) {
  const result = await rawCall(args);
  assert.ok(!result.isError, JSON.stringify(payloadOf(result)));
  return payloadOf(result);
}
async function rejectsWithoutWrite(args, pattern) {
  const beforePushes = pushes;
  const before = new Map([...docs].map(([id, doc]) => [id, Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")]));
  await assert.rejects(rawCall(args), pattern);
  assert.equal(pushes, beforePushes, "invalid views must not write content or workspace metadata");
  assert.deepEqual(new Map([...docs].map(([id, doc]) => [id, Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")])), before);
}

try {
  assert.ok(schema.shape.expectedRevision, "the coordinated tool advertises expectedRevision");
  assert.equal(schema.safeParse(argsFor("empty")).success, true, "revision remains optional");
  for (const expectedRevision of ["", "A".repeat(64), "a".repeat(63)]) {
    assert.equal(schema.safeParse(argsFor("empty", { expectedRevision })).success, false);
  }
  assert.equal(schema.safeParse(argsFor("empty", { mode: "gallery" })).success, false);

  // Native databases created by append_block can have no columns or named views.
  const empty = seedDatabase("empty");
  const existingView = empty.get("prop:views").get(0).toJSON();
  const added = await call(argsFor("empty", { name: "Table without columns" }));
  assert.equal(added.mode, "table");
  assert.equal(added.totalViews, 2, "unnamed views contribute to the actual total");
  assert.deepEqual(empty.get("prop:views").get(0).toJSON(), existingView);
  const newView = empty.get("prop:views").get(1);
  assert.equal(newView.get("id"), added.viewId);
  assert.deepEqual(newView.get("columns").toJSON(), []);
  assert.deepEqual(newView.get("header"), { titleColumn: null, iconColumn: null });
  await rejectsWithoutWrite(argsFor("empty", { name: " Table without columns " }), /already exists/);
  await rejectsWithoutWrite(argsFor("empty", { mode: "kanban", groupBy: "Status" }), /no columns/);

  // An absent or malformed stored columns value must not be treated as empty.
  const malformed = seedDatabase("malformed");
  malformed.delete("prop:columns");
  await rejectsWithoutWrite(argsFor("malformed"), /no columns/);
  const malformedEntries = new Y.Array();
  malformedEntries.push([new Y.Map([["name", "Invalid column"]])]);
  malformed.set("prop:columns", malformedEntries);
  await rejectsWithoutWrite(argsFor("malformed"), /no columns/);

  const board = seedDatabase("board", [
    { id: "title", name: "Title", type: "title", width: 320 },
    { id: "status", name: "Status", type: "select", width: 245 },
    { id: "tags", name: "Tags", type: "multi-select" },
    { id: "estimate", name: "Estimate", type: "number" },
  ], [{ id: "initial", name: "Initial", mode: "table" }]);
  for (const [rest, pattern] of [
    [{ mode: "kanban" }, /requires groupBy/],
    [{ mode: "kanban", groupBy: "Missing" }, /not found/],
    [{ mode: "kanban", groupBy: "Estimate" }, /needs select\/multi-select/],
    [{ databaseBlockId: "missing" }, /not found/],
  ]) await rejectsWithoutWrite(argsFor("board", rest), pattern);
  const boardResult = await call(argsFor("board", { name: "By Status", mode: "kanban", groupBy: " Status " }));
  assert.equal(boardResult.totalViews, 2);
  assert.equal(boardResult.groupBy, "Status");
  const kanban = board.get("prop:views").get(1);
  assert.deepEqual(kanban.get("groupBy"), { columnId: "status", name: "select", type: "groupBy" });
  assert.deepEqual(kanban.get("groupProperties"), []);
  assert.deepEqual(kanban.get("header"), { titleColumn: "title", iconColumn: "type" });
  assert.deepEqual(kanban.get("columns").toJSON(), [
    { id: "title", hide: false, width: 320 },
    { id: "status", hide: false, width: 245 },
    { id: "tags", hide: false, width: 200 },
    { id: "estimate", hide: false, width: 200 },
  ]);
  await call(argsFor("board", { name: "By Tags", mode: "kanban", groupBy: "Tags" }));
  assert.deepEqual(board.get("prop:views").get(2).get("groupBy"), { columnId: "tags", name: "multi-select", type: "groupBy" });

  const tableResult = await call(argsFor("board", { name: "Ungrouped table", mode: "table", groupBy: "Status" }));
  assert.equal(tableResult.groupBy, null, "table responses must not echo kanban-only grouping input");
  const table = board.get("prop:views").toArray().find(view => view.get("id") === tableResult.viewId);
  assert.equal(table.get("groupBy"), null, "table response grouping must match native stored state");

  // Concurrent requests use the shared workspace lock. Calls with the same
  // name cannot both validate against an old snapshot and persist.
  const racing = await Promise.allSettled([
    call(argsFor("board", { name: "Concurrent" })),
    call(argsFor("board", { name: "Concurrent" })),
  ]);
  assert.equal(racing.filter(result => result.status === "fulfilled").length, 1);
  assert.match(racing.find(result => result.status === "rejected").reason.message, /already exists/);
  assert.equal(board.get("prop:views").toArray().filter(view => view.get("name") === "Concurrent").length, 1);

  // Exercise the actual revision reader and registration-aware token over WS.
  const guarded = seedDatabase("guarded");
  const revision = documentRevision(docs.get("guarded"));
  await call(argsFor("guarded", { name: "Fresh revision", expectedRevision: revision }));
  const beforeCalls = handlerCalls;
  const beforePushes = pushes;
  const stale = await rawCall(argsFor("guarded", { name: "Must not appear", expectedRevision: revision }));
  assert.equal(stale.isError, true);
  assert.equal(payloadOf(stale).code, "STALE_DOCUMENT_REVISION");
  assert.equal(handlerCalls, beforeCalls, "stale edits must be rejected before the mutation handler");
  assert.equal(pushes, beforePushes);
  assert.equal(guarded.get("prop:views").length, 2);
  await call(argsFor("guarded", { name: "New revision", expectedRevision: documentRevision(docs.get("guarded")) }));
  console.log("PASS: native database views, validation, unnamed counts, serialized writes and stale revision protection");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const doc of docs.values()) doc.destroy();
}
