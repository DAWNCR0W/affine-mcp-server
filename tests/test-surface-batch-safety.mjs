#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { coordinateTool } from "../dist/toolCoordination.js";
import { registerDocTools } from "../dist/tools/docs.js";

// Real handlers, coordination and Yjs deltas; no live AFFiNE or credentials.
const workspaceId = "surface-safety-workspace", docId = "surface-safety-document";
const root = new Y.Doc(), page = new Y.Doc();
const pages = new Y.Array();
pages.push([new Y.Map([["id", docId], ["createDate", 1], ["updatedDate", 1]])]);
root.getMap("meta").set("pages", pages);
const blocks = page.getMap("blocks");
function seedBlock(id, flavour, children = []) {
  const block = new Y.Map();
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  block.set("sys:version", 1);
  block.set("sys:parent", null);
  const array = new Y.Array();
  array.push(children);
  block.set("sys:children", array);
  blocks.set(id, block);
  return block;
}
seedBlock("page", "affine:page", ["surface", "note"]);
const surface = seedBlock("surface", "affine:surface", ["existing-image", "existing-canvas-text"]);
const values = new Y.Map(), wrapper = new Y.Map();
wrapper.set("type", "$blocksuite:internal:native$");
wrapper.set("value", values);
surface.set("prop:elements", wrapper);
seedBlock("note", "affine:note").set("prop:index", "Zz");
seedBlock("existing-image", "affine:image").set("prop:xywh", "[300,0,100,100]");
seedBlock("existing-canvas-text", "affine:edgeless-text").set("prop:xywh", "[500,0,120,60]");
const groupBlockIds = ["note", "existing-image", "existing-canvas-text"];
for (const type of ["frame", "attachment", "bookmark", "latex", "embed-figma", "embed-github", "embed-html",
  "embed-iframe", "embed-linked-doc", "embed-loom", "embed-synced-doc", "embed-youtube"]) {
  const id = `existing-${type}`;
  seedBlock(id, `affine:${type}`);
  groupBlockIds.push(id);
}
seedBlock("non-canvas-paragraph", "affine:paragraph");
const docs = new Map([[workspaceId, root], [docId, page]]);
let pushes = 0, timestamp = 1;
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", socket => {
  socket.send(`0${JSON.stringify({ sid: "surface-engine", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  socket.on("message", message => {
    const packet = String(message);
    if (packet === "2") { socket.send("3"); return; }
    if (packet.startsWith("40")) { socket.send('40{"sid":"surface-socket"}'); return; }
    if (!packet.startsWith("42")) return;
    const start = packet.indexOf("["), ackId = packet.slice(2, start);
    const [event, payload = {}] = JSON.parse(packet.slice(start));
    let ack;
    if (event === "space:join") ack = undefined;
    else if (event === "space:load-doc") {
      const document = docs.get(payload.docId);
      ack = { data: document ? { missing: Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64") } : {} };
    } else if (event === "space:push-doc-update") {
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
  const coordinated = coordinateTool(name, definition.inputSchema, handler, { gql, endpoint, workspaceId });
  tools.set(name, coordinated);
} }, gql, { workspaceId });
const payloadOf = result => result.structuredContent ?? JSON.parse(result.content[0].text);
async function invoke(name, args = {}) {
  const { inputSchema, handler } = tools.get(name);
  return handler(z.object(inputSchema).parse({ workspaceId, docId, ...args }), {});
}
async function call(name, args = {}) {
  const result = await invoke(name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(payloadOf(result))}`);
  return payloadOf(result);
}
const snapshot = () => [...docs].map(([id, doc]) => [id, Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")]);
async function unchanged(action) {
  const before = snapshot(), beforePushes = pushes;
  await action();
  assert.equal(pushes, beforePushes, "rejected writes cannot push content or workspace metadata");
  assert.deepEqual(snapshot(), before, "rejected writes must leave every stored document unchanged");
}
const rejected = (name, args, pattern) => unchanged(() => assert.rejects(invoke(name, args), pattern));
async function stale(name, args) {
  await unchanged(async () => {
    const result = await invoke(name, args);
    assert.equal(result.isError, true);
    assert.equal(payloadOf(result).code, "STALE_DOCUMENT_REVISION");
  });
}

try {
  // Exercise the same wrapper used by index.ts, including actual revision reads.
  for (const name of ["add_surface_elements", "update_surface_elements"]) {
    assert.ok(Object.hasOwn(tools.get(name).inputSchema, "expectedRevision"), `${name} must advertise revision protection`);
  }
  const initialRevision = (await call("read_doc")).revision;
  const batch = await call("add_surface_elements", {
    expectedRevision: initialRevision,
    elements: [{ key: "a", type: "shape", text: "A" }, { key: "b", type: "shape", text: "B" },
      { type: "connector", sourceId: "a", targetId: "b" }],
  });
  const [shapeA, shapeB, connector] = batch.elements;
  const storedConnector = values.get(connector.elementId);
  assert.equal(storedConnector.get("source").id, shapeA.elementId);
  assert.equal(storedConnector.get("target").id, shapeB.elementId);
  await stale("add_surface_elements", { expectedRevision: initialRevision, elements: [{ type: "shape" }] });
  const beforeUpdate = (await call("read_doc")).revision;
  await call("update_surface_elements", { expectedRevision: beforeUpdate, updates: [{ elementId: shapeA.elementId, x: 20 }] });
  await stale("update_surface_elements", { expectedRevision: beforeUpdate, updates: [{ elementId: shapeA.elementId, x: 999 }] });
  assert.equal(JSON.parse(values.get(shapeA.elementId).get("xywh"))[0], 20);

  // All single/batch add/update entry points reject malformed ordering keys.
  for (const index of ["~", "a", "a00", "a0/", "a0é", "a0_"]) {
    await rejected("add_surface_element", { type: "shape", index }, /fractional-index/);
    await rejected("add_surface_elements", { elements: [{ type: "shape" }, { type: "shape", index }] }, /fractional-index/);
    await rejected("update_surface_element", { elementId: shapeA.elementId, index }, /fractional-index/);
    await rejected("update_surface_elements", { updates: [{ elementId: shapeA.elementId, x: 999 }, { elementId: shapeB.elementId, index }] }, /fractional-index/);
  }
  for (const index of ["Zz", "a0", "a0V", "b00", `a00${"z".repeat(32)}`]) {
    const added = await call("add_surface_element", { type: "shape", index });
    assert.equal(values.get(added.elementId).get("index"), index, "valid native and legacy fractional keys must be preserved");
  }
  await call("update_surface_elements", { updates: [{ elementId: shapeA.elementId, index: "a0V" }] });
  const automatic = await call("add_surface_elements", { elements: [{ type: "shape" }] });
  assert.ok(values.get(automatic.elements[0].elementId).get("index") > "b00", "failed malformed inputs cannot poison later automatic allocation");

  // A valid first item cannot leak out when a later endpoint/key is invalid.
  await rejected("add_surface_elements", { elements: [{ key: "new", type: "shape" },
    { type: "connector", sourceId: "new", targetId: "typo" }] }, /targetId.*not found/);
  await rejected("add_surface_element", { type: "connector", sourceId: "typo", targetId: shapeA.elementId }, /sourceId.*not found/);
  await rejected("update_surface_elements", { updates: [{ elementId: shapeA.elementId, x: 999 },
    { elementId: connector.elementId, targetId: "typo" }] }, /targetId.*not found/);
  await rejected("update_surface_element", { elementId: connector.elementId, sourceId: "typo" }, /sourceId.*not found/);
  await rejected("add_surface_elements", { elements: [{ type: "connector", sourceId: "later", targetId: shapeA.elementId },
    { key: "later", type: "shape" }] }, /earlier/);
  await rejected("add_surface_elements", { elements: [{ key: "same", type: "shape" }, { key: "same", type: "shape" }] }, /duplicate/);
  await rejected("update_surface_elements", { updates: [{ elementId: shapeA.elementId, x: 999 },
    { elementId: "missing", x: 1 }] }, /not found/);

  // Native image and edgeless block endpoints are valid, as are absolute points.
  const blockLinks = await call("add_surface_elements", { elements: [
    { type: "connector", sourceId: shapeA.elementId, targetId: "existing-image" },
    { type: "connector", sourceId: "existing-canvas-text", targetId: shapeB.elementId },
    { type: "connector", sourcePosition: [0, 0], targetPosition: [100, 100] },
  ] });
  assert.equal(blockLinks.added, 3);
  await call("update_surface_elements", { updates: [
    { elementId: connector.elementId, sourceId: "existing-image", targetId: "existing-canvas-text" },
  ] });
  assert.equal(values.get(connector.elementId).get("source").id, "existing-image");
  assert.equal(values.get(connector.elementId).get("target").id, "existing-canvas-text");

  // Groups must resolve actual surface/Gfx models, and failures remain atomic.
  const children = [shapeA.elementId, ...groupBlockIds];
  const group = await call("add_surface_element", { type: "group", children });
  assert.deepEqual([...values.get(group.elementId).get("children").keys()], children);
  await rejected("add_surface_element", { type: "group", children: ["typo"] }, /Group child.*not found/);
  await rejected("add_surface_elements", { elements: [{ type: "shape" }, { type: "group", children: ["typo"] }] }, /Group child.*not found/);
  await rejected("update_surface_element", { elementId: group.elementId, children: ["non-canvas-paragraph"] }, /eligible canvas block/);
  await rejected("update_surface_elements", { updates: [{ elementId: shapeA.elementId, x: 999 },
    { elementId: group.elementId, children: ["typo"] }] }, /Group child.*not found/);
  await rejected("update_surface_element", { elementId: group.elementId, children: [group.elementId] }, /itself/);
  const parentGroup = await call("add_surface_element", { type: "group", children: [group.elementId] });
  await rejected("update_surface_elements", { updates: [{ elementId: shapeA.elementId, x: 999 },
    { elementId: group.elementId, children: [parentGroup.elementId] }] }, /cycle/);
  const frameChild = await call("add_surface_element", { type: "group", children: [] });
  blocks.get("existing-frame").set("prop:childElementIds", new Y.Map([[frameChild.elementId, true]]));
  await rejected("update_surface_element", { elementId: frameChild.elementId, children: ["existing-frame"] }, /cycle/);
  blocks.get("existing-frame").set("prop:childElementIds", { [frameChild.elementId]: true });
  await rejected("update_surface_element", { elementId: frameChild.elementId, children: ["existing-frame"] }, /cycle/);
  await call("update_surface_elements", { updates: [{ elementId: group.elementId, children: [shapeB.elementId, "existing-embed-html"] }] });
  assert.deepEqual([...values.get(group.elementId).get("children").keys()], [shapeB.elementId, "existing-embed-html"]);
  await call("update_surface_element", { elementId: group.elementId, children: [] });
  assert.equal(values.get(group.elementId).get("children").size, 0, "empty group membership remains supported");
  const ignoredAdd = await call("add_surface_element", { type: "shape", children: ["typo"] });
  assert.equal(values.get(ignoredAdd.elementId).has("children"), false);
  await unchanged(async () => {
    const ignoredUpdate = await call("update_surface_elements", { updates: [{ elementId: shapeA.elementId, children: ["typo"] }] });
    assert.deepEqual(ignoredUpdate.updates[0].ignored, ["children"]);
    assert.equal(ignoredUpdate.updated, 0, "children remain ignored on non-group updates");
  });

  const labeled = await call("add_surface_element", { type: "connector", sourceId: shapeA.elementId,
    targetId: shapeB.elementId, label: "Manually positioned label" });
  const labelBounds = [411, 222, 130, 27];
  values.get(labeled.elementId).set("labelXYWH", labelBounds); // Simulate an editor drag.
  for (const read of [await call("list_surface_elements", { compact: true }), await call("get_edgeless_canvas", { compact: true })]) {
    const item = (read.elements ?? read.surfaceElements).find(element => element.id === labeled.elementId);
    assert.deepEqual(item.labelXYWH, labelBounds, "compact reads preserve native manually positioned label bounds");
    assert.equal(item.text, "Manually positioned label");
    assert.equal(Object.hasOwn(item, "labelStyle"), false);
    assert.equal(Object.hasOwn(item, "stroke"), false, "compact geometry does not reintroduce style payloads");
  }
  console.log("PASS: surface batch revisions, valid keys, group/connector membership, compact label geometry and atomic rejection");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const doc of docs.values()) doc.destroy();
}
