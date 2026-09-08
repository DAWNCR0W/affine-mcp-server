#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";

import {
  buildWorkspaceListDocsFallbackConnection,
  collectLinkedChildIds,
  documentMoveToolResult,
  documentCreationToolResult,
  filterWorkspaceListDocsConnection,
  isWorkspaceListDocsPermissionDenied,
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
  let contentMode = "persist";
  let contentRejectRemaining = 0;
  let contentPushCount = 0;
  let metadataMode = "ack-lost";
  let ackLostApplied = false;
  let staleWorkspaceReads = 0;
  let metadataPushCount = 0;
  const metadataUpdates = [];
  const socket = { disconnect() {} };
  const fakeGql = {
    async getConnectionAuth() {
      return { endpoint: "http://example.test/graphql" };
    },
    async request() {
      throw new Error("Unexpected GraphQL request in document creation recovery test");
    },
  };
  const transport = {
    async connectWorkspaceSocket() {
      return socket;
    },
    async joinWorkspace() {},
    async loadDoc(_socket, workspaceId, docId) {
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

  const acknowledged = await client.callTool({
    name: "create_doc",
    arguments: { workspaceId: "workspace-1", title: "ACK lost", content: "body" },
  });
  assert.equal(acknowledged.isError, undefined);
  assert.equal(acknowledged.structuredContent.ok, true);
  assert.equal(workspacePages.length, 1, "metadata ACK loss must reconcile the existing page");
  assert.equal(metadataPushCount, 2, "a stale metadata read permits one bounded replay");
  assert.equal(metadataUpdates[0], metadataUpdates[1], "metadata replay must use the exact original Yjs update");

  metadataMode = "persistent-failure";
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

  await client.close();
  await server.close();
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
