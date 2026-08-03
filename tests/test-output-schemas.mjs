import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ALL_TOOLS } from "../src/toolSurface.ts";
import { registerBlobTools } from "../src/tools/blobStorage.ts";
import { registerDocTools } from "../src/tools/docs.ts";
import { TOOLS_WITH_ERROR_OUTPUT, toolOutputSchemaFor } from "../src/toolOutputSchemas.ts";
import { text } from "../src/util/mcp.ts";

function installOutputSchemaRegistration(server) {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, options, handler) => registerTool(
    name,
    { ...options, outputSchema: options.outputSchema ?? toolOutputSchemaFor(name) },
    handler,
  );
}

async function connectInMemory(server, label) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `${label}-client`, version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

for (const name of ALL_TOOLS) {
  assert.ok(toolOutputSchemaFor(name), `${name} is missing an output schema`);
}

assert.equal(toolOutputSchemaFor("not_a_real_tool"), undefined);

const arrayTextResult = text(["one", "two"]);
assert.deepEqual(arrayTextResult.content, [{ type: "text", text: '["one","two"]' }]);
assert.deepEqual(arrayTextResult.structuredContent, { items: ["one", "two"] });

const stringTextResult = text("hello");
assert.deepEqual(stringTextResult.content, [{ type: "text", text: "hello" }]);
assert.deepEqual(stringTextResult.structuredContent, { text: "hello" });

const numberTextResult = text(42);
assert.deepEqual(numberTextResult.content, [{ type: "text", text: "42" }]);
assert.deepEqual(numberTextResult.structuredContent, { value: 42 });

const nullTextResult = text(null);
assert.deepEqual(nullTextResult.content, [{ type: "text", text: "null" }]);
assert.deepEqual(nullTextResult.structuredContent, { value: null });

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

const deleteTagOutput = {
  workspaceId: "workspace-1",
  tag: "Important",
  tagId: "tag-1",
  value: "Important",
  deleted: true,
  affectedDocs: 3,
  docMetaSynced: 2,
  warnings: [],
};
assert.equal(
  toolOutputSchemaFor("delete_tag").safeParse(deleteTagOutput).success,
  true,
  "delete_tag must accept the numeric document metadata sync count returned by its handler",
);
assert.equal(
  toolOutputSchemaFor("delete_tag").safeParse({ ...deleteTagOutput, docMetaSynced: true }).success,
  false,
  "delete_tag must not advertise docMetaSynced as a boolean",
);

assert.equal(toolOutputSchemaFor("get_doc").safeParse({ id: "doc-1" }).success, true);
assert.equal(toolOutputSchemaFor("get_doc").safeParse({ value: null }).success, true);
assert.equal(toolOutputSchemaFor("get_doc").safeParse({ value: "missing" }).success, false);

const frameChildrenOutput = {
  updated: true,
  blockId: "frame-1",
  flavour: "affine:frame",
  ownedIds: ["shape-1"],
  missing: [],
  resized: true,
  xywh: { x: 10, y: 20, width: 300, height: 200 },
};
assert.equal(toolOutputSchemaFor("update_frame_children").safeParse(frameChildrenOutput).success, true);
assert.equal(
  toolOutputSchemaFor("update_frame_children").safeParse({ ...frameChildrenOutput, xywh: "[10,20,300,200]" }).success,
  false,
  "update_frame_children must advertise the parsed frame bounds returned by its handler",
);

const server = new McpServer({ name: "output-schema-test", version: "1.0.0" });
installOutputSchemaRegistration(server);
server.registerTool(
  "add_database_column",
  {
    inputSchema: {},
    outputSchema: toolOutputSchemaFor("add_database_column"),
  },
  async () => text({ added: true, columnId: "col-1", name: "Status", type: "select" }),
);
server.registerTool(
  "list_collections",
  {
    inputSchema: {},
    outputSchema: toolOutputSchemaFor("list_collections"),
  },
  async () => text([{ id: "collection-1", name: "Example" }]),
);

const backendResults = {
  deleteBlob: true,
  releaseDeletedBlobs: true,
};
const gql = {
  endpoint: "http://127.0.0.1:1/graphql",
  headers: {},
  cookie: undefined,
  async request(query) {
    if (query.includes("deleteBlob")) {
      return { deleteBlob: backendResults.deleteBlob };
    }
    if (query.includes("releaseDeletedBlobs")) {
      return { releaseDeletedBlobs: backendResults.releaseDeletedBlobs };
    }
    throw new Error("Unexpected GraphQL request in output-schema test");
  },
};
registerBlobTools(server, gql);

