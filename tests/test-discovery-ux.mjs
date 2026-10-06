#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";

import * as Y from "yjs";
import { WebSocketServer } from "ws";

// ws.js reads this value when it is imported. Keep the forced recovery test fast.
process.env.AFFINE_WS_CONNECT_TIMEOUT_MS = "1000";
process.env.AFFINE_WS_ACK_TIMEOUT_MS = "1000";

const { registerDocTools } = await import("../dist/tools/docs.js");
const { registerWorkspaceTools } = await import("../dist/tools/workspaces.js");
const { registerPropertyTools } = await import("../dist/tools/properties.js");

class ToolRegistry {
  tools = new Map();

  registerTool(name, definition, handler) {
    this.tools.set(name, { definition, handler });
  }
}

function parseResult(result) {
  return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text || "null");
}

function encodeWorkspaceRoot(pages) {
  const doc = new Y.Doc();
  const meta = doc.getMap("meta");
  const pageArray = new Y.Array();
  for (const page of pages) {
    const entry = new Y.Map();
    entry.set("id", page.id);
    entry.set("title", page.title);
    entry.set("createDate", page.createDate ?? 1);
    if (page.updatedDate !== undefined) entry.set("updatedDate", page.updatedDate);
    for (const key of ["trash", "inTrash", "trashDate"]) {
      if (page[key] !== undefined) entry.set(key, page[key]);
    }
    pageArray.push([entry]);
  }
  meta.set("pages", pageArray);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function emptyWorkspaceRoot() {
  return Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64");
}

function encodePropertyRecords(records) {
  const doc = new Y.Doc();
  try {
    for (const [id, values] of Object.entries(records)) {
      for (const [key, value] of Object.entries(values)) doc.getMap(id).set(key, value);
    }
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  } finally { doc.destroy(); }
}

function readPropertyRecords(snapshot) {
  const doc = new Y.Doc();
  try {
    if (snapshot) Y.applyUpdate(doc, Buffer.from(snapshot, "base64"));
    return Object.fromEntries([...doc.share.keys()].map(id => [id, doc.getMap(id).toJSON()]));
  } finally { doc.destroy(); }
}

async function createRealtimeFixture({ workspaceId = "workspace-ux", rootSnapshot } = {}) {
  let currentRootSnapshot = rootSnapshot;
  const documentSnapshots = new Map();
  let pushMode = "success";
  let pushSnapshotOverride;
  let pushCount = 0;
  let connectionCount = 0;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  wss.on("connection", socket => {
    connectionCount += 1;
    socket.send(`0${JSON.stringify({
      sid: "engine-ux",
      upgrades: [],
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxPayload: 1_000_000,
    })}`);

    socket.on("message", message => {
      const packet = String(message);
      if (packet === "2") {
        socket.send("3");
        return;
      }
      if (packet.startsWith("40")) {
        socket.send(`40${JSON.stringify({ sid: "socket-ux" })}`);
        return;
      }
      if (!packet.startsWith("42")) return;

      const dataStart = packet.indexOf("[");
      if (dataStart < 0) return;
      const ackId = packet.slice(2, dataStart);
      const data = JSON.parse(packet.slice(dataStart));
      const event = data[0];
      const payload = data[1] || {};
      if (event === "space:join") {
        socket.send(`43${ackId}[]`);
        return;
      }
      if (event === "space:push-doc-update") {
        pushCount += 1;
        if (pushMode !== "error") {
          const doc = new Y.Doc();
          try {
            const snapshot = payload.docId === workspaceId ? currentRootSnapshot : documentSnapshots.get(payload.docId);
            if (snapshot) Y.applyUpdate(doc, Buffer.from(snapshot, "base64"));
            Y.applyUpdate(doc, Buffer.from(payload.update, "base64"));
            const updated = pushSnapshotOverride ?? Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
            if (payload.docId === workspaceId) currentRootSnapshot = updated;
            else documentSnapshots.set(payload.docId, updated);
          } finally { doc.destroy(); }
        }
        const ack = pushMode === "success"
          ? { data: { timestamp: 2 } }
          : { error: { name: "SYNC_FAILED", message: "journal write acknowledgement failed" } };
        socket.send(`43${ackId}${JSON.stringify([ack])}`);
        return;
      }
      if (event !== "space:load-doc") return;

      const snapshot = payload.docId === workspaceId
        ? currentRootSnapshot
        : documentSnapshots.get(payload.docId);
      const loaded = snapshot === undefined ? {} : { missing: snapshot };
      socket.send(`43${ackId}${JSON.stringify([{ data: loaded }])}`);
    });
  });

  await new Promise((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const endpoint = `http://127.0.0.1:${port}/api/graphql`;
  const gql = {
    endpoint,
    baseUrl: "https://affine.example/custom-base",
    async getConnectionAuth() {
      return { endpoint, cookie: "", bearer: "", headers: {} };
    },
  };
  const registry = new ToolRegistry();
  registerDocTools(registry, gql, { workspaceId });
  registerPropertyTools(registry, gql, { workspaceId });

  return {
    registry,
    setRootSnapshot(snapshot) {
      currentRootSnapshot = snapshot;
    },
    setDocumentSnapshot(docId, snapshot) {
      documentSnapshots.set(docId, snapshot);
    },
    documentSnapshot(docId) {
      return documentSnapshots.get(docId);
    },
    setPushMode(mode) {
      pushMode = mode;
    },
    setPushSnapshotOverride(snapshot) {
      pushSnapshotOverride = snapshot;
    },
    get pushCount() { return pushCount; },
    get connectionCount() { return connectionCount; },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}

async function testMissingAndEmptyWorkspaceRoots() {
  const fixture = await createRealtimeFixture();
  const affected = [
    ["list_tags", { workspaceId: "workspace-ux" }],
    ["search_docs", { workspaceId: "workspace-ux", query: "Task" }],
    ["find_doc_by_title", { workspaceId: "workspace-ux", title: "Task" }],
    ["list_docs_by_tag", { workspaceId: "workspace-ux", tag: "urgent" }],
    ["list_workspace_tree", { workspaceId: "workspace-ux" }],
    ["get_orphan_docs", { workspaceId: "workspace-ux" }],
    ["list_children", { workspaceId: "workspace-ux", docId: "doc-1" }],
  ];

  try {
    for (const [name, args] of affected) {
      await assert.rejects(
        fixture.registry.tools.get(name).handler(args),
        error => error?.code === "workspace_root_unavailable",
        `${name} must fail closed when the workspace root is absent`,
      );
    }

    const emptyRoot = emptyWorkspaceRoot();
    assert.equal(typeof emptyRoot, "string");
    fixture.setRootSnapshot(emptyRoot);
    const emptyResults = [
      ["list_tags", { workspaceId: "workspace-ux" }, result => result.totalTags === 0 && result.tags.length === 0],
      ["search_docs", { workspaceId: "workspace-ux", query: "Task" }, result => result.totalCount === 0 && result.results.length === 0 && result.hasMore === false],
      ["find_doc_by_title", { workspaceId: "workspace-ux", title: "Task" }, result => result.workspaceDocCount === 0 && result.matches.length === 0],
      ["list_docs_by_tag", { workspaceId: "workspace-ux", tag: "urgent" }, result => result.totalDocs === 0 && result.docs.length === 0],
      ["list_workspace_tree", { workspaceId: "workspace-ux" }, result => result.totalDocs === 0 && result.tree.length === 0],
      ["get_orphan_docs", { workspaceId: "workspace-ux" }, result => result.count === 0 && result.orphans.length === 0],
      ["list_children", { workspaceId: "workspace-ux", docId: "doc-1" }, result => result.children.length === 0],
    ];
    for (const [name, args, isEmpty] of emptyResults) {
      const result = parseResult(await fixture.registry.tools.get(name).handler(args));
      assert.equal(isEmpty(result), true, `${name} must preserve a genuinely empty root as an empty result`);
    }
  } finally {
    await fixture.close();
  }
}

async function testUpdateDocTitleRejectsMissingDoc() {
  const fixture = await createRealtimeFixture({
    rootSnapshot: encodeWorkspaceRoot([{ id: "doc-1", title: "Task" }]),
  });
  try {
    await assert.rejects(
      fixture.registry.tools.get("update_doc_title").handler({
        workspaceId: "workspace-ux",
        docId: "ghost",
        title: "Renamed",
      }),
      /Document ghost is not present in workspace workspace-ux/,
      "update_doc_title must not report success for a doc that does not exist",
    );
  } finally {
    await fixture.close();
  }
}

async function testDocPropertyToolsRejectMissingDoc() {
  const fixture = await createRealtimeFixture({
    rootSnapshot: encodeWorkspaceRoot([{ id: "doc-1", title: "Task" }]),
  });
  try {
    for (const [name, args] of [
      ["list_doc_properties", { workspaceId: "workspace-ux", docId: "ghost" }],
      ["clear_doc_property", { workspaceId: "workspace-ux", docId: "ghost", property: "Status" }],
    ]) {
      await assert.rejects(
        fixture.registry.tools.get(name).handler(args),
        /docId ghost is not present in workspace workspace-ux/,
        `${name} must reject a doc that does not exist`,
      );
    }
  } finally {
    await fixture.close();
  }
}

async function testCheckboxPropertyRejectsUnrecognizedValues() {
  const fixture = await createRealtimeFixture({
    rootSnapshot: encodeWorkspaceRoot([{ id: "doc-1", title: "Task" }]),
  });
  const info = new Y.Doc();
  const definition = info.getMap("prop-done");
  definition.set("id", "prop-done");
  definition.set("name", "Done");
  definition.set("type", "checkbox");
  fixture.setDocumentSnapshot(
    "db$workspace-ux$docCustomPropertyInfo",
    Buffer.from(Y.encodeStateAsUpdate(info)).toString("base64"),
  );
  try {
    await assert.rejects(
      fixture.registry.tools.get("set_doc_property").handler({
        workspaceId: "workspace-ux",
        docId: "doc-1",
        property: "Done",
        value: "on",
      }),
      /checkbox property requires true or false, got "on"/,
      "an unrecognized checkbox value must not be stored as false",
    );
  } finally {
    await fixture.close();
  }
}

async function testNativeJournalRoundTrip() {
  const fixture = await createRealtimeFixture({
    rootSnapshot: encodeWorkspaceRoot([{ id: "doc-1", title: "Task" }]),
  });
  const propertiesId = "db$workspace-ux$docProperties";
  const original = {
    "doc-1": { id: "doc-1", createdBy: "creator", icon: "😀", customJournal: "2025-01-05", "custom:journal-custom": "2025-01-02" },
    "other-doc": { id: "other-doc", journal: "2025-01-03" },
  };
  fixture.setDocumentSnapshot(propertiesId, encodePropertyRecords(original));
  fixture.setDocumentSnapshot("db$docProperties", encodePropertyRecords({ "doc-1": { journal: "2025-01-04" } }));
  try {
    const { definition, handler } = fixture.registry.tools.get("set_doc_journal");
    assert.equal(definition.inputSchema.date.safeParse(null).success, true);
    assert.equal(definition.inputSchema.date.safeParse(undefined).success, false);
    const set = parseResult(await handler({ docId: "doc-1", date: " 2026-10-06 " }));
    assert.deepEqual(set, { workspaceId: "workspace-ux", docId: "doc-1", date: "2026-10-06", updated: true });
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), {
      ...original, "doc-1": { ...original["doc-1"], journal: "2026-10-06" },
    });
    const pushes = fixture.pushCount;
    assert.equal(parseResult(await handler({ docId: "doc-1", date: "2026-10-06" })).updated, false);
    assert.equal(fixture.pushCount, pushes, "setting the same journal date must not push");

    assert.equal(parseResult(await handler({ docId: "doc-1", date: "2024-02-29" })).updated, true);
    assert.equal(readPropertyRecords(fixture.documentSnapshot(propertiesId))["doc-1"].journal, "2024-02-29");
    assert.deepEqual(parseResult(await handler({ docId: "doc-1", date: null })), {
      workspaceId: "workspace-ux", docId: "doc-1", date: null, updated: true,
    });
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), original, "clearing must preserve every unrelated property and record");
    const clearPushes = fixture.pushCount;
    assert.equal(parseResult(await handler({ docId: "doc-1", date: null })).updated, false);
    assert.equal(fixture.pushCount, clearPushes, "clearing an absent journal date must not push");
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot("db$docProperties")), { "doc-1": { journal: "2025-01-04" } }, "native journal writes must not migrate retained legacy properties");

    fixture.setDocumentSnapshot(propertiesId, encodePropertyRecords({ "other-doc": original["other-doc"] }));
    const absentPushes = fixture.pushCount;
    assert.equal(parseResult(await handler({ docId: "doc-1", date: null })).updated, false);
    assert.equal(fixture.pushCount, absentPushes);
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), { "other-doc": original["other-doc"] }, "clear must not create a document property record");
    assert.equal(parseResult(await handler({ docId: "doc-1", date: "2026-10-06" })).updated, true);
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), {
      "other-doc": original["other-doc"], "doc-1": { id: "doc-1", journal: "2026-10-06" },
    }, "set must create the native record id when the record is absent");
    for (const idFields of [{}, { id: "" }, { id: "   " }]) {
      fixture.setDocumentSnapshot(propertiesId, encodePropertyRecords({ "doc-1": { ...idFields, journal: "2026-10-06", createdBy: "creator" } }));
      assert.equal(parseResult(await handler({ docId: "doc-1", date: "2026-10-06" })).updated, true);
      assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), {
        "doc-1": { id: "doc-1", journal: "2026-10-06", createdBy: "creator" },
      }, "set must repair missing or empty ids without losing other fields");
    }
  } finally { await fixture.close(); }
}

