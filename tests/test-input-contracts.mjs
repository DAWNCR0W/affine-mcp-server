#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";
import { z } from "zod";

import { registerBlobTools } from "../dist/tools/blobStorage.js";
import { registerCommentTools } from "../dist/tools/comments.js";
import { registerDocTools } from "../dist/tools/docs.js";
import { registerHistoryTools } from "../dist/tools/history.js";
import { registerNotificationTools } from "../dist/tools/notifications.js";
import { registerWorkspaceTools } from "../dist/tools/workspaces.js";
import {
  BoundedHistoryTake,
  BoundedOffset,
  BoundedPageSize,
  BoundedSearchLimit,
  BoundedTreeDepth,
  requireMatchingConfirmation,
} from "../dist/util/inputSchemas.js";

class ToolRegistry {
  tools = new Map();

  registerTool(name, definition, handler) {
    this.tools.set(name, { definition, handler });
  }
}

function parseResult(result) {
  return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text || "null");
}

function expectSchemaRejects(schema, values) {
  for (const value of values) {
    assert.equal(schema.safeParse(value).success, false, `${JSON.stringify(value)} should be rejected`);
  }
}

expectSchemaRejects(BoundedPageSize, [0, -1, 1.5, 201]);
expectSchemaRejects(BoundedOffset, [-1, 1.5, 1_000_001]);
expectSchemaRejects(BoundedSearchLimit, [0, -1, 1.5, 201]);
expectSchemaRejects(BoundedTreeDepth, [-1, 1.5, 21]);
expectSchemaRejects(BoundedHistoryTake, [0, -1, 1.5, 201]);
for (const [schema, values] of [
  [BoundedPageSize, [1, 200]],
  [BoundedOffset, [0, 1_000_000]],
  [BoundedSearchLimit, [1, 200]],
  [BoundedTreeDepth, [0, 20]],
  [BoundedHistoryTake, [1, 200]],
]) {
  for (const value of values) assert.equal(schema.safeParse(value).success, true);
}

assert.doesNotThrow(() => requireMatchingConfirmation("delete_doc", "doc-1", "doc-1"));
assert.throws(
  () => requireMatchingConfirmation("delete_doc", "doc-1", "doc-2"),
  /must exactly match "doc-1"/,
);
assert.throws(
  () => requireMatchingConfirmation("delete_doc", "doc-1", undefined),
  /must exactly match "doc-1"/,
);

let requestCount = 0;
const gql = {
  endpoint: "http://127.0.0.1:1/graphql",
  headers: {},
  cookie: undefined,
  bearer: undefined,
  async request(query) {
    requestCount += 1;
    if (query.includes("deleteBlob")) return { deleteBlob: true };
    if (query.includes("releaseDeletedBlobs")) return { releaseDeletedBlobs: true };
    if (query.includes("deleteWorkspace")) return { deleteWorkspace: true };
    throw new Error("Unexpected query in input contract test");
  },
};
const registry = new ToolRegistry();
registerBlobTools(registry, gql);
registerCommentTools(registry, gql, {});
registerDocTools(registry, gql, {});
registerHistoryTools(registry, gql, {});
registerNotificationTools(registry, gql);
registerWorkspaceTools(registry, gql);

function toolSchema(name) {
  const fields = registry.tools.get(name)?.definition?.inputSchema;
  assert(fields, `${name} input schema is missing`);
  return z.object(fields);
}

const highlightedText = [
  { insert: "plain " },
  {
    insert: "colored",
    attributes: {
      color: "var(--affine-text-highlight-foreground-blue)",
      background: "var(--affine-text-highlight-yellow)",
      futureAttribute: { enabled: true },
    },
  },
];
for (const [name, required] of [
  ["append_block", { docId: "doc-1", type: "paragraph" }],
  ["update_block", { docId: "doc-1", blockId: "block-1" }],
]) {
  const schema = toolSchema(name);
  const parsed = schema.safeParse({ ...required, text: highlightedText });
  assert.equal(parsed.success, true, `${name} must accept formatting-preserving text deltas`);
  assert.deepEqual(parsed.data.text, highlightedText, `${name} must preserve arbitrary inline attributes`);
  for (const invalidText of [
    { insert: "not-an-array" },
    [{ insert: 42 }],
    [{ insert: "invalid attributes", attributes: [] }],
  ]) {
    assert.equal(
      schema.safeParse({ ...required, text: invalidText }).success,
      false,
      `${name} must reject malformed text deltas`,
    );
  }
}

assert.equal(toolSchema("list_docs").safeParse({ workspaceId: "w", first: 201 }).success, false);
assert.equal(toolSchema("search_docs").safeParse({ query: "x", limit: -1 }).success, false);
assert.equal(toolSchema("list_workspace_tree").safeParse({ depth: 21 }).success, false);
assert.equal(toolSchema("list_comments").safeParse({ docId: "d", first: 1.5 }).success, false);
assert.equal(toolSchema("list_notifications").safeParse({ offset: -1 }).success, false);
assert.equal(toolSchema("list_histories").safeParse({ guid: "d", take: 0 }).success, false);

const deleteDoc = registry.tools.get("delete_doc").handler;
await assert.rejects(
  deleteDoc({ workspaceId: "workspace-1", docId: "doc-1", confirmDocId: "doc-2" }),
  /must exactly match "doc-1"/,
);
assert.equal(requestCount, 0, "invalid document confirmation must not reach AFFiNE");

const deleteWorkspace = registry.tools.get("delete_workspace").handler;
const invalidWorkspace = parseResult(await deleteWorkspace({
  id: "workspace-1",
  confirmWorkspaceId: "workspace-2",
}));
assert.match(invalidWorkspace.error, /must exactly match "workspace-1"/);
assert.equal(requestCount, 0, "invalid workspace confirmation must not reach AFFiNE");

const deleteBlob = registry.tools.get("delete_blob").handler;
const invalidBlob = parseResult(await deleteBlob({
  workspaceId: "workspace-1",
  key: "blob-1",
  permanently: true,
  confirmKey: "blob-2",
}));
assert.match(invalidBlob.error, /must exactly match "blob-1"/);
assert.equal(requestCount, 0, "invalid blob confirmation must not reach AFFiNE");

const cleanupBlobs = registry.tools.get("cleanup_blobs").handler;
const invalidCleanup = parseResult(await cleanupBlobs({
  workspaceId: "workspace-1",
  confirmWorkspaceId: "workspace-2",
}));
assert.match(invalidCleanup.error, /must exactly match "workspace-1"/);
assert.equal(requestCount, 0, "invalid cleanup confirmation must not reach AFFiNE");

assert.equal(parseResult(await deleteWorkspace({
  id: "workspace-1",
  confirmWorkspaceId: "workspace-1",
})).success, true);
assert.equal(parseResult(await deleteBlob({
  workspaceId: "workspace-1",
  key: "blob-1",
  permanently: true,
  confirmKey: "blob-1",
})).success, true);
assert.equal(parseResult(await cleanupBlobs({
  workspaceId: "workspace-1",
  confirmWorkspaceId: "workspace-1",
})).success, true);
assert.equal(requestCount, 3, "valid confirmations should reach AFFiNE exactly once each");

console.log("Input contract tests passed");
