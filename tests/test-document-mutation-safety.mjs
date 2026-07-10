#!/usr/bin/env node
import assert from "node:assert/strict";

import { documentMoveToolResult } from "../dist/tools/docs.js";

import {
  executeSafeDocumentMove,
  handleMarkdownOperationFailure,
  isDocumentMoveSuccessful,
  toDocumentMoveResult,
} from "../dist/util/mutationSafety.js";

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
  assert.equal(toDocumentMoveResult(outcome).code, "DOCUMENT_MOVE_INCONSISTENT");
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
