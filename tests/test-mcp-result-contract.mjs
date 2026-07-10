#!/usr/bin/env node
import assert from "node:assert/strict";

import { receipt, text, toolError } from "../dist/util/mcp.js";
import { registerAccessTokenTools } from "../dist/tools/accessTokens.js";
import { registerBlobTools } from "../dist/tools/blobStorage.js";
import { registerNotificationTools } from "../dist/tools/notifications.js";
import { registerUserCRUDTools } from "../dist/tools/userCRUD.js";

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
      readAllNotifications: false,
      releaseDeletedBlobs: false,
      revokeUserAccessToken: false,
      updateSettings: false,
    };
  },
};
const registry = new ToolRegistry();
registerAccessTokenTools(registry, falseResultClient);
registerBlobTools(registry, falseResultClient);
registerNotificationTools(registry, falseResultClient);
registerUserCRUDTools(registry, falseResultClient);

const falseMutationCases = [
  ["revoke_access_token", { id: "token-1" }, "access_token_revoke_failed"],
  ["delete_blob", { workspaceId: "workspace-1", key: "blob-1" }, "blob_delete_failed"],
  ["cleanup_blobs", { workspaceId: "workspace-1" }, "blob_cleanup_failed"],
  ["read_all_notifications", {}, "notification_update_failed"],
  ["update_settings", { settings: { receiveCommentEmail: true } }, "settings_update_failed"],
];

for (const [name, args, code] of falseMutationCases) {
  const result = await registry.tools.get(name)(args);
  assert.equal(result.isError, true, `${name} should expose MCP isError`);
  assert.equal(parsed(result).ok, false, `${name} should report ok=false`);
  assert.equal(parsed(result).code, code, `${name} should report a stable code`);
}

console.log("MCP result contract tests passed");
