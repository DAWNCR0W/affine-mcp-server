#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { pushDocUpdate, pushPageDocUpdate } from "../dist/ws.js";
import { ToolFailure, withToolErrors } from "../dist/util/mcp.js";

import {
  buildWorkspaceListDocsFallbackConnection,
  collectLinkedChildIds,
  documentMoveToolResult,
  documentCreationToolResult,
  filterWorkspaceListDocsConnection,
  isWorkspaceListDocsPermissionDenied,
  parentLinkWarningOrThrow,
  requestListDocsWithPublicFallback,
  removeEmbeddedLinkedDocumentBlocks,
  registerDocTools,
} from "../dist/tools/docs.js";

import {
  DocumentCreationError,
  executeSafeDocumentMove,
  handleMarkdownOperationFailure,
  isDocumentMoveSuccessful,
  toDocumentMoveResult,
} from "../dist/util/mutationSafety.js";
import { docPropertiesDocId } from "../dist/util/docCreator.js";

{
  const partialPageWrite = new ToolFailure(
    "Page content was saved but its updatedDate could not be confirmed.",
    "workspace_page_updated_date_failed",
  );
  assert.throws(
    () => parentLinkWarningOrThrow(partialPageWrite, "ordinary link warning"),
    error => error === partialPageWrite,
    "parent-link handlers must propagate partial page timestamp failures",
  );
  assert.equal(
    parentLinkWarningOrThrow(new Error("ordinary link failure"), "ordinary link warning"),
    "ordinary link warning",
    "parent-link handlers keep their existing warning fallback for other failures",
  );
}

function workspaceRootWithPages(pages) {
  const doc = new Y.Doc();
  const pageEntries = new Y.Array();
  for (const { id, updatedDate } of pages) {
    const entry = new Y.Map();
    entry.set("id", id);
    entry.set("createDate", updatedDate);
    if (updatedDate !== undefined) entry.set("updatedDate", updatedDate);
    pageEntries.push([entry]);
  }
  doc.getMap("meta").set("pages", pageEntries);
  return doc;
}

function makeUpdateSocket({ workspaceId, root, pageTimestamp = 100, rootMode = "success", rootReadBarrier = 0, rootUnavailable = false } = {}) {
  const pushes = [];
  let rootReads = 0;
  let rootPushes = 0;
  let releaseRootReads;
  const rootReadsReady = new Promise(resolve => { releaseRootReads = resolve; });
  const socket = {
    emit(event, payload, acknowledge) {
      if (event === "space:load-doc") {
        assert.equal(payload.docId, workspaceId, "page timestamp sync reads only the workspace root");
        if (rootUnavailable) {
          rootReads += 1;
          acknowledge({ error: { message: "workspace root unavailable" } });
          return;
        }
        const snapshot = Buffer.from(Y.encodeStateAsUpdate(root)).toString("base64");
        if (rootReadBarrier > 0 && rootReads < rootReadBarrier) {
          rootReads += 1;
          if (rootReads === rootReadBarrier) releaseRootReads();
          void rootReadsReady.then(() => acknowledge({ data: { missing: snapshot } }));
          return;
        }
        rootReads += 1;
        acknowledge({ data: { missing: snapshot } });
        return;
      }

      assert.equal(event, "space:push-doc-update");
      pushes.push({ docId: payload.docId, update: payload.update });
      if (payload.docId !== workspaceId) {
        if (pageTimestamp instanceof Error) {
          acknowledge({ error: { message: pageTimestamp.message } });
          return;
        }
        acknowledge({ data: { timestamp: pageTimestamp } });
        return;
      }

      rootPushes += 1;
      if (rootMode === "fail") {
        acknowledge({ error: { message: "workspace root write failed" } });
        return;
      }
      Y.applyUpdate(root, Buffer.from(payload.update, "base64"));
      if (rootMode === "ack-lost" && rootPushes === 1) {
        acknowledge({ error: { message: "workspace root acknowledgement timed out" } });
        return;
      }
      acknowledge({ data: { timestamp: pageTimestamp } });
    },
  };

  return { socket, pushes, get rootReads() { return rootReads; }, get rootPushes() { return rootPushes; } };
}

function pageDates(root) {
  const pages = root.getMap("meta").get("pages");
  return new Map([...pages].map(page => [page.get("id"), page.get("updatedDate")]));
}

