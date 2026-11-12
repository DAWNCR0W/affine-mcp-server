#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";
import * as Y from "yjs";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { parseMarkdownToOperations } from "../dist/markdown/parse.js";
import { registerDocTools } from "../dist/tools/docs.js";

// Exercise the real handlers and Yjs update protocol against loopback fixtures.
// AFFiNE derives parentage from sys:children; native sys:parent can remain null.
const workspaceId = "nested-lists-workspace";
const root = new Y.Doc();
root.getMap("meta").set("pages", new Y.Array());
const docs = new Map([[workspaceId, root]]);
let pushes = 0;
let timestamp = 1;
let identityQueries = 0;

function seedDocument(docId) {
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const seed = (id, flavour, children = [], text) => {
    const block = new Y.Map();
    block.set("sys:id", id);
    block.set("sys:flavour", flavour);
    block.set("sys:version", 1);
    block.set("sys:parent", null);
    const childIds = new Y.Array();
    childIds.push(children);
    block.set("sys:children", childIds);
    if (text !== undefined) block.set("prop:text", new Y.Text(text));
    blocks.set(id, block);
    return block;
  };
  seed("page", "affine:page", ["note"]).set("prop:title", new Y.Text("Existing document"));
  seed("note", "affine:note", ["anchor", "tail"]);
  seed("anchor", "affine:paragraph", [], "Before lists");
  seed("tail", "affine:paragraph", [], "Keep this tail");
  const metadata = new Y.Map();
  for (const [key, value] of Object.entries({ id: docId, title: "Existing document", createDate: 1, updatedDate: 1 })) {
    metadata.set(key, value);
  }
  root.getMap("meta").get("pages").push([metadata]);
  docs.set(docId, doc);
  return doc;
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", socket => {
  socket.send(`0${JSON.stringify({ sid: "nested-engine", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  socket.on("message", message => {
    const packet = String(message);
    if (packet === "2") { socket.send("3"); return; }
    if (packet.startsWith("40")) { socket.send('40{"sid":"nested-socket"}'); return; }
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
      if (!docs.has(payload.docId)) docs.set(payload.docId, new Y.Doc());
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
  async request(query) {
    assert.match(query, /currentUser\s*\{\s*id\s*\}/);
    identityQueries++;
    return { currentUser: { id: "nested-list-author" } };
  },
}, { workspaceId });

async function call(name, args = {}) {
  const { definition, handler } = tools.get(name);
  const result = await handler(z.object(definition.inputSchema).parse({ workspaceId, ...args }));
  const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(payload)}`);
  return payload;
}

const markdown = [
  "- Parent **bold**",
  "  1. Ordered *child*",
  "     - [x] Done [link](https://example.com)",
  "     - [ ] Pending `code`",
  "  2. Ordered sibling",
  "- Parent sibling",
  "",
  "After lists.",
].join("\n");
const expectedLists = [
  { text: "Parent bold", style: "bulleted", children: [
    { text: "Ordered child", style: "numbered", children: [
      { text: "Done link", style: "todo", checked: true, children: [] },
      { text: "Pending code", style: "todo", checked: false, children: [] },
    ] },
    { text: "Ordered sibling", style: "numbered", children: [] },
  ] },
  { text: "Parent sibling", style: "bulleted", children: [] },
];

function operationLists(operations) {
  return operations.filter(op => op.type === "list").map(op => ({
    text: op.text,
    style: op.style,
    ...(op.style === "todo" ? { checked: op.checked } : {}),
    children: operationLists(op.children ?? []),
  }));
}

