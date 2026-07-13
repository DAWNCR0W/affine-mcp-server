import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ALL_TOOLS } from "../src/toolSurface.ts";
import { registerAccessTokenTools } from "../src/tools/accessTokens.ts";
import { registerBlobTools } from "../src/tools/blobStorage.ts";
import { TOOLS_WITH_ERROR_OUTPUT, toolOutputSchemaFor } from "../src/toolOutputSchemas.ts";
import { text } from "../src/util/mcp.ts";

for (const name of ALL_TOOLS) {
  assert.ok(toolOutputSchemaFor(name), `${name} is missing an output schema`);
}

assert.equal(toolOutputSchemaFor("not_a_real_tool"), undefined);
assert.deepEqual(text(["one", "two"]).structuredContent, { items: ["one", "two"] });
assert.deepEqual(text("hello").structuredContent, { text: "hello" });
assert.deepEqual(text(42).structuredContent, { value: 42 });

const representativeError = {
  ok: false,
  error: "Operation failed",
  code: "operation_failed",
  retryable: false,
  details: { attempt: 1 },
  operation: "test",
};
for (const name of TOOLS_WITH_ERROR_OUTPUT) {
  const parsed = toolOutputSchemaFor(name).safeParse(representativeError);
  assert.equal(parsed.success, true, `${name} rejected the shared error envelope`);
}

const server = new McpServer({ name: "output-schema-test", version: "1.0.0" });
const registerTool = server.registerTool.bind(server);
server.registerTool = (name, options, handler) => registerTool(
  name,
  { ...options, outputSchema: options.outputSchema ?? toolOutputSchemaFor(name) },
  handler,
);
server.registerTool(
  "add_database_column",
  {
    inputSchema: {},
    outputSchema: toolOutputSchemaFor("add_database_column"),
  },
  async () => text({ added: true, columnId: "col-1", name: "Status", type: "select" })
);
server.registerTool(
  "list_docs",
  {
    inputSchema: {},
    outputSchema: toolOutputSchemaFor("list_docs"),
  },
  async () => text([{ id: "doc-1", title: "Example" }])
);
const backendResults = {
  revokeUserAccessToken: false,
  deleteBlob: true,
  releaseDeletedBlobs: true,
};
const gql = {
  endpoint: "http://127.0.0.1:1/graphql",
  headers: {},
  cookie: undefined,
  async request(query) {
    if (query.includes("revokeUserAccessToken")) {
      return { revokeUserAccessToken: backendResults.revokeUserAccessToken };
    }
    if (query.includes("deleteBlob")) {
      return { deleteBlob: backendResults.deleteBlob };
    }
    if (query.includes("releaseDeletedBlobs")) {
      return { releaseDeletedBlobs: backendResults.releaseDeletedBlobs };
    }
    throw new Error("Unexpected GraphQL request in output-schema test");
  },
};
registerAccessTokenTools(server, gql);
registerBlobTools(server, gql);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "output-schema-test-client", version: "1.0.0" });

await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const listed = await client.listTools();
for (const tool of listed.tools) {
  assert.equal(tool.outputSchema?.type, "object", `${tool.name} did not advertise an object output schema`);
}

const columnResult = await client.callTool({ name: "add_database_column", arguments: {} });
assert.deepEqual(columnResult.content, [{
  type: "text",
  text: '{"added":true,"columnId":"col-1","name":"Status","type":"select"}',
}]);
assert.deepEqual(columnResult.structuredContent, {
  added: true,
  columnId: "col-1",
  name: "Status",
  type: "select",
});

const listResult = await client.callTool({ name: "list_docs", arguments: {} });
assert.deepEqual(listResult.content, [{
  type: "text",
  text: '[{"id":"doc-1","title":"Example"}]',
}]);
assert.deepEqual(listResult.structuredContent, { items: [{ id: "doc-1", title: "Example" }] });

const revokeResult = await client.callTool({
  name: "revoke_access_token",
  arguments: { id: "token-1" },
});
assert.equal(revokeResult.isError, true);
assert.deepEqual(revokeResult.structuredContent, {
  kind: "access_token.revoke",
  status: "not_applied",
  tokenId: "token-1",
  id: "token-1",
  ok: false,
  error: "AFFiNE did not confirm access token revocation.",
  code: "access_token_revoke_failed",
  retryable: false,
});

backendResults.revokeUserAccessToken = true;
const successfulRevokeResult = await client.callTool({
  name: "revoke_access_token",
  arguments: { id: "token-1" },
});
assert.equal(successfulRevokeResult.isError, undefined);
assert.deepEqual(successfulRevokeResult.structuredContent, {
  kind: "access_token.revoke",
  status: "revoked",
  tokenId: "token-1",
  id: "token-1",
  revoked: true,
  success: true,
  ok: true,
});

const successfulDeleteBlobResult = await client.callTool({
  name: "delete_blob",
  arguments: { workspaceId: "workspace-1", key: "blob-1" },
});
assert.equal(successfulDeleteBlobResult.isError, undefined);
assert.deepEqual(successfulDeleteBlobResult.structuredContent, {
  kind: "blob.delete",
  status: "deleted",
  key: "blob-1",
  workspaceId: "workspace-1",
  permanently: false,
  deleted: true,
  success: true,
  ok: true,
});

const successfulCleanupBlobsResult = await client.callTool({
  name: "cleanup_blobs",
  arguments: { workspaceId: "workspace-1", confirmWorkspaceId: "workspace-1" },
});
assert.equal(successfulCleanupBlobsResult.isError, undefined);
assert.deepEqual(successfulCleanupBlobsResult.structuredContent, {
  kind: "blob.cleanup",
  status: "completed",
  workspaceId: "workspace-1",
  blobsReleased: true,
  success: true,
  ok: true,
});

backendResults.releaseDeletedBlobs = false;
const failedCleanupBlobsResult = await client.callTool({
  name: "cleanup_blobs",
  arguments: { workspaceId: "workspace-1", confirmWorkspaceId: "workspace-1" },
});
assert.equal(failedCleanupBlobsResult.isError, true);
assert.deepEqual(failedCleanupBlobsResult.structuredContent, {
  kind: "blob.cleanup",
  status: "not_applied",
  workspaceId: "workspace-1",
  blobsReleased: false,
  ok: false,
  error: "AFFiNE did not confirm deleted blob cleanup.",
  code: "blob_cleanup_failed",
  retryable: false,
});

await client.close();
await server.close();

console.log(`Verified output schema coverage for ${ALL_TOOLS.length} tools.`);