function changedDocumentUpdate() {
  const doc = new Y.Doc();
  doc.getMap("blocks").set("paragraph", "updated");
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

{
  const workspaceId = "workspace-updated-date";
  const root = workspaceRootWithPages([
    { id: "page-updated", updatedDate: 10 },
    { id: "page-untouched", updatedDate: 15 },
  ]);
  const transport = makeUpdateSocket({ workspaceId, root, pageTimestamp: 20 });
  const returnedTimestamp = await pushPageDocUpdate(transport.socket, workspaceId, "page-updated", changedDocumentUpdate());
  assert.equal(returnedTimestamp, 20, "page writes preserve the server acknowledgement timestamp");
  assert.deepEqual(pageDates(root), new Map([
    ["page-updated", 20],
    ["page-untouched", 15],
  ]), "only the matching workspace page entry receives updatedDate");
  assert.equal(transport.rootPushes, 1);

  const rootUpdate = changedDocumentUpdate();
  const rootPushesBefore = transport.rootPushes;
  await pushDocUpdate(transport.socket, workspaceId, workspaceId, rootUpdate);
  assert.equal(transport.rootPushes, rootPushesBefore + 1, "workspace-root writes do not recurse");

  const internal = await pushDocUpdate(
    transport.socket,
    workspaceId,
    "internal-properties-doc",
    changedDocumentUpdate(),
  );
  assert.equal(internal, 20);
  assert.equal(transport.rootPushes, rootPushesBefore + 1, "unregistered internal docs do not change page metadata");
  assert.equal(pageDates(root).get("page-updated"), 20);
  root.destroy();
}

{
  const workspaceId = "workspace-updated-date-internal-root-unavailable";
  const root = workspaceRootWithPages([{ id: "page-1", updatedDate: 10 }]);
  for (const docId of ["internal-properties-doc", "new-page-before-registration", "page-1"]) {
    const transport = makeUpdateSocket({ workspaceId, root, rootUnavailable: true });
    const returnedTimestamp = await pushDocUpdate(
      transport.socket,
      workspaceId,
      docId,
      changedDocumentUpdate(),
    );
    assert.equal(returnedTimestamp, 100, `${docId} writes preserve their ACK when root metadata is unavailable`);
    assert.equal(transport.rootReads, 0, `${docId} raw writes never load workspace-root metadata`);
    assert.equal(transport.rootPushes, 0);
  }
  root.destroy();
}

{
  const workspaceId = "workspace-updated-date-noop";
  const root = workspaceRootWithPages([{ id: "page-1", updatedDate: 10 }]);
  const transport = makeUpdateSocket({ workspaceId, root, pageTimestamp: 20 });
  const noOpDoc = new Y.Doc();
  await pushPageDocUpdate(
    transport.socket,
    workspaceId,
    "page-1",
    Buffer.from(Y.encodeStateAsUpdate(noOpDoc)).toString("base64"),
  );
  assert.equal(transport.pushes.length, 1, "the original page update still receives its transport ACK");
  assert.equal(transport.rootPushes, 0, "an empty Yjs update does not advance updatedDate");
  assert.equal(pageDates(root).get("page-1"), 10);
  noOpDoc.destroy();
  root.destroy();
}

{
  const workspaceId = "workspace-unregistered-page";
  const root = workspaceRootWithPages([]);
  const transport = makeUpdateSocket({ workspaceId, root });
  const handler = withToolErrors(
    () => pushPageDocUpdate(transport.socket, workspaceId, "orphan", changedDocumentUpdate()),
    { toolName: "append_block", authMode: "bearer", readOnly: false },
  );
  const failure = await handler();
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.code, "workspace_page_updated_date_failed");
  assert.equal(failure.structuredContent.retryable, false);
  assert.match(failure.structuredContent.error, /not registered/);
  assert.equal(transport.pushes.length, 1, "a saved orphan is never replayed or silently registered");
  assert.equal(transport.rootPushes, 0);
  assert.equal(pageDates(root).size, 0);
  root.destroy();
}

for (const invalidTimestamp of [0, -1]) {
  const workspaceId = `workspace-updated-date-invalid-ack-${invalidTimestamp}`;
  const root = workspaceRootWithPages([{ id: "page-1", updatedDate: 10 }]);
  const transport = makeUpdateSocket({ workspaceId, root, pageTimestamp: invalidTimestamp });
  const returnedTimestamp = await pushPageDocUpdate(
    transport.socket,
    workspaceId,
    "page-1",
    changedDocumentUpdate(),
  );
  assert.ok(returnedTimestamp > 0, `an invalid ${invalidTimestamp} ACK timestamp falls back to local time`);
  assert.equal(pageDates(root).get("page-1"), returnedTimestamp,
    `updatedDate uses the fallback timestamp when the server returns ${invalidTimestamp}`);
  root.destroy();
}

{
  const workspaceId = "workspace-updated-date-page-failure";
  const root = workspaceRootWithPages([{ id: "page-1", updatedDate: 10 }]);
  const transport = makeUpdateSocket({
    workspaceId,
    root,
    pageTimestamp: new Error("page write rejected"),
  });
  await assert.rejects(
    pushPageDocUpdate(transport.socket, workspaceId, "page-1", changedDocumentUpdate()),
    /page write rejected/,
  );
  assert.equal(transport.rootReads, 0, "a rejected page write never loads or mutates workspace metadata");
  assert.equal(transport.rootPushes, 0);
  assert.equal(pageDates(root).get("page-1"), 10);
  root.destroy();
}

{
  const workspaceId = "workspace-updated-date-concurrent";
  const root = workspaceRootWithPages([
    { id: "page-a", updatedDate: 10 },
    { id: "page-b", updatedDate: 15 },
  ]);
  const transport = makeUpdateSocket({ workspaceId, root, rootReadBarrier: 2 });
  await Promise.all([
    pushPageDocUpdate(transport.socket, workspaceId, "page-a", changedDocumentUpdate()),
    pushPageDocUpdate(transport.socket, workspaceId, "page-b", changedDocumentUpdate()),
  ]);
  assert.deepEqual(pageDates(root), new Map([
    ["page-a", 100],
    ["page-b", 100],
  ]), "concurrent page timestamp deltas preserve both root entries");
  assert.equal(transport.rootPushes, 2);
  root.destroy();
}

