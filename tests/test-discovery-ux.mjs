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
    pageArray.push([entry]);
  }
  meta.set("pages", pageArray);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function emptyWorkspaceRoot() {
  return Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64");
}

async function createRealtimeFixture({ workspaceId = "workspace-ux", rootSnapshot } = {}) {
  let currentRootSnapshot = rootSnapshot;
  const documentSnapshots = new Map();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  wss.on("connection", socket => {
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

  return {
    registry,
    setRootSnapshot(snapshot) {
      currentRootSnapshot = snapshot;
    },
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
  const server = createServer(async (_request, response) => {
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
    async getConnectionAuth() {
      return { endpoint, cookie: "", bearer: "", headers: {} };
    },
  };
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, gql);

  try {
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
await testSearchContinuationAndBrowserUrls();
await testPartialWorkspaceRecoveryReceipt();
console.log("Discovery UX tests passed");