const client = await connectInMemory(server, "output-schema-test");

const listed = await client.listTools();
for (const tool of listed.tools) {
  assert.equal(tool.outputSchema?.type, "object", `${tool.name} did not advertise an object output schema`);
}
const listedByName = Object.fromEntries(listed.tools.map(tool => [tool.name, tool]));
assert.equal(listedByName.upload_blob.outputSchema.properties.encoding.type, "string");
for (const field of ["kind", "status", "ok", "deleted", "success"]) {
  assert.ok(
    listedByName.delete_blob.outputSchema.properties[field],
    `delete_blob output schema is missing ${field}`,
  );
}
for (const field of ["kind", "status", "ok", "blobsReleased", "success"]) {
  assert.ok(
    listedByName.cleanup_blobs.outputSchema.properties[field],
    `cleanup_blobs output schema is missing ${field}`,
  );
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

const collectionListResult = await client.callTool({ name: "list_collections", arguments: {} });
assert.deepEqual(collectionListResult.content, [{
  type: "text",
  text: '[{"id":"collection-1","name":"Example"}]',
}]);
assert.deepEqual(collectionListResult.structuredContent, {
  items: [{ id: "collection-1", name: "Example" }],
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

backendResults.deleteBlob = false;
const failedDeleteBlobResult = await client.callTool({
  name: "delete_blob",
  arguments: { workspaceId: "workspace-1", key: "blob-1" },
});
assert.equal(failedDeleteBlobResult.isError, true);
assert.deepEqual(failedDeleteBlobResult.structuredContent, {
  kind: "blob.delete",
  status: "not_applied",
  workspaceId: "workspace-1",
  key: "blob-1",
  permanently: false,
  deleted: false,
  ok: false,
  error: "AFFiNE did not confirm blob deletion.",
  code: "blob_delete_failed",
  retryable: false,
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

const docServer = new McpServer({ name: "get-doc-output-schema-test", version: "1.0.0" });
installOutputSchemaRegistration(docServer);
const listDocsPayload = {
  totalCount: 1,
  pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
  edges: [{
    cursor: "cursor-1",
    node: { id: "doc-1", workspaceId: "workspace-1", title: "Example" },
  }],
};
const docGql = {
  async request(query, variables) {
    if (query.includes("query ListDocs")) {
      return { workspace: { docs: listDocsPayload } };
    }
    if (query.includes("query GetDoc")) {
      return {
        workspace: {
          doc: variables.docId === "missing-doc"
            ? null
            : { id: variables.docId, workspaceId: variables.workspaceId, title: "Example" },
        },
      };
    }
    throw new Error("Unexpected GraphQL request in document output-schema test");
  },
};
registerDocTools(docServer, docGql, { workspaceId: "workspace-1" });
const docClient = await connectInMemory(docServer, "get-doc-output-schema-test");

const listedDocTools = await docClient.listTools();
const getDocDefinition = listedDocTools.tools.find(tool => tool.name === "get_doc");
assert.equal(getDocDefinition.outputSchema?.type, "object");
assert.equal(getDocDefinition.outputSchema?.properties?.value?.type, "null");
const listDocsDefinition = listedDocTools.tools.find(tool => tool.name === "list_docs");
assert.deepEqual(Object.keys(listDocsDefinition.outputSchema.properties).sort(), [
  "edges",
  "pageInfo",
  "totalCount",
]);

const listDocsResult = await docClient.callTool({ name: "list_docs", arguments: {} });
assert.deepEqual(listDocsResult.structuredContent, {
  ...listDocsPayload,
  edges: [{
    cursor: "cursor-1",
    node: {
      id: "doc-1",
      workspaceId: "workspace-1",
      title: "Example",
      tags: [],
      inTrash: false,
    },
  }],
});

const existingDocResult = await docClient.callTool({
  name: "get_doc",
  arguments: { docId: "doc-1" },
});
assert.deepEqual(existingDocResult.structuredContent, {
  id: "doc-1",
  workspaceId: "workspace-1",
  title: "Example",
});

const missingDocResult = await docClient.callTool({
  name: "get_doc",
  arguments: { docId: "missing-doc" },
});
assert.deepEqual(missingDocResult.content, [{ type: "text", text: "null" }]);
assert.deepEqual(missingDocResult.structuredContent, { value: null });

await docClient.close();
await docServer.close();

console.log(`Verified output schema coverage for ${ALL_TOOLS.length} tools.`);