{
  const workspaceId = "workspace-updated-date-failure";
  const root = workspaceRootWithPages([{ id: "page-1", updatedDate: 10 }]);
  const transport = makeUpdateSocket({ workspaceId, root, pageTimestamp: 20, rootMode: "ack-lost" });
  await pushPageDocUpdate(transport.socket, workspaceId, "page-1", changedDocumentUpdate());
  assert.equal(pageDates(root).get("page-1"), 20, "an applied root update with a lost ACK is confirmed by readback");
  assert.equal(transport.pushes.filter(push => push.docId === "page-1").length, 1,
    "metadata confirmation never replays the already-committed page mutation");

  const failedRoot = workspaceRootWithPages([{ id: "page-2", updatedDate: 10 }]);
  const failedTransport = makeUpdateSocket({ workspaceId, root: failedRoot, pageTimestamp: 30, rootMode: "fail" });
  const safeHandler = withToolErrors(
    () => pushPageDocUpdate(failedTransport.socket, workspaceId, "page-2", changedDocumentUpdate()),
    { toolName: "append_markdown", authMode: "bearer", readOnly: false },
  );
  const failure = await safeHandler();
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.code, "workspace_page_updated_date_failed");
  assert.equal(failure.structuredContent.retryable, false, "a metadata-only failure must not invite page-mutation replay");
  assert.match(failure.structuredContent.recoveryGuidance, /Do not retry the page mutation/);
  assert.equal(failedTransport.pushes.filter(push => push.docId === "page-2").length, 1,
    "metadata failure does not repeat page content");
  assert.equal(failedTransport.rootPushes, 1);
  root.destroy();
  failedRoot.destroy();
}

{
  const queries = [];
  const result = await requestListDocsWithPublicFallback({
    async request(query) {
      queries.push(query);
      if (queries.length === 1) {
        throw new Error("GraphQL error: Cannot return null for non-nullable field DocType.public.");
      }
      return {
        workspace: {
          docs: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
            edges: [{ cursor: "cursor-1", node: { id: "doc-1", title: "New doc" } }],
          },
        },
      };
    },
  }, { workspaceId: "workspace-1", first: 50 });

  assert.equal(queries.length, 2);
  assert.match(queries[0], /\bpublic\b/);
  assert.doesNotMatch(queries[1], /\bpublic\b/);
  assert.equal(result.workspace.docs.edges[0].node.public, null);
  assert.deepEqual(result.workspace.docs.warnings, [
    "AFFiNE document visibility metadata was unavailable; affected public values are null.",
  ]);
}

{
  let requestCount = 0;
  await assert.rejects(
    requestListDocsWithPublicFallback({
      async request() {
        requestCount += 1;
        throw new Error("GraphQL error: forbidden");
      },
    }, { workspaceId: "workspace-1" }),
    /forbidden/,
  );
  assert.equal(requestCount, 1, "unrelated GraphQL errors must not use the fallback query");
}

{
  assert.equal(
    isWorkspaceListDocsPermissionDenied(
      new Error("GraphQL error: You do not have permission to access Space workspace-1."),
    ),
    true,
  );
  assert.equal(isWorkspaceListDocsPermissionDenied(new Error("GraphQL error: forbidden")), false);
  assert.equal(
    isWorkspaceListDocsPermissionDenied(
      new Error("Workspace access was denied while another operation was in progress."),
    ),
    false,
  );
  assert.equal(
    isWorkspaceListDocsPermissionDenied(
      new Error("You do not have permission to perform read action on doc doc-1."),
    ),
    false,
  );
}

{
  const pages = Array.from({ length: 205 }, (_, index) => ({
    id: `doc-${index}`,
    title: `Document ${index}`,
    createdAt: 1_700_000_000_000 + index,
    updatedAt: null,
    tags: index === 2 ? ["important"] : [],
    inTrash: index === 3,
  }));
  const firstPage = buildWorkspaceListDocsFallbackConnection("workspace-1", pages, {
    first: 999,
    offset: 2,
  });
  assert.equal(firstPage.totalCount, 205);
  assert.equal(firstPage.edges.length, 200, "fallback results are bounded to 200 entries");
  assert.equal(firstPage.edges[0].node.id, "doc-2");
  assert.equal(firstPage.edges[0].node.summary, null);
  assert.equal(firstPage.edges[0].node.public, null);
  assert.equal(firstPage.edges[0].node.defaultRole, null);
  assert.deepEqual(firstPage.edges[0].node.tags, ["important"]);
  assert.equal(firstPage.pageInfo.hasNextPage, true);

  const secondPage = buildWorkspaceListDocsFallbackConnection("workspace-1", pages, {
    first: 5,
    after: firstPage.pageInfo.endCursor,
  });
  assert.deepEqual(secondPage.edges.map((edge) => edge.node.id), ["doc-202", "doc-203", "doc-204"]);
  assert.equal(secondPage.pageInfo.hasNextPage, false);
  assert.equal(secondPage.pageInfo.endCursor, secondPage.edges.at(-1).cursor);

  assert.throws(
    () => buildWorkspaceListDocsFallbackConnection("workspace-1", pages, { after: "invalid-cursor" }),
    /Invalid list_docs cursor/,
  );
  const foreignCursor = buildWorkspaceListDocsFallbackConnection("workspace-2", pages, { first: 1 })
    .pageInfo.endCursor;
  assert.throws(
    () => buildWorkspaceListDocsFallbackConnection("workspace-1", pages, { after: foreignCursor }),
    /Invalid list_docs cursor/,
  );

  const withoutAcknowledgedDeletions = buildWorkspaceListDocsFallbackConnection(
    "workspace-1",
    pages,
    { first: 3 },
    new Set(["doc-1", "doc-3"]),
  );
  assert.equal(withoutAcknowledgedDeletions.totalCount, 203);
  assert.deepEqual(
    withoutAcknowledgedDeletions.edges.map((edge) => edge.node.id),
    ["doc-0", "doc-2", "doc-4"],
    "permission fallback must exclude locally acknowledged deletions before pagination",
  );
}