async function testNativeJournalFailsClosed() {
  const fixture = await createRealtimeFixture({
    rootSnapshot: encodeWorkspaceRoot([{ id: "doc-1", title: "Task" }]),
  });
  const propertiesId = "db$workspace-ux$docProperties";
  try {
    const handler = fixture.registry.tools.get("set_doc_journal").handler;
    for (const date of ["not-a-date", "2026-1-02", "2026-02-30", "2026-02-29", "2026-04-31", "2026-10-06T00:00:00Z"]) {
      await assert.rejects(handler({ docId: "doc-1", date }), /date|YYYY-MM-DD/i);
    }
    assert.equal(fixture.connectionCount, 0, "invalid dates must fail before connecting");
    assert.equal(fixture.pushCount, 0);

    for (const docId of ["ghost", "workspace-ux"]) {
      await assert.rejects(handler({ docId, date: "2026-10-06" }));
    }
    for (const flags of [{ trash: true }, { inTrash: true }, { trash: false, inTrash: true }, { trashDate: 1 }]) {
      fixture.setRootSnapshot(encodeWorkspaceRoot([{ id: "doc-1", title: "Task", ...flags }]));
      await assert.rejects(handler({ docId: "doc-1", date: "2026-10-06" }));
    }
    fixture.setRootSnapshot(undefined);
    await assert.rejects(handler({ docId: "doc-1", date: "2026-10-06" }));
    fixture.setRootSnapshot(emptyWorkspaceRoot());
    await assert.rejects(handler({ docId: "doc-1", date: "2026-10-06" }));
    fixture.setRootSnapshot(encodeWorkspaceRoot([{ id: "doc-1", title: "Task" }]));
    for (const record of [{ id: "different-doc", journal: "2025-01-02" }, { id: "doc-1", "$$DELETED": true, journal: "2025-01-02" }]) {
      fixture.setDocumentSnapshot(propertiesId, encodePropertyRecords({ "doc-1": record }));
      for (const date of ["2026-10-06", null]) {
        await assert.rejects(handler({ docId: "doc-1", date }));
        assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), { "doc-1": record });
      }
    }
    assert.equal(fixture.pushCount, 0, "invalid document or property metadata must not be written");

    fixture.setDocumentSnapshot(propertiesId, encodePropertyRecords({ "doc-1": { id: "doc-1" } }));
    fixture.setRootSnapshot(encodeWorkspaceRoot([{ id: "doc-1", title: "Task", trash: true, inTrash: false }]));
    assert.equal(parseResult(await handler({ docId: "doc-1", date: "2026-10-06" })).updated, true, "explicit inTrash=false must take precedence over trash=true");
  } finally { await fixture.close(); }
}

