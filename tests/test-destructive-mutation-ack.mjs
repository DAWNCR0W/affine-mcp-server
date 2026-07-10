#!/usr/bin/env node
import assert from "node:assert/strict";

import * as Y from "yjs";

import { deleteDoc } from "../dist/ws.js";
import { registerAccessTokenTools } from "../dist/tools/accessTokens.js";
import { registerBlobTools } from "../dist/tools/blobStorage.js";
import { registerCommentTools } from "../dist/tools/comments.js";
import { deleteDocFromWorkspace } from "../dist/tools/docs.js";
import { registerNotificationTools } from "../dist/tools/notifications.js";
import { registerWorkspaceTools } from "../dist/tools/workspaces.js";

function parseToolResult(result) {
  if (result?.structuredContent) {
    return result.structuredContent;
  }
  const raw = result?.content?.[0]?.text;
  return raw ? JSON.parse(raw) : null;
}

function assertStableFailure(result, code, status = "failed") {
  const payload = parseToolResult(result);
  assert.equal(result.isError, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, status);
  assert.equal(payload.code, code);
  assert.equal(payload.retryable, false);
  assert.equal("message" in payload, false);
  assert.equal("success" in payload, false);
  return payload;
}

function createWorkspaceDoc(docId, includeMetadata) {
  const doc = new Y.Doc();
  const pages = new Y.Array();
  if (includeMetadata) {
    const page = new Y.Map();
    page.set("id", docId);
    page.set("title", "Deletion Test");
    pages.push([page]);
  }
  doc.getMap("meta").set("pages", pages);
  return doc;
}