{
  const deletedDocIds = new Set(["deleted-doc"]);
  const firstCursorPage = filterWorkspaceListDocsConnection({
    totalCount: 3,
    pageInfo: { hasNextPage: true, endCursor: "raw-cursor-2" },
    edges: [
      { cursor: "raw-cursor-1", node: { id: "live-doc-1" } },
      { cursor: "raw-cursor-2", node: { id: "deleted-doc" } },
    ],
  }, deletedDocIds);
  assert.deepEqual(firstCursorPage.edges.map((edge) => edge.node.id), ["live-doc-1"]);
  assert.equal(firstCursorPage.pageInfo.hasNextPage, true);
  assert.equal(
    firstCursorPage.pageInfo.endCursor,
    "raw-cursor-2",
    "cursor pagination must advance past a trailing deleted edge",
  );

  const allDeletedCursorPage = filterWorkspaceListDocsConnection({
    totalCount: 3,
    pageInfo: { hasNextPage: true, endCursor: null },
    edges: [{ cursor: "raw-cursor-deleted", node: { id: "deleted-doc" } }],
  }, deletedDocIds);
  assert.deepEqual(allDeletedCursorPage.edges, []);
  assert.equal(allDeletedCursorPage.pageInfo.hasNextPage, true);
  assert.equal(
    allDeletedCursorPage.pageInfo.endCursor,
    "raw-cursor-deleted",
    "an all-deleted cursor page must retain the raw edge cursor",
  );

  const firstOffsetPage = filterWorkspaceListDocsConnection({
    totalCount: 3,
    pageInfo: { hasNextPage: true, endCursor: "raw-offset-1" },
    edges: [
      { cursor: "raw-offset-0", node: { id: "deleted-doc" } },
      { cursor: "raw-offset-1", node: { id: "live-doc-1" } },
    ],
  }, deletedDocIds);
  assert.equal(firstOffsetPage.pageInfo.hasNextPage, true, "offset pagination must preserve backend progress");
  assert.equal(firstOffsetPage.pageInfo.endCursor, "raw-offset-1");

  const secondOffsetPage = filterWorkspaceListDocsConnection({
    totalCount: 3,
    pageInfo: { hasNextPage: false, endCursor: "raw-offset-2" },
    edges: [{ cursor: "raw-offset-2", node: { id: "live-doc-2" } }],
  }, deletedDocIds);
  assert.deepEqual(secondOffsetPage.edges.map((edge) => edge.node.id), ["live-doc-2"]);
  assert.equal(secondOffsetPage.pageInfo.hasNextPage, false);
  assert.equal(secondOffsetPage.pageInfo.endCursor, "raw-offset-2");
}

{
  const partialError = new DocumentCreationError({
    workspaceId: "workspace-1",
    docId: "doc-created-once",
    title: "Recovered title",
    stage: "metadata",
    contentPersisted: true,
    metadataPersisted: false,
    cause: new Error("metadata write timed out"),
  });
  const partialResponse = documentCreationToolResult(partialError, "doc.create");
  assert.equal(partialResponse.isError, true);
  assert.equal(partialResponse.structuredContent.kind, "doc.create");
  assert.equal(partialResponse.structuredContent.ok, false);
  assert.equal(partialResponse.structuredContent.code, "DOCUMENT_CREATE_PARTIAL");
  assert.equal(partialResponse.structuredContent.status, "partial");
  assert.equal(partialResponse.structuredContent.docId, "doc-created-once");
  assert.equal(partialResponse.structuredContent.stage, "metadata");
  assert.equal(partialResponse.structuredContent.contentPersisted, true);
  assert.equal(partialResponse.structuredContent.metadataPersisted, false);
  assert.equal(partialResponse.structuredContent.retryable, false);
  assert.match(partialResponse.structuredContent.recoveryGuidance, /Do not retry document creation/);

  const uncertainError = new DocumentCreationError({
    workspaceId: "workspace-1",
    docId: "doc-possibly-created",
    title: "Unknown title",
    stage: "content",
    contentPersisted: null,
    metadataPersisted: null,
    cause: "socket disconnected",
  });
  const uncertainResponse = documentCreationToolResult(uncertainError, "doc.create_from_markdown");
  assert.equal(uncertainResponse.isError, true);
  assert.equal(uncertainResponse.structuredContent.kind, "doc.create_from_markdown");
  assert.equal(uncertainResponse.structuredContent.code, "DOCUMENT_CREATE_UNCERTAIN");
  assert.equal(uncertainResponse.structuredContent.status, "uncertain");
  assert.equal(uncertainResponse.structuredContent.docId, "doc-possibly-created");
  assert.equal(documentCreationToolResult(new Error("ordinary failure"), "doc.create"), null);
}