async function testNativeJournalWriteAcknowledgements() {
  const fixture = await createRealtimeFixture({
    rootSnapshot: encodeWorkspaceRoot([{ id: "doc-1", title: "Task" }]),
  });
  const propertiesId = "db$workspace-ux$docProperties";
  const original = { "doc-1": { id: "doc-1", createdBy: "creator", "custom:journal-custom": "2025-01-02" } };
  fixture.setDocumentSnapshot(propertiesId, encodePropertyRecords(original));
  try {
    const handler = fixture.registry.tools.get("set_doc_journal").handler;
    fixture.setPushMode("error");
    await assert.rejects(handler({ docId: "doc-1", date: "2026-10-06" }), error => error?.code === "doc_journal_write_failed");
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), original);

    fixture.setPushMode("persist-error");
    const recovered = parseResult(await handler({ docId: "doc-1", date: "2026-10-06" }));
    assert.deepEqual(recovered, { workspaceId: "workspace-ux", docId: "doc-1", date: "2026-10-06", updated: true });
    assert.equal(fixture.pushCount, 2, "readback recovery must not blindly retry an uncertain write");
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), {
      "doc-1": { ...original["doc-1"], journal: "2026-10-06" },
    });
    fixture.setPushMode("error");
    await assert.rejects(handler({ docId: "doc-1", date: null }), error => error?.code === "doc_journal_write_failed");
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), {
      "doc-1": { ...original["doc-1"], journal: "2026-10-06" },
    }, "a failed clear must preserve the persisted journal date");
    fixture.setPushMode("persist-error");
    assert.equal(parseResult(await handler({ docId: "doc-1", date: null })).updated, true, "a persisted clear with failed acknowledgement must be verified by readback");
    assert.deepEqual(readPropertyRecords(fixture.documentSnapshot(propertiesId)), original);
    fixture.setPushSnapshotOverride(encodePropertyRecords({
      "doc-1": { ...original["doc-1"], id: "different-doc", journal: "2026-10-06" },
    }));
    await assert.rejects(handler({ docId: "doc-1", date: "2026-10-06" }), error => error?.code === "doc_journal_write_failed", "the requested journal date with a conflicting id must not confirm an uncertain write");
  } finally { await fixture.close(); }
}

