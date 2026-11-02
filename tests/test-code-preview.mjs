#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";
// Native schema: AFFiNE v0.27.4 blocksuite/affine/model/src/blocks/code/code-model.ts.
// preview is optional, not false by default. Preserve that distinction on the wire.
import assert from "node:assert/strict";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { registerDocTools } from "../dist/tools/docs.js";

const workspaceId = "preview-workspace";
const docId = "preview-document";
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
  socket.send(`0${JSON.stringify({ sid: "preview-engine", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  socket.on("message", message => {
    const packet = String(message);
    if (packet === "2") { socket.send("3"); return; }
    if (packet.startsWith("40")) { socket.send('40{"sid":"preview-socket"}'); return; }
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
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
async function read(id) { return (await call("read_doc")).blocks.find(block => block.id === id); }
async function rejectedWithoutWrite(name, args, pattern) {
  const before = pushes;
  await assert.rejects(call(name, args), pattern);
  assert.equal(pushes, before, "invalid requests must not write content or metadata");
}
try {
  const omitted = await call("append_block", { type: "code", text: "source" });
  assert.equal(blocks.get(omitted.blockId).has("prop:preview"), false);
  assert.equal((await read(omitted.blockId)).preview, null);
  assert.equal((await read(omitted.blockId)).language, "txt");
  assert.equal((await read("paragraph")).preview, null);

  const shown = await call("append_block", { type: "code", language: " HTML ", preview: true, text: "<h1>Diagram</h1>" });
  assert.equal(blocks.get(shown.blockId).get("prop:preview"), true);
  assert.equal((await read(shown.blockId)).preview, true);
  assert.equal((await read(shown.blockId)).language, "html");
  const hidden = await call("append_block", { type: "code", language: "html", preview: false, text: "" });
  assert.equal(blocks.get(hidden.blockId).get("prop:preview"), false);
  assert.equal((await read(hidden.blockId)).preview, false);

  const toggled = await call("update_block", { blockId: shown.blockId, preview: false });
  assert.equal(toggled.blockId, shown.blockId);
  assert.equal(toggled.previous.preview, true);
  assert.equal(toggled.block.preview, false);
  assert.deepEqual(toggled.changed, ["preview"]);
  assert.equal(toggled.block.text, "<h1>Diagram</h1>");
  assert.equal(toggled.block.language, "html");
  assert.equal((await read(shown.blockId)).preview, false);

  const languageOnly = await call("update_block", { blockId: shown.blockId, language: " Mermaid " });
  assert.deepEqual(languageOnly.changed, ["language"]);
  assert.equal(languageOnly.block.language, "mermaid");
  assert.equal(languageOnly.block.preview, false);
  const both = await call("update_block", { blockId: shown.blockId, language: "HTML", preview: true });
  assert.deepEqual(both.changed, ["language", "preview"]);
  assert.equal((await read(shown.blockId)).preview, true);
  assert.equal((await read(shown.blockId)).language, "html");
  const beforeNoop = pushes;
  const noop = await call("update_block", { blockId: shown.blockId, language: " html ", preview: true });
  assert.equal(noop.updated, false);
  assert.deepEqual(noop.changed, []);
  assert.equal(pushes, beforeNoop);

  await call("update_block", { blockId: shown.blockId, text: "new source" });
  assert.equal((await read(shown.blockId)).preview, true);
  assert.equal((await read(shown.blockId)).language, "html");
  await call("update_block", { blockId: omitted.blockId, text: "changed only" });
  assert.equal(blocks.get(omitted.blockId).has("prop:preview"), false);
  await call("update_block", { blockId: omitted.blockId, preview: false });
  assert.equal(blocks.get(omitted.blockId).get("prop:preview"), false);
  await call("update_block", { blockId: omitted.blockId, language: "  " });
  assert.equal((await read(omitted.blockId)).language, "txt");

  await rejectedWithoutWrite("append_block", { type: "paragraph", preview: true }, /preview.*code/);
  for (const args of [{ preview: false }, { language: "html" }, { preview: true, text: "must not change" }]) {
    await rejectedWithoutWrite("update_block", { blockId: "paragraph", ...args }, /code block/);
  }
  assert.equal((await read("paragraph")).text, "keep me");
  for (const name of ["append_block", "update_block"]) {
    const args = name === "append_block" ? { type: "code" } : { blockId: shown.blockId };
    await rejectedWithoutWrite(name, { ...args, preview: "true" }, /boolean/);
    await rejectedWithoutWrite(name, { ...args, preview: null }, /boolean/);
    await rejectedWithoutWrite(name, { ...args, language: "x".repeat(65) }, /max 64/);
  }
  await rejectedWithoutWrite("update_block", { blockId: shown.blockId }, /at least one/);
  await rejectedWithoutWrite("update_block", { blockId: "missing", preview: true }, /not found/);
  await rejectedWithoutWrite("update_block", { blockId: "paragraph", type: "code", preview: true }, /Cannot change/);
  console.log("PASS: native code preview append/update/read, omission, false, no-op, validation and write safety");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const doc of docs.values()) doc.destroy();
}
