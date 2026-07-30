#!/usr/bin/env node
import assert from "node:assert/strict";

import * as Y from "yjs";

import {
  buildWorkspaceListDocsFallbackConnection,
  collectLinkedChildIds,
  documentMoveToolResult,
  isWorkspaceListDocsPermissionDenied,
  requestListDocsWithPublicFallback,
  removeEmbeddedLinkedDocumentBlocks,
} from "../dist/tools/docs.js";

import {
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
    isWorkspaceListDocsPermissionDenied(new Error("You do not have permission to access Space workspace-1")),
    true,
  );
  assert.equal(isWorkspaceListDocsPermissionDenied(new Error("GraphQL error: forbidden")), false);
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