async function testSearchContinuationAndBrowserUrls() {
  const pages = Array.from({ length: 205 }, (_, index) => ({
    id: `doc-${String(index).padStart(3, "0")}`,
    title: `Task ${String(index).padStart(3, "0")}`,
    createDate: index + 1,
    updatedDate: index + 1,
  }));
  const fixture = await createRealtimeFixture({ rootSnapshot: encodeWorkspaceRoot(pages) });
  try {
    const handler = fixture.registry.tools.get("search_docs").handler;
    const first = parseResult(await handler({ workspaceId: "workspace-ux", query: "Task", limit: 200, offset: 0 }));
    const second = parseResult(await handler({ workspaceId: "workspace-ux", query: "Task", limit: 200, offset: 200 }));
    const combined = [...first.results, ...second.results];
    const ids = combined.map(result => result.docId);

    assert.equal(first.totalCount, 205);
    assert.equal(first.limit, 200);
    assert.equal(first.results.length, 200);
    assert.equal(first.hasMore, true);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 200);
    assert.equal(second.results.length, 5);
    assert.equal(second.hasMore, false);
    assert.equal(second.truncated, false);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set(ids).size, 205, "paged search results must not duplicate documents");
    assert.equal(new Set(ids).size, ids.length, "continuation pages must be disjoint");
    assert.ok(first.results.every(result => result.url.startsWith("https://affine.example/custom-base/workspace/")));
    assert.ok(first.results.every(result => !result.url.includes("/api/graphql")));
  } finally {
    await fixture.close();
  }
}