function encodedDoc() {
  const doc = new Y.Doc();
  doc.getMap("meta").set("id", "content");
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

class FakeWorkspaceSocket {
  constructor({
    workspaceId = "workspace-1",
    docId = "doc-1",
    metadataExists = true,
    contentExists = true,
    deleteMode = "void-success",
    pushMode = "success",
  } = {}) {
    this.workspaceId = workspaceId;
    this.docId = docId;
    this.workspaceDoc = createWorkspaceDoc(docId, metadataExists);
    this.contentExists = contentExists;
    this.deleteMode = deleteMode;
    this.pushMode = pushMode;
    this.events = [];
    this.listeners = new Map();
  }

  emit(event, payload, ack) {
    this.events.push({ event, payload });
    queueMicrotask(() => {
      if (event === "space:load-doc") {
        if (payload.docId === this.workspaceId) {
          ack?.({
            data: {
              missing: Buffer.from(Y.encodeStateAsUpdate(this.workspaceDoc)).toString("base64"),
              timestamp: 1,
            },
          });
          return;
        }
        if (payload.docId === this.docId && this.contentExists) {
          ack?.({ data: { missing: encodedDoc(), timestamp: 1 } });
          return;
        }
        ack?.({ error: { name: "DOC_NOT_FOUND", message: "Document not found" } });
        return;
      }

      if (event === "space:push-doc-update") {
        if (this.pushMode === "error") {
          ack?.({ error: { name: "SYNC_FAILED", message: "workspace metadata sync failed" } });
          return;
        }
        if (payload.docId === this.workspaceId) {
          Y.applyUpdate(this.workspaceDoc, Buffer.from(payload.update, "base64"));
        }
        ack?.({ data: { timestamp: 2 } });
        return;
      }

      if (event === "space:delete-doc") {
        if (this.deleteMode === "error") {
          ack?.({ error: { name: "FORBIDDEN", message: "Doc.Delete permission denied" } });
          return;
        }
        if (this.deleteMode === "stall") {
          return;
        }
        if (this.deleteMode === "negative-ack") {
          ack?.({ data: { deleted: false } });
          return;
        }
        if (this.deleteMode === "empty-ack-still-present") {
          ack?.({});
          return;
        }
        this.contentExists = false;
        if (this.deleteMode === "ack-success") {
          ack?.({ data: { deleted: true } });
        } else if (this.deleteMode === "empty-ack-success") {
          ack?.({});
        }
      }
    });
    return this;
  }

  once(event, listener) {
    this.listeners.set(event, listener);
    return this;
  }

  off(event, listener) {
    if (this.listeners.get(event) === listener) {
      this.listeners.delete(event);
    }
    return this;
  }

  pageIds() {
    const pages = this.workspaceDoc.getMap("meta").get("pages");
    return pages instanceof Y.Array ? pages.toArray().map(page => page.get("id")) : [];
  }
}

class ToolRegistry {
  tools = new Map();

  registerTool(name, _definition, handler) {
    this.tools.set(name, handler);
  }
}

async function testDeleteDocProtocol() {
  const acknowledgedSocket = new FakeWorkspaceSocket({ deleteMode: "ack-success" });
  const acknowledged = await deleteDoc(acknowledgedSocket, "workspace-1", "doc-1", {
    timeoutMs: 100,
    verificationIntervalMs: 5,
  });
  assert.deepEqual(acknowledged, { acknowledged: true, verifiedAbsent: false });

  const voidSuccessSocket = new FakeWorkspaceSocket({ deleteMode: "void-success" });
  const verified = await deleteDoc(voidSuccessSocket, "workspace-1", "doc-1", {
    timeoutMs: 100,
    verificationIntervalMs: 5,
  });
  assert.deepEqual(verified, { acknowledged: false, verifiedAbsent: true });
  assert.deepEqual(voidSuccessSocket.events[0], {
    event: "space:delete-doc",
    payload: { spaceType: "workspace", spaceId: "workspace-1", docId: "doc-1" },
  });

  const emptyAcknowledgementSocket = new FakeWorkspaceSocket({ deleteMode: "empty-ack-success" });
  const emptyAcknowledgement = await deleteDoc(emptyAcknowledgementSocket, "workspace-1", "doc-1", {
    timeoutMs: 100,
    verificationIntervalMs: 5,
  });
  assert.deepEqual(emptyAcknowledgement, { acknowledged: false, verifiedAbsent: true });

  const negativeAcknowledgementSocket = new FakeWorkspaceSocket({ deleteMode: "negative-ack" });
  await assert.rejects(
    deleteDoc(negativeAcknowledgementSocket, "workspace-1", "doc-1", {
      timeoutMs: 100,
      verificationIntervalMs: 5,
    }),
    /did not confirm document deletion/,
  );

  const emptyUnverifiedSocket = new FakeWorkspaceSocket({ deleteMode: "empty-ack-still-present" });
  await assert.rejects(
    deleteDoc(emptyUnverifiedSocket, "workspace-1", "doc-1", {
      timeoutMs: 30,
      verificationIntervalMs: 5,
    }),
    /deletion could not be verified within 30ms/,
  );

  const deniedSocket = new FakeWorkspaceSocket({ deleteMode: "error" });
  await assert.rejects(
    deleteDoc(deniedSocket, "workspace-1", "doc-1", {
      timeoutMs: 100,
      verificationIntervalMs: 5,
    }),
    /Doc\.Delete permission denied/,
  );

  const stalledSocket = new FakeWorkspaceSocket({ deleteMode: "stall" });
  await assert.rejects(
    deleteDoc(stalledSocket, "workspace-1", "doc-1", {
      timeoutMs: 30,
      verificationIntervalMs: 5,
    }),
    /deletion could not be verified within 30ms/,
  );
}

async function testDocumentReceipts() {
  const deletedSocket = new FakeWorkspaceSocket({ deleteMode: "void-success" });
  const deleted = parseToolResult(
    await deleteDocFromWorkspace(deletedSocket, "workspace-1", "doc-1"),
  );
  assert.equal(deleted.ok, true);
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.metadataExisted, true);
  assert.equal(deleted.metadataRemoved, true);
  assert.equal(deleted.contentExisted, true);
  assert.equal(deleted.contentDeleted, true);
  assert.equal(deleted.contentDeleteAcknowledged, false);
  assert.equal(deleted.contentAbsenceVerified, true);
  assert.deepEqual(deletedSocket.pageIds(), []);

  const partialSocket = new FakeWorkspaceSocket({ deleteMode: "error" });
  const partialResult = await deleteDocFromWorkspace(partialSocket, "workspace-1", "doc-1");
  const partial = assertStableFailure(partialResult, "doc_content_delete_failed", "partial");
  assert.equal(partial.deleted, false);
  assert.equal(partial.metadataRemoved, true);
  assert.equal(partial.contentDeleted, false);
  assert.match(partial.error, /Doc\.Delete permission denied/);
  assert.deepEqual(partialSocket.pageIds(), []);

  const metadataFailureSocket = new FakeWorkspaceSocket({ pushMode: "error" });
  const metadataFailureResult = await deleteDocFromWorkspace(metadataFailureSocket, "workspace-1", "doc-1");
  const metadataFailure = assertStableFailure(metadataFailureResult, "doc_metadata_delete_failed");
  assert.equal(metadataFailure.metadataRemoved, false);
  assert.equal(metadataFailure.contentDeleted, false);
  assert.match(metadataFailure.error, /workspace metadata sync failed/);
  assert.equal(metadataFailureSocket.events.some(entry => entry.event === "space:delete-doc"), false);
  assert.deepEqual(metadataFailureSocket.pageIds(), ["doc-1"]);

  const alreadyAbsentSocket = new FakeWorkspaceSocket({
    metadataExists: false,
    contentExists: false,
  });
  const alreadyAbsent = parseToolResult(
    await deleteDocFromWorkspace(alreadyAbsentSocket, "workspace-1", "doc-1"),
  );
  assert.equal(alreadyAbsent.ok, true);
  assert.equal(alreadyAbsent.status, "already_absent");
  assert.equal(alreadyAbsent.deleted, false);
  assert.equal(alreadyAbsent.alreadyAbsent, true);
  assert.equal(alreadyAbsent.contentAbsenceVerified, true);
  assert.equal(alreadyAbsentSocket.events.some(entry => entry.event === "space:delete-doc"), false);

  const metadataOnlySocket = new FakeWorkspaceSocket({ contentExists: false });
  const metadataOnly = parseToolResult(
    await deleteDocFromWorkspace(metadataOnlySocket, "workspace-1", "doc-1"),
  );
  assert.equal(metadataOnly.status, "deleted");
  assert.equal(metadataOnly.metadataRemoved, true);
  assert.equal(metadataOnly.contentDeleted, false);
  assert.equal(metadataOnly.contentAbsenceVerified, true);

  await assert.rejects(
    deleteDocFromWorkspace(new FakeWorkspaceSocket(), "workspace-1", "workspace-1"),
    /cannot delete the workspace metadata document/,
  );
}