{
  const workspaceRoot = new Y.Doc();
  const workspacePages = new Y.Array();
  workspaceRoot.getMap("meta").set("pages", workspacePages);
  const emptyWorkspaceSnapshot = Buffer.from(Y.encodeStateAsUpdate(workspaceRoot)).toString("base64");
  const contentUpdates = new Map();
  const propertiesDoc = new Y.Doc();
  let hasPropertiesDoc = false;
  let contentMode = "persist";
  let contentRejectRemaining = 0;
  let contentPushCount = 0;
  let metadataMode = "ack-lost";
  let ackLostApplied = false;
  let staleWorkspaceReads = 0;
  let metadataPushCount = 0;
  const metadataUpdates = [];
  let creatorMode = "success";
  let creatorLoadMode = "success";
  let creatorAckWasLost = false;
  let creatorPushCount = 0;
  let seedCreatorForNextDoc = null;
  let currentUserId = "user-A";
  let currentUserMode = "success";
  const socket = { disconnect() {} };
  const fakeGql = {
    async getConnectionAuth() {
      return { endpoint: "http://example.test/graphql" };
    },
    async request(query) {
      assert.match(query, /currentUser\s*\{\s*id\s*\}/);
      if (currentUserMode === "query-failure") {
        throw new Error("currentUser query failed");
      }
      if (currentUserMode === "null") return { currentUser: null };
      if (currentUserMode === "malformed") return { currentUser: { id: 42 } };
      return { currentUser: { id: currentUserId } };
    },
  };
  const transport = {
    async connectWorkspaceSocket() {
      return socket;
    },
    async joinWorkspace() {},
    async loadDoc(_socket, workspaceId, docId) {
      if (docId === docPropertiesDocId(workspaceId)) {
        if (creatorLoadMode === "unreadable") {
          throw new Error("docProperties readback unavailable");
        }
        return hasPropertiesDoc
          ? { missing: Buffer.from(Y.encodeStateAsUpdate(propertiesDoc)).toString("base64") }
          : {};
      }
      if (docId === workspaceId) {
        if (staleWorkspaceReads > 0) {
          staleWorkspaceReads -= 1;
          return { missing: emptyWorkspaceSnapshot };
        }
        return {
          missing: Buffer.from(Y.encodeStateAsUpdate(workspaceRoot)).toString("base64"),
        };
      }
      if (contentMode === "unreadable") {
        throw new Error("content readback unavailable");
      }
      const content = contentUpdates.get(docId);
      return content ? { missing: content } : {};
    },
    async pushDocUpdate(_socket, workspaceId, docId, updateBase64) {
      if (docId === docPropertiesDocId(workspaceId)) {
        creatorPushCount += 1;
        if (creatorMode === "persistent-failure") {
          throw new Error("docProperties write failed");
        }
        Y.applyUpdate(propertiesDoc, Buffer.from(updateBase64, "base64"));
        hasPropertiesDoc = true;
        if (creatorMode === "ack-lost" && !creatorAckWasLost) {
          creatorAckWasLost = true;
          throw new Error("docProperties acknowledgement timed out");
        }
        return Date.now();
      }
      if (docId !== workspaceId) {
        contentPushCount += 1;
        if (contentMode === "unreadable") {
          throw new Error("content write acknowledgement unavailable");
        }
        if (contentMode === "reject-once" && contentRejectRemaining > 0) {
          contentRejectRemaining -= 1;
          throw new Error("content write rejected before persistence");
        }
        contentUpdates.set(docId, updateBase64);
        if (seedCreatorForNextDoc) {
          const record = propertiesDoc.getMap(docId);
          record.set("id", docId);
          record.set("createdBy", seedCreatorForNextDoc);
          record.set("custom:preserve", "existing value");
          hasPropertiesDoc = true;
          seedCreatorForNextDoc = null;
        }
        return Date.now();
      }
      metadataPushCount += 1;
      metadataUpdates.push(updateBase64);
      if (metadataMode === "ack-lost") {
        Y.applyUpdate(workspaceRoot, Buffer.from(updateBase64, "base64"));
        if (!ackLostApplied) {
          ackLostApplied = true;
          staleWorkspaceReads = 2;
        }
        throw new Error("metadata write timed out");
      }
      if (metadataMode === "persistent-failure") {
        throw new Error("metadata write timed out");
      }
      Y.applyUpdate(workspaceRoot, Buffer.from(updateBase64, "base64"));
      return Date.now();
    },
  };
  const server = new McpServer({ name: "document-creation-recovery-test", version: "1.0.0" });
  registerDocTools(server, fakeGql, { workspaceId: "workspace-1" }, transport);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "document-creation-recovery-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  for (const mode of ["null", "malformed", "query-failure"]) {
    currentUserMode = mode;
    const before = [contentPushCount, metadataPushCount, creatorPushCount];
    const rejected = await client.callTool({
      name: "create_doc",
      arguments: { workspaceId: "workspace-1", title: `Invalid identity ${mode}`, content: "body" },
    });
    assert.equal(rejected.isError, true, `${mode} currentUser response must fail creation`);
    assert.deepEqual([contentPushCount, metadataPushCount, creatorPushCount], before,
      `${mode} currentUser response must fail before any content or metadata write`);
  }
  currentUserMode = "success";

  const acknowledged = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "ACK lost", content: "body" },
  });
  assert.equal(acknowledged.isError, undefined);
  assert.equal(acknowledged.structuredContent.ok, true);
  assert.equal(propertiesDoc.getMap(acknowledged.structuredContent.docId).get("id"), acknowledged.structuredContent.docId);
  assert.equal(propertiesDoc.getMap(acknowledged.structuredContent.docId).get("createdBy"), "user-A");
  assert.equal(workspacePages.length, 1, "metadata ACK loss must reconcile the existing page");
  const createdPage = workspacePages.get(0);
  assert.equal(typeof createdPage.get("updatedDate"), "number", "new pages start with an updatedDate");
  assert.equal(createdPage.get("updatedDate"), createdPage.get("createDate"),
    "page creation initializes updatedDate from the same creation timestamp");
  assert.equal(metadataPushCount, 2, "a stale metadata read permits one bounded replay");
  assert.equal(metadataUpdates[0], metadataUpdates[1], "metadata replay must use the exact original Yjs update");

  metadataMode = "persistent-failure";
  currentUserId = "user-B";
  const partial = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "Partial", content: "body" },
  });
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent.kind, "doc.create");
  assert.equal(partial.structuredContent.ok, false);
  assert.equal(partial.structuredContent.code, "DOCUMENT_CREATE_PARTIAL");
  assert.equal(partial.structuredContent.status, "partial");
  assert.equal(typeof partial.structuredContent.docId, "string");
  assert.equal(contentUpdates.has(partial.structuredContent.docId), true);
  assert.equal(partial.structuredContent.stage, "metadata");
  assert.equal(partial.structuredContent.contentPersisted, true);
  assert.equal(partial.structuredContent.metadataPersisted, false);
  assert.equal(partial.structuredContent.retryable, false);
  assert.match(partial.structuredContent.recoveryGuidance, /Do not retry document creation/);
  assert.equal(metadataPushCount, 4, "metadata recovery must be bounded to one repair attempt");
  assert.equal(workspacePages.length, 1, "failed metadata repair must not duplicate an existing page");
  assert.equal(propertiesDoc.getMap(partial.structuredContent.docId).get("createdBy"), "user-B",
    "creator metadata is persisted even when workspace page registration fails");

  metadataMode = "success";
  contentMode = "reject-once";
  contentRejectRemaining = 1;
  const contentPushesBeforeRetry = contentPushCount;
  const contentRecovered = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "Content retry", content: "body" },
  });
  assert.equal(contentRecovered.isError, undefined);
  assert.equal(contentRecovered.structuredContent.ok, true);
  assert.equal(contentUpdates.has(contentRecovered.structuredContent.docId), true);
  assert.equal(propertiesDoc.getMap(contentRecovered.structuredContent.docId).get("createdBy"), "user-B",
    "repaired content creation must finish creator metadata before returning success");
  assert.equal(contentPushCount, contentPushesBeforeRetry + 2, "content recovery must retry the same generated id once");

  contentMode = "unreadable";
  const contentReadbackPushesBeforeFailure = contentPushCount;
  const uncertainContent = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "Unreadable content", content: "body" },
  });
  assert.equal(uncertainContent.isError, true);
  assert.equal(uncertainContent.structuredContent.kind, "doc.create");
  assert.equal(uncertainContent.structuredContent.code, "DOCUMENT_CREATE_UNCERTAIN");
  assert.equal(uncertainContent.structuredContent.status, "uncertain");
  assert.equal(typeof uncertainContent.structuredContent.docId, "string");
  assert.equal(uncertainContent.structuredContent.stage, "content");
  assert.equal(uncertainContent.structuredContent.contentPersisted, null);
  assert.equal(contentPushCount, contentReadbackPushesBeforeFailure + 1, "unreadable content must not trigger blind recreation");
  assert.equal(contentUpdates.has(uncertainContent.structuredContent.docId), false);
  assert.equal(metadataPushCount, 5, "unreadable content must stop before metadata mutation");

  contentMode = "persist";
  creatorMode = "ack-lost";
  const creatorAckLost = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "Creator ACK lost", content: "body" },
  });
  assert.equal(creatorAckLost.isError, undefined, "a persisted creator write with a lost ACK is confirmed by readback");
  assert.equal(propertiesDoc.getMap(creatorAckLost.structuredContent.docId).get("createdBy"), "user-B");
  creatorMode = "success";

  seedCreatorForNextDoc = "existing-user";
  const creatorWritesBeforeExisting = creatorPushCount;
  const existingCreator = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "Existing creator", content: "body" },
  });
  assert.equal(existingCreator.isError, undefined);
  const existingRecord = propertiesDoc.getMap(existingCreator.structuredContent.docId);
  assert.equal(existingRecord.get("createdBy"), "existing-user", "a non-empty existing creator is preserved");
  assert.equal(existingRecord.get("custom:preserve"), "existing value", "unrelated properties are preserved");
  assert.equal(creatorPushCount, creatorWritesBeforeExisting,
    "an already populated creator record is not rewritten");

  creatorMode = "persistent-failure";
  const creatorPushesBeforeFailure = creatorPushCount;
  const failedCreator = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "Creator write failed", content: "body" },
  });
  assert.equal(failedCreator.isError, true);
  assert.equal(failedCreator.structuredContent.code, "DOCUMENT_CREATE_PARTIAL");
  assert.equal(failedCreator.structuredContent.docId.length > 0, true);
  assert.equal(failedCreator.structuredContent.contentPersisted, true);
  assert.equal(failedCreator.structuredContent.metadataPersisted, false);
  assert.equal(failedCreator.structuredContent.retryable, false);
  assert.equal(creatorPushCount, creatorPushesBeforeFailure + 2,
    "creator recovery is bounded to one initial write and one repair write");
  creatorMode = "success";

  creatorLoadMode = "unreadable";
  const creatorPushesBeforeUnreadable = creatorPushCount;
  const unreadableCreator = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "Creator readback unavailable", content: "body" },
  });
  assert.equal(unreadableCreator.isError, true);
  assert.equal(unreadableCreator.structuredContent.code, "DOCUMENT_CREATE_UNCERTAIN");
  assert.equal(unreadableCreator.structuredContent.docId.length > 0, true);
  assert.equal(unreadableCreator.structuredContent.contentPersisted, true);
  assert.equal(unreadableCreator.structuredContent.metadataPersisted, null);
  assert.equal(unreadableCreator.structuredContent.retryable, false);
  assert.equal(creatorPushCount, creatorPushesBeforeUnreadable,
    "unreadable creator metadata must stop before a blind properties write");
  creatorLoadMode = "success";

  await client.close();
  await server.close();
  propertiesDoc.destroy();
  workspaceRoot.destroy();
}