async function testPartialWorkspaceRecoveryReceipt() {
  let createRequests = 0;
  let currentUser = null;
  const server = createServer(async (_request, response) => {
    createRequests += 1;
    for await (const _chunk of _request) {
      // Consume the multipart request before returning the GraphQL result.
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      data: {
        createWorkspace: {
          id: "workspace-created",
          public: false,
          enableAi: false,
          createdAt: "2026-09-11T00:00:00.000Z",
        },
      },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const endpoint = `http://127.0.0.1:${port}/api/graphql`;
  const gql = {
    endpoint,
    baseUrl: "https://affine.example/custom-base",
    async request(query) {
      assert.match(query, /currentUser/);
      return { currentUser };
    },
    async getConnectionAuth() {
      return { endpoint, cookie: "", bearer: "", headers: {} };
    },
  };
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, gql);

  try {
    const unidentified = await registry.tools.get("create_workspace").handler({ name: "No identity" });
    assert.equal(unidentified.isError, true, "missing creator identity must fail before workspace creation");
    assert.equal(createRequests, 0, "identity lookup failure must not create a workspace");
    currentUser = { id: "workspace-creator" };
    const result = await registry.tools.get("create_workspace").handler({ name: "UX recovery" });
    const receipt = parseResult(result);
    assert.equal(result.isError, undefined, "partial workspace creation must remain an OK receipt");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.syncStatus, "partial");
    assert.equal(receipt.id, "workspace-created");
    assert.equal(receipt.workspaceId, "workspace-created");
    assert.equal(typeof receipt.firstDocId, "string");
    assert.equal(receipt.requiresManualRepair, true);
    assert.match(receipt.message, /No automatic retry is scheduled/i);
    assert.match(receipt.recoveryGuidance, /read workspace .*document .* before/i);
    assert.match(receipt.recoveryGuidance, /timed-out write may have persisted/i);
    assert.match(receipt.recoveryGuidance, /do not call create_workspace again/i);
    assert.match(receipt.url, /https:\/\/affine\.example\/custom-base\/workspace\/workspace-created/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

await testMissingAndEmptyWorkspaceRoots();
await testUpdateDocTitleRejectsMissingDoc();
await testDocPropertyToolsRejectMissingDoc();
await testCheckboxPropertyRejectsUnrecognizedValues();
await testNativeJournalRoundTrip();
await testNativeJournalFailsClosed();
await testNativeJournalWriteAcknowledgements();
await testSearchContinuationAndBrowserUrls();
await testPartialWorkspaceRecoveryReceipt();
console.log("Discovery UX tests passed");