async function testWorkspaceReceipts() {
  const registry = new ToolRegistry();
  let behavior = "false";
  const gql = {
    async request() {
      if (behavior === "throw") throw new Error("workspace service unavailable");
      return { deleteWorkspace: behavior === "true" };
    },
  };
  registerWorkspaceTools(registry, gql);
  const deleteWorkspace = registry.tools.get("delete_workspace");
  assert.equal(typeof deleteWorkspace, "function");

  const notConfirmedResult = await deleteWorkspace({
    id: "workspace-1",
    confirmWorkspaceId: "workspace-1",
  });
  const notConfirmed = assertStableFailure(notConfirmedResult, "workspace_delete_failed");
  assert.equal(notConfirmed.deleted, false);
  assert.match(notConfirmed.error, /did not confirm workspace deletion/);

  behavior = "throw";
  const failedResult = await deleteWorkspace({
    id: "workspace-1",
    confirmWorkspaceId: "workspace-1",
  });
  const failed = assertStableFailure(failedResult, "workspace_delete_failed");
  assert.equal(failed.deleted, false);
  assert.match(failed.error, /workspace service unavailable/);

  behavior = "true";
  const confirmed = parseToolResult(await deleteWorkspace({
    id: "workspace-1",
    confirmWorkspaceId: "workspace-1",
  }));
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.status, "deleted");
  assert.equal(confirmed.deleted, true);
  assert.equal(confirmed.success, true);
  assert.equal("message" in confirmed, false);
}

async function testBlobReceipts() {
  const registry = new ToolRegistry();
  let behavior = "false";
  const gql = {
    async request(query) {
      if (behavior === "throw") throw new Error("blob service unavailable");
      if (query.includes("deleteBlob")) return { deleteBlob: behavior === "true" };
      if (query.includes("releaseDeletedBlobs")) return { releaseDeletedBlobs: behavior === "true" };
      throw new Error("Unexpected blob mutation");
    },
  };
  registerBlobTools(registry, gql);
  const deleteBlob = registry.tools.get("delete_blob");
  const cleanupBlobs = registry.tools.get("cleanup_blobs");
  assert.equal(typeof deleteBlob, "function");
  assert.equal(typeof cleanupBlobs, "function");

  const unconfirmedDelete = assertStableFailure(
    await deleteBlob({ workspaceId: "workspace-1", key: "blob-1" }),
    "blob_delete_failed",
  );
  assert.equal(unconfirmedDelete.deleted, false);
  assert.match(unconfirmedDelete.error, /did not confirm blob deletion/);

  const unconfirmedCleanup = assertStableFailure(
    await cleanupBlobs({ workspaceId: "workspace-1", confirmWorkspaceId: "workspace-1" }),
    "blob_cleanup_failed",
  );
  assert.equal(unconfirmedCleanup.blobsReleased, false);
  assert.match(unconfirmedCleanup.error, /did not confirm deleted blob cleanup/);

  behavior = "throw";
  const failedDelete = assertStableFailure(
    await deleteBlob({ workspaceId: "workspace-1", key: "blob-1" }),
    "blob_delete_failed",
  );
  assert.match(failedDelete.error, /blob service unavailable/);
  const failedCleanup = assertStableFailure(
    await cleanupBlobs({ workspaceId: "workspace-1", confirmWorkspaceId: "workspace-1" }),
    "blob_cleanup_failed",
  );
  assert.match(failedCleanup.error, /blob service unavailable/);

  behavior = "true";
  const deleted = parseToolResult(await deleteBlob({ workspaceId: "workspace-1", key: "blob-1" }));
  assert.equal(deleted.ok, true);
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.success, true);
  const cleaned = parseToolResult(await cleanupBlobs({
    workspaceId: "workspace-1",
    confirmWorkspaceId: "workspace-1",
  }));
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.status, "completed");
  assert.equal(cleaned.blobsReleased, true);
  assert.equal(cleaned.success, true);
}