async function assertImportedHierarchy(docId) {
  const blocks = docs.get(docId).getMap("blocks");
  const read = await call("read_doc", { docId });
  const lists = read.blocks.filter(block => block.flavour === "affine:list");
  assert.equal(lists.length, 6, "all six list items must be stored as native list blocks");
  const byText = new Map(lists.map(block => [block.text, block]));
  const first = byText.get("Parent bold");
  const second = byText.get("Parent sibling");
  const ordered = byText.get("Ordered child");
  const orderedSibling = byText.get("Ordered sibling");
  const done = byText.get("Done link");
  const pending = byText.get("Pending code");
  for (const block of [first, second, ordered, orderedSibling, done, pending]) assert.ok(block, "expected list text must survive import");
  const note = read.blocks.find(block => block.id === first.parentId);
  assert.equal(note.flavour, "affine:note");
  assert.equal(second.parentId, note.id, "the next root item must not attach to the previous item's deepest descendant");
  assert.equal(ordered.parentId, first.id);
  assert.equal(orderedSibling.parentId, first.id, "an ordered sibling must remain at its original level");
  assert.equal(done.parentId, ordered.id);
  assert.equal(pending.parentId, ordered.id);
  assert.deepEqual(first.childIds, [ordered.id, orderedSibling.id]);
  assert.deepEqual(ordered.childIds, [done.id, pending.id]);
  for (const block of [second, orderedSibling, done, pending]) assert.deepEqual(block.childIds, []);
  assert.deepEqual([first.type, ordered.type, done.type], ["bulleted", "numbered", "todo"]);
  assert.equal(done.checked, true);
  assert.equal(pending.checked, false);
  const after = read.blocks.find(block => block.text === "After lists.");
  assert.equal(after.parentId, note.id, "following content must resume at the root list's level");
  for (const block of lists) {
    assert.deepEqual(blocks.get(block.id).get("sys:children").toArray(), block.childIds,
      "read_doc parentage must come from the actual stored child arrays");
  }
  const deltas = block => blocks.get(block.id).get("prop:text").toDelta();
  assert.ok(deltas(first).some(delta => delta.insert === "bold" && delta.attributes?.bold === true));
  assert.ok(deltas(ordered).some(delta => delta.insert === "child" && delta.attributes?.italic === true));
  assert.ok(deltas(done).some(delta => delta.insert === "link" && delta.attributes?.link === "https://example.com"));
  assert.ok(deltas(pending).some(delta => delta.insert === "code" && delta.attributes?.code === true));

  const exported = await call("export_doc_markdown", { docId });
  assert.match(exported.markdown, /^- Parent \*\*bold\*\*$/m);
  assert.match(exported.markdown, /^  1\. Ordered \*child\*$/m);
  assert.match(exported.markdown, /^ +[-] \[x\] Done \[link\]\(https:\/\/example\.com\)$/m);
  assert.match(exported.markdown, /^ +[-] \[ \] Pending `code`$/m);
  assert.match(exported.markdown, /^- Parent sibling$/m);
  assert.deepEqual(operationLists(parseMarkdownToOperations(exported.markdown).operations), expectedLists,
    "export must retain enough indentation to re-import grandchildren under an ordered parent");
  return { read, first, second, after, note };
}

async function rejectedWithoutWrite(name, args, pattern) {
  const beforePushes = pushes;
  const beforeQueries = identityQueries;
  const snapshots = new Map([...docs].map(([id, doc]) => [id, Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")]));
  await assert.rejects(call(name, args), pattern);
  assert.equal(pushes, beforePushes, "failed Markdown must not push any content, metadata or creator update");
  assert.equal(identityQueries, beforeQueries, "invalid Markdown must fail before document creation or creator updates");
  assert.deepEqual(new Map([...docs].map(([id, doc]) => [id, Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")])), snapshots);
}

try {
  const created = await call("create_doc_from_markdown", { title: "Nested creation", markdown });
  assert.equal(created.status, "created");
  assert.equal(created.stats.appliedBlocks, 7, "creation counts include list descendants");
  assert.ok(!created.warnings.some(warning => /flatten|depth.*reduc/i.test(warning)));
  await assertImportedHierarchy(created.docId);

  const appendId = "nested-append";
  seedDocument(appendId);
  const appended = await call("append_markdown", { docId: appendId, markdown, placement: { afterBlockId: "anchor" } });
  assert.equal(appended.appendedCount, 7);
  assert.equal(appended.blockIds.length, 7);
  assert.equal(appended.stats.parsedBlocks, 7);
  const appendedTree = await assertImportedHierarchy(appendId);
  assert.deepEqual(appendedTree.note.childIds, ["anchor", appendedTree.first.id, appendedTree.second.id, appendedTree.after.id, "tail"],
    "only root operations advance the placement anchor; descendants cannot capture later root siblings");

  const previousContentIds = appendedTree.read.blocks.filter(block => !["page", "note"].includes(block.id)).map(block => block.id);
  const replaced = await call("replace_doc_with_markdown", { docId: appendId, markdown });
  assert.equal(replaced.stats.appliedBlocks, 7);
  assert.equal(replaced.stats.parsedBlocks, 7);
  assert.equal(replaced.stats.removedBlocks, previousContentIds.length);
  const replacementTree = await assertImportedHierarchy(appendId);
  const replacementBlocks = docs.get(appendId).getMap("blocks");
  for (const id of previousContentIds) assert.equal(replacementBlocks.has(id), false, "replacement removes old nested descendants");
  assert.deepEqual(replacementTree.note.childIds, [replacementTree.first.id, replacementTree.second.id, replacementTree.after.id]);

  // A late invalid operation follows valid nested content: preflight and local
  // materialization must fail before any part of the hierarchy reaches AFFiNE.
  const invalidMarkdown = `${markdown}\n\n\`\`\`${"x".repeat(65)}\ninvalid language\n\`\`\``;
  await rejectedWithoutWrite("create_doc_from_markdown", { title: "Must not be created", markdown: invalidMarkdown }, /language.*64|64.*language/i);
  await rejectedWithoutWrite("append_markdown", { docId: appendId, markdown: invalidMarkdown }, /language.*64|64.*language/i);
  await rejectedWithoutWrite("replace_doc_with_markdown", { docId: appendId, markdown: invalidMarkdown, strict: false }, /language.*64|64.*language/i);
  await rejectedWithoutWrite("append_markdown", { docId: appendId, markdown, placement: { afterBlockId: "missing-anchor" } }, /not found|resolve/i);
  console.log("PASS: nested Markdown create/append/replace, mixed list hierarchy, native rich text, export round-trip, placement and atomic failure safety");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const doc of docs.values()) doc.destroy();
}