function dependencies(overrides = {}) {
  const events = [];
  return {
    events,
    value: {
      assertResourcesExist: async () => events.push("assert"),
      wouldCreateCycle: async () => {
        events.push("cycle");
        return false;
      },
      isLinkedToNewParent: async () => {
        events.push("inspect-destination");
        return false;
      },
      addToNewParent: async () => events.push("add-destination"),
      removeFromOldParent: async () => {
        events.push("remove-source");
        return true;
      },
      ...overrides,
    },
  };
}

{
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");

  const linkedEmbed = new Y.Map();
  linkedEmbed.set("sys:flavour", "affine:embed-linked-doc");
  linkedEmbed.set("prop:pageId", "linked-doc");
  blocks.set("linked-embed", linkedEmbed);

  const syncedEmbed = new Y.Map();
  syncedEmbed.set("sys:flavour", "affine:embed-synced-doc");
  syncedEmbed.set("prop:pageId", "synced-doc");
  blocks.set("synced-embed", syncedEmbed);

  const paragraph = new Y.Map();
  paragraph.set("sys:flavour", "affine:paragraph");
  const text = new Y.Text();
  text.insert(0, "linked", {
    reference: { type: "LinkedPage", pageId: "inline-doc" },
  });
  paragraph.set("prop:text", text);
  blocks.set("paragraph", paragraph);

  assert.deepEqual(
    collectLinkedChildIds(blocks).sort(),
    ["inline-doc", "linked-doc", "synced-doc"],
    "cycle detection must use the same hierarchy links as tree traversal",
  );
}