async function testAdditionalMutationReceipts() {
  const commentRegistry = new ToolRegistry();
  let commentBehavior = "false";
  registerCommentTools(commentRegistry, {
    async request(query) {
      if (commentBehavior === "throw") throw new Error("comment service unavailable");
      if (query.includes("UpdateComment")) return { updateComment: commentBehavior === "true" };
      if (query.includes("DeleteComment")) return { deleteComment: commentBehavior === "true" };
      if (query.includes("ResolveComment")) return { resolveComment: commentBehavior === "true" };
      throw new Error("Unexpected comment mutation");
    },
  }, {});

  const updateComment = commentRegistry.tools.get("update_comment");
  const deleteComment = commentRegistry.tools.get("delete_comment");
  const resolveComment = commentRegistry.tools.get("resolve_comment");
  assertStableFailure(await updateComment({ id: "comment-1", content: "updated" }), "comment_update_failed", "not_applied");
  assertStableFailure(await deleteComment({ id: "comment-1" }), "comment_delete_failed", "not_applied");
  assertStableFailure(await resolveComment({ id: "comment-1", resolved: true }), "comment_resolve_failed", "not_applied");

  commentBehavior = "throw";
  assertStableFailure(await deleteComment({ id: "comment-1" }), "comment_delete_failed");

  commentBehavior = "true";
  assert.equal(parseToolResult(await updateComment({ id: "comment-1", content: "updated" })).ok, true);
  assert.equal(parseToolResult(await deleteComment({ id: "comment-1" })).ok, true);
  assert.equal(parseToolResult(await resolveComment({ id: "comment-1", resolved: true })).ok, true);

  const tokenRegistry = new ToolRegistry();
  let tokenBehavior = "false";
  registerAccessTokenTools(tokenRegistry, {
    async request() {
      if (tokenBehavior === "throw") throw new Error("token service unavailable");
      return { revokeUserAccessToken: tokenBehavior === "true" };
    },
  });
  const revokeAccessToken = tokenRegistry.tools.get("revoke_access_token");
  assertStableFailure(await revokeAccessToken({ id: "token-1" }), "access_token_revoke_failed", "not_applied");
  tokenBehavior = "throw";
  assertStableFailure(await revokeAccessToken({ id: "token-1" }), "access_token_revoke_failed");
  tokenBehavior = "true";
  assert.equal(parseToolResult(await revokeAccessToken({ id: "token-1" })).ok, true);

  const notificationRegistry = new ToolRegistry();
  let notificationBehavior = "false";
  registerNotificationTools(notificationRegistry, {
    async request(query) {
      if (notificationBehavior === "throw") throw new Error("notification service unavailable");
      if (query.includes("ReadAllNotifications")) {
        return { readAllNotifications: notificationBehavior === "true" };
      }
      return { currentUser: { notifications: { edges: [] } } };
    },
  });
  const listNotifications = notificationRegistry.tools.get("list_notifications");
  const readAllNotifications = notificationRegistry.tools.get("read_all_notifications");
  assertStableFailure(await readAllNotifications({}), "notification_read_all_failed", "not_applied");
  notificationBehavior = "throw";
  assertStableFailure(await listNotifications({}), "notification_list_failed");
  assertStableFailure(await readAllNotifications({}), "notification_read_all_failed");
  notificationBehavior = "true";
  assert.equal(parseToolResult(await readAllNotifications({})).ok, true);

  const workspaceRegistry = new ToolRegistry();
  let workspaceBehavior = "false";
  registerWorkspaceTools(workspaceRegistry, {
    async request(query) {
      if (workspaceBehavior === "throw") throw new Error("workspace update unavailable");
      if (query.includes("UpdateWorkspace")) {
        return {
          updateWorkspace: workspaceBehavior === "true"
            ? { id: "workspace-1", public: true, enableAi: false }
            : null,
        };
      }
      throw new Error("Unexpected workspace mutation");
    },
  });
  const updateWorkspace = workspaceRegistry.tools.get("update_workspace");
  assertStableFailure(await updateWorkspace({ id: "workspace-1", public: true }), "workspace_update_failed", "not_applied");
  workspaceBehavior = "throw";
  assertStableFailure(await updateWorkspace({ id: "workspace-1", public: true }), "workspace_update_failed");
  workspaceBehavior = "true";
  assert.equal(parseToolResult(await updateWorkspace({ id: "workspace-1", public: true })).ok, true);
}

await testDeleteDocProtocol();
await testDocumentReceipts();
await testWorkspaceReceipts();
await testBlobReceipts();
await testAdditionalMutationReceipts();
console.log("Destructive mutation acknowledgement tests passed");
