#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";
// Native mindmap children own shapes; connectors may reference any deleted ID.
import assert from "node:assert/strict";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { registerDocTools } from "../dist/tools/docs.js";
import { toolOutputSchemaFor } from "../dist/toolOutputSchemas.js";

const workspaceId = "cascade-workspace";
const docId = "cascade-document";
const root = new Y.Doc();
const pages = new Y.Array();
const pageEntry = new Y.Map();
pageEntry.set("id", docId);
pageEntry.set("title", "Preview fixture");
pageEntry.set("createDate", 1);
pageEntry.set("updatedDate", 1);
pages.push([pageEntry]);
root.getMap("meta").set("pages", pages);
const page = new Y.Doc();
const blocks = page.getMap("blocks");
function seedBlock(id, flavour, children = []) {
  const block = new Y.Map();
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  block.set("sys:version", 1);
  const array = new Y.Array();
  array.push(children);
  block.set("sys:children", array);
  blocks.set(id, block);
  return block;
}
seedBlock("page", "affine:page", ["note"]).set("prop:title", new Y.Text("Preview fixture"));
seedBlock("note", "affine:note", ["paragraph"]);
seedBlock("paragraph", "affine:paragraph").set("prop:text", new Y.Text("keep me"));
let pushes = 0;
let timestamp = 1;
const docs = new Map([[workspaceId, root], [docId, page]]);
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", socket => {
  socket.send(`0${JSON.stringify({ sid: "cascade-engine", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  socket.on("message", message => {
    const packet = String(message);
    if (packet === "2") { socket.send("3"); return; }
    if (packet.startsWith("40")) { socket.send('40{"sid":"cascade-socket"}'); return; }
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
      pushes++;
      Y.applyUpdate(docs.get(payload.docId), Buffer.from(payload.update, "base64"));
      ack = { data: { timestamp: ++timestamp } };
    } else throw new Error(`Unexpected event ${event}`);
    socket.send(`43${ackId}${JSON.stringify(ack === undefined ? [] : [ack])}`);
  });
});
await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
const tools = new Map();
registerDocTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } }, {
  async getConnectionAuth() { return { endpoint: `http://127.0.0.1:${wss.address().port}/graphql` }; },
}, { workspaceId });
async function call(name, args = {}) {
  const { definition, handler } = tools.get(name);
  const result = await handler(z.object(definition.inputSchema).parse({ workspaceId, docId, ...args }));
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
async function read(id) { return (await call("read_doc")).blocks.find(block => block.id === id); }
async function rejectedWithoutWrite(name, args, pattern) {
  const before = pushes;
  await assert.rejects(call(name, args), pattern);
  assert.equal(pushes, before, "invalid requests must not write content or metadata");
}
try {
  const map = await call("create_mindmap", { text: "Root" });
  const child = await call("add_mindmap_node", { mindmapId: map.mindmapId, parentId: map.rootId, text: "Child" });
  const grandchild = await call("add_mindmap_node", { mindmapId: map.mindmapId, parentId: child.nodeId, text: "Grandchild" });
  const a = await call("add_surface_element", { type: "shape", text: "Outside A" });
  const b = await call("add_surface_element", { type: "shape", text: "Outside B" });
  const connector = (sourceId, targetId) => call("add_surface_element", { type: "connector", sourceId, targetId });
  const toRoot = await connector(a.elementId, map.rootId);
  const fromNode = await connector(child.nodeId, b.elementId);
  const toGrandchild = await connector(a.elementId, grandchild.nodeId);
  const toMap = await connector(a.elementId, map.mindmapId);
  const unrelated = await connector(a.elementId, b.elementId);
  const points = await call("add_surface_element", { type: "connector", sourcePosition: [0, 0], targetPosition: [1, 1] });
  const surface = [...blocks.values()].find(block => block.get("sys:flavour") === "affine:surface");
  const values = surface.get("prop:elements").get("value");
  // Native snapshots can store endpoint records as Y.Maps as well as objects.
  const target = values.get(toGrandchild.elementId).get("target");
  values.get(toGrandchild.elementId).set("target", new Y.Map(Object.entries(target)));
  const { blockId: frameId } = await call("append_block", { type: "frame", text: "Owner" });
  const removedIds = [map.mindmapId, map.rootId, child.nodeId, grandchild.nodeId, toRoot.elementId, fromNode.elementId, toGrandchild.elementId, toMap.elementId];
  const keptIds = [a.elementId, b.elementId, unrelated.elementId, points.elementId];
  await call("update_frame_children", { blockId: frameId, childElementIds: [...removedIds, ...keptIds] });
  const removed = await call("delete_surface_element", { elementId: map.mindmapId, pruneConnectors: true });
  assert.equal(removed.deleted, true);
  assert.deepEqual([...removed.deletedNodes].sort(), [map.rootId, child.nodeId, grandchild.nodeId].sort());
  assert.deepEqual([...removed.prunedConnectors].sort(), [toRoot.elementId, fromNode.elementId, toGrandchild.elementId, toMap.elementId].sort());
  for (const id of removedIds) assert.equal(values.has(id), false, `deleted element must be absent: ${id}`);
  for (const id of keptIds) assert.equal(values.has(id), true, `unrelated element must survive: ${id}`);
  const owners = blocks.get(frameId).get("prop:childElementIds");
  assert.deepEqual([...owners.keys()].sort(), keptIds.sort(), "frame ownership removes exactly the deleted IDs");
  const output = toolOutputSchemaFor("delete_surface_element");
  assert.ok(output.safeParse(removed).success);
  assert.equal(output.safeParse({ ...removed, deletedNodes: [42] }).success, false);
  const beforeMissing = pushes;
  const missing = await call("delete_surface_element", { elementId: map.mindmapId, pruneConnectors: true });
  assert.equal(missing.deleted, false);
  assert.equal(pushes, beforeMissing);
  assert.ok(output.safeParse(missing).success, "non-deletion results need not report deletedNodes");

  const noPrune = await call("create_mindmap", { text: "Keep connectors" });
  const left = await connector(noPrune.rootId, a.elementId);
  const withoutPruning = await call("delete_surface_element", { elementId: noPrune.mindmapId, pruneConnectors: false });
  assert.deepEqual(withoutPruning.prunedConnectors, []);
  assert.equal(values.has(noPrune.rootId), false);
  assert.equal(values.has(left.elementId), true, "connector pruning remains opt-in");

  // Invalid mindmap topology must not delete shapes it cannot safely own.
  const malformed = new Y.Map([["id", "malformed"], ["type", "mindmap"], ["layoutType", 0], ["children", new Y.Map([[a.elementId, {}]])]]);
  values.set("malformed", malformed);
  const boundMalformed = await connector("malformed", b.elementId);
  const preserveOutside = await connector(a.elementId, b.elementId);
  const malformedResult = await call("delete_surface_element", { elementId: "malformed", pruneConnectors: true });
  assert.deepEqual(malformedResult.deletedNodes, []);
  assert.deepEqual(malformedResult.prunedConnectors, [boundMalformed.elementId]);
  assert.equal(values.has(a.elementId), true);
  assert.equal(values.has(preserveOutside.elementId), true);
  const plain = await call("delete_surface_element", { elementId: b.elementId });
  assert.deepEqual(plain.deletedNodes, []);
  console.log("PASS: mindmap cascade connector pruning, endpoint representations, frame cleanup, opt-in behavior, malformed-map safety and output schema");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  root.destroy(); page.destroy();
}