{
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const parentA = new Y.Map();
  const parentB = new Y.Map();
  const childrenA = new Y.Array();
  const childrenB = new Y.Array();
  childrenA.push(["embed-1", "keep", "embed-1"]);
  childrenB.push(["embed-2"]);
  parentA.set("sys:children", childrenA);
  parentB.set("sys:children", childrenB);
  blocks.set("parent-a", parentA);
  blocks.set("parent-b", parentB);

  for (const blockId of ["embed-1", "embed-2"]) {
    const embed = new Y.Map();
    embed.set("sys:flavour", "affine:embed-linked-doc");
    embed.set("prop:pageId", "doc-1");
    blocks.set(blockId, embed);
  }

  const removedCount = removeEmbeddedLinkedDocumentBlocks(blocks, "doc-1");
  assert.equal(removedCount, 2);
  assert.equal(blocks.has("embed-1"), false);
  assert.equal(blocks.has("embed-2"), false);
  assert.deepEqual(childrenA.toArray(), ["keep"]);
  assert.deepEqual(childrenB.toArray(), []);
  assert.equal(removeEmbeddedLinkedDocumentBlocks(blocks, "doc-1"), 0);
}

{
  const deps = dependencies();
  await assert.rejects(
    executeSafeDocumentMove(
      { docId: "doc-1", toParentDocId: "doc-1" },
      deps.value,
    ),
    /cannot be moved under itself/,
  );
  assert.deepEqual(deps.events, [], "self-parent rejection must happen before any mutation callback");
}

{
  const deps = dependencies();
  const outcome = await executeSafeDocumentMove(
    { docId: "doc-1", toParentDocId: "new-parent", fromParentDocId: "old-parent" },
    deps.value,
  );
  assert.equal(outcome.status, "moved");
  assert.equal(outcome.moved, true);
  assert.equal(outcome.partial, false);
  assert.equal(isDocumentMoveSuccessful(outcome), true);
  assert.deepEqual(deps.events, [
    "assert",
    "cycle",
    "inspect-destination",
    "add-destination",
    "remove-source",
  ]);
}

{
  const events = [];
  const deps = dependencies({
    addToNewParent: async () => {
      events.push("add-destination");
      throw new Error("destination unavailable");
    },
    removeFromOldParent: async () => {
      events.push("remove-source");
      return true;
    },
  });
  await assert.rejects(
    executeSafeDocumentMove(
      { docId: "doc-1", toParentDocId: "new-parent", fromParentDocId: "old-parent" },
      deps.value,
    ),
    /destination unavailable/,
  );
  assert.deepEqual(events, ["add-destination"], "source removal must not run when destination addition fails");
}

