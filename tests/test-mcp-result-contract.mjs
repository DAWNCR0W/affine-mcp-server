#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";

import { receipt, text, toolError } from "../dist/util/mcp.js";
import { registerAccessTokenTools } from "../dist/tools/accessTokens.js";
import { registerBlobTools } from "../dist/tools/blobStorage.js";
import { registerCommentTools } from "../dist/tools/comments.js";
import { registerNotificationTools } from "../dist/tools/notifications.js";
import { registerUserCRUDTools } from "../dist/tools/userCRUD.js";
import { registerWorkspaceTools } from "../dist/tools/workspaces.js";

function parsed(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

const success = text({ value: 42 });
assert.equal(success.isError, undefined);
assert.deepEqual(parsed(success), { value: 42 });

const failure = toolError(new Error("backend unavailable"), {
  code: "backend_unavailable",
  retryable: true,
  details: { attempt: 2 },
  data: { operation: "workspace.list" },
});
assert.equal(failure.isError, true);
assert.deepEqual(parsed(failure), {
  ok: false,
  error: "backend unavailable",
  code: "backend_unavailable",
  retryable: true,
  details: { attempt: 2 },
  operation: "workspace.list",
});

const legacyCompatibleFailure = parsed(toolError("invalid input", { code: "invalid_arguments" }));
assert.equal(legacyCompatibleFailure.error, "invalid input");
assert.equal(legacyCompatibleFailure.ok, false);
assert.equal(legacyCompatibleFailure.retryable, false);

const falseReceipt = receipt("operation", { success: false });
assert.equal(parsed(falseReceipt).ok, false);
assert.equal(falseReceipt.isError, true);
const failedReceipt = receipt("operation", { status: "failed" });
assert.equal(parsed(failedReceipt).ok, false);
assert.equal(failedReceipt.isError, true);
assert.equal(parsed(receipt("operation", { status: "partial" })).ok, true);
assert.equal(parsed(receipt("operation", { ok: false, success: true })).ok, false);
assert.equal(parsed(receipt("operation", { value: 1 })).ok, true);

class ToolRegistry {
  tools = new Map();

  registerTool(name, _definition, handler) {
    this.tools.set(name, handler);
  }
}

const falseResultClient = {
  endpoint: "http://127.0.0.1:1/graphql",
  headers: {},
  cookie: undefined,
  async request() {
    return {
      deleteBlob: false,
      deleteComment: false,
      deleteWorkspace: false,
      readAllNotifications: false,
      releaseDeletedBlobs: false,
      resolveComment: false,
      revokeUserAccessToken: false,
      updateComment: false,
      updateSettings: false,
    };
  },
};
const registry = new ToolRegistry();
registerAccessTokenTools(registry, falseResultClient);
registerBlobTools(registry, falseResultClient);
registerCommentTools(registry, falseResultClient, {});
registerNotificationTools(registry, falseResultClient);
registerUserCRUDTools(registry, falseResultClient);
registerWorkspaceTools(registry, falseResultClient);

const falseMutationCases = [
  ["revoke_access_token", { id: "token-1" }, "access_token_revoke_failed"],
  ["delete_blob", { workspaceId: "workspace-1", key: "blob-1" }, "blob_delete_failed"],
  [
    "cleanup_blobs",
    { workspaceId: "workspace-1", confirmWorkspaceId: "workspace-1" },
    "blob_cleanup_failed",
  ],
  ["read_all_notifications", {}, "notification_update_failed"],
  ["update_settings", { settings: { receiveCommentEmail: true } }, "settings_update_failed"],
  [
    "update_comment",
    { id: "comment-1", content: "updated" },
    "comment_update_failed",
    "AFFiNE did not confirm the comment update.",
  ],
  [
    "delete_comment",
    { id: "comment-1" },
    "comment_delete_failed",
    "AFFiNE did not confirm comment deletion.",
  ],
  [
    "resolve_comment",
    { id: "comment-1", resolved: true },
    "comment_resolve_failed",
    "AFFiNE did not confirm the comment resolution change.",
  ],
  [
    "delete_workspace",
    { id: "workspace-1", confirmWorkspaceId: "workspace-1" },
    "workspace_delete_failed",
    "AFFiNE did not confirm workspace deletion.",
  ],
];

for (const [name, args, code, expectedError] of falseMutationCases) {
  const result = await registry.tools.get(name)(args);
  const payload = parsed(result);
  assert.equal(result.isError, true, `${name} should expose MCP isError`);
  assert.equal(payload.ok, false, `${name} should report ok=false`);
  assert.equal(payload.code, code, `${name} should report a stable code`);
  assert.equal(payload.retryable, false, `${name} should report retryable=false`);
  if (expectedError) {
    assert.equal(payload.error, expectedError, `${name} should report a stable error`);
  }
}

const successResultClient = {
  ...falseResultClient,
  async request() {
    return { deleteWorkspace: true };
  },
};
const successRegistry = new ToolRegistry();
registerWorkspaceTools(successRegistry, successResultClient);
const deletedWorkspace = parsed(await successRegistry.tools.get("delete_workspace")({
  id: "workspace-1",
  confirmWorkspaceId: "workspace-1",
}));
assert.equal(deletedWorkspace.success, true);
assert.equal(deletedWorkspace.deleted, true);
assert.equal(
  "message" in deletedWorkspace,
  false,
  "delete_workspace success should not include a redundant message",
);

console.log("MCP result contract tests passed");