{
  const deps = dependencies({
    removeFromOldParent: async () => {
      throw new Error("source write timed out");
    },
  });
  const outcome = await executeSafeDocumentMove(
    { docId: "doc-1", toParentDocId: "new-parent", fromParentDocId: "old-parent" },
    deps.value,
  );
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.moved, false);
  assert.equal(outcome.linkedToNewParent, true);
  assert.equal(outcome.requiresManualRepair, true);
  assert.equal(isDocumentMoveSuccessful(outcome), false);
  assert.deepEqual(toDocumentMoveResult(outcome), {
    ok: false,
    ...outcome,
    error: outcome.warnings[0],
    code: "DOCUMENT_MOVE_PARTIAL",
    retryable: true,
  });
  const response = documentMoveToolResult({
    workspaceId: "workspace-1",
    docId: "doc-1",
    toParentDocId: "new-parent",
    fromParentDocId: "old-parent",
  }, outcome);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.ok, false);
  assert.equal(response.structuredContent.code, "DOCUMENT_MOVE_PARTIAL");
  assert.match(outcome.warnings[0], /source write timed out/);
}

{
  const deps = dependencies({
    removeFromOldParent: async () => false,
  });
  const outcome = await executeSafeDocumentMove(
    { docId: "doc-1", toParentDocId: "new-parent", fromParentDocId: "missing-parent-link" },
    deps.value,
  );
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.moved, false);
  assert.equal(outcome.partial, true);
  assert.equal(outcome.linkedToNewParent, true);
  assert.equal(outcome.removedFromParent, false);
  assert.equal(outcome.requiresManualRepair, true);
  assert.equal(isDocumentMoveSuccessful(outcome), false);
  assert.equal(toDocumentMoveResult(outcome).code, "DOCUMENT_MOVE_PARTIAL");
  const response = documentMoveToolResult({
    workspaceId: "workspace-1",
    docId: "doc-1",
    toParentDocId: "new-parent",
    fromParentDocId: "missing-parent-link",
  }, outcome);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.ok, false);
  assert.equal(response.structuredContent.status, "partial");
  assert.match(outcome.warnings[0], /no matching link was found/);
}

{
  const events = [];
  const deps = dependencies({
    isLinkedToNewParent: async () => {
      events.push("inspect-destination");
      return true;
    },
    addToNewParent: async () => events.push("unexpected-add"),
    removeFromOldParent: async () => {
      events.push("remove-source");
      return true;
    },
  });
  const outcome = await executeSafeDocumentMove(
    { docId: "doc-1", toParentDocId: "new-parent", fromParentDocId: "old-parent" },
    deps.value,
  );
  assert.equal(outcome.addedToNewParent, false);
  assert.deepEqual(events, ["inspect-destination", "remove-source"]);
}

{
  const events = [];
  const deps = dependencies({
    wouldCreateCycle: async () => {
      events.push("cycle");
      return true;
    },
    addToNewParent: async () => events.push("unexpected-add"),
    removeFromOldParent: async () => {
      events.push("unexpected-remove");
      return true;
    },
  });
  await assert.rejects(
    executeSafeDocumentMove(
      { docId: "doc-1", toParentDocId: "descendant" },
      deps.value,
    ),
    /would create a document cycle/,
  );
  assert.deepEqual(events, ["cycle"]);
}

{
  const events = [];
  const deps = dependencies({
    isLinkedToNewParent: async () => {
      events.push("inspect-destination");
      return true;
    },
    addToNewParent: async () => events.push("unexpected-add"),
    removeFromOldParent: async () => {
      events.push("unexpected-remove");
      return true;
    },
  });
  const outcome = await executeSafeDocumentMove(
    { docId: "doc-1", toParentDocId: "same-parent", fromParentDocId: "same-parent" },
    deps.value,
  );
  assert.equal(outcome.status, "unchanged");
  assert.equal(outcome.moved, false);
  assert.equal(isDocumentMoveSuccessful(outcome), true);
  const response = documentMoveToolResult({
    workspaceId: "workspace-1",
    docId: "doc-1",
    toParentDocId: "same-parent",
    fromParentDocId: "same-parent",
  }, outcome);
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.ok, true);
  assert.deepEqual(events, ["inspect-destination"]);
}

{
  const deps = dependencies({
    isLinkedToNewParent: async () => false,
  });
  const outcome = await executeSafeDocumentMove(
    { docId: "doc-1", toParentDocId: "same-parent", fromParentDocId: "same-parent" },
    deps.value,
  );
  assert.equal(outcome.status, "unchanged");
  assert.equal(outcome.requiresManualRepair, true);
  assert.equal(isDocumentMoveSuccessful(outcome), false);
  const result = toDocumentMoveResult(outcome);
  assert.equal(result.code, "DOCUMENT_MOVE_INCONSISTENT");
  assert.equal(result.retryable, false);
  const response = documentMoveToolResult({
    workspaceId: "workspace-1",
    docId: "doc-1",
    toParentDocId: "same-parent",
    fromParentDocId: "same-parent",
  }, outcome);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.retryable, false);
}

assert.doesNotThrow(() => {
  handleMarkdownOperationFailure(new Error("unsupported block"), {
    strict: false,
    replaceExisting: false,
    operationIndex: 0,
  });
});
assert.throws(
  () => handleMarkdownOperationFailure(new Error("unsupported block"), {
    strict: true,
    replaceExisting: false,
    operationIndex: 2,
  }),
  /strict append aborted at operation 3: unsupported block/,
);
assert.throws(
  () => handleMarkdownOperationFailure(new Error("unsupported block"), {
    strict: false,
    replaceExisting: true,
    operationIndex: 1,
  }),
  /replace aborted at operation 2: unsupported block/,
);

console.log("Document mutation safety tests passed");
