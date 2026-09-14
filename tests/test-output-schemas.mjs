import "./require-destructive-test-safety.mjs";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

import { ALL_TOOLS, toolAnnotationsFor } from "../src/toolSurface.ts";
import { registerBlobTools } from "../src/tools/blobStorage.ts";
import { registerDocTools } from "../src/tools/docs.ts";
import { TOOLS_WITH_ERROR_OUTPUT, toolOutputSchemaFor } from "../src/toolOutputSchemas.ts";
import { stripSchemaDialect, text, toolError } from "../src/util/mcp.ts";

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
  causeCode: "upstream_unavailable",
  retryable: false,
  recoveryGuidance: "Inspect the error and follow the suggested recovery action.",
  details: { attempt: 1 },
  operation: "test",
};
assert.equal(TOOLS_WITH_ERROR_OUTPUT.length, ALL_TOOLS.length, "every canonical tool must support the shared error envelope");
for (const name of TOOLS_WITH_ERROR_OUTPUT) {
  const parsed = toolOutputSchemaFor(name).safeParse(representativeError);
  assert.equal(parsed.success, true, `${name} rejected the shared error envelope`);
  if (!toolAnnotationsFor(name).readOnlyHint || name === "read_doc") {
    assert.equal(toolOutputSchemaFor(name).safeParse({}).success, false, `${name} accepted an empty success result`);
  }
}

assert.equal(
  toolOutputSchemaFor("list_tags").safeParse({
    ok: false,
    error: "Workspace root unavailable",
    code: "workspace_root_unavailable",
    retryable: false,
    recoveryGuidance: "Check the workspace before treating it as empty.",
  }).success,
  true,
  "discovery tools must accept workspace-root recovery guidance",
);

const columnOutput = { added: true, columnId: "col-1", name: "Status", type: "select" };
const columnSchema = toolOutputSchemaFor("add_database_column");
const invalidColumnOutputs = [
  {},
  { ok: true },
  { ...columnOutput, columnId: undefined },
  { ...columnOutput, columnId: 42 },
  { ok: false, error: "Missing error metadata" },
  { ...representativeError, ok: true },
];
for (const result of invalidColumnOutputs) {
  assert.equal(columnSchema.safeParse(result).success, false, "incomplete success/error results must be rejected");
}
assert.equal(columnSchema.safeParse(columnOutput).success, true);
assert.equal(columnSchema.safeParse({ ...columnOutput, futureField: "compatible" }).success, true);
assert.equal(toolOutputSchemaFor("create_doc").safeParse({
  kind: "doc.create", ok: true, workspaceId: "workspace-1", docId: "doc-1", title: "Example",
  parentDocId: null, linkedToParent: false, folderId: null, folderLinked: false, folderNodeId: null, warnings: [],
}).success, true, "successful document creation must not require failure-only recovery metadata");

// Client.callTool validates structuredContent against cached output schemas
// even for isError responses. Exercise the wire contract after tools/list.
const queueErrorServer = new McpServer({ name: "queue-error-schema-test", version: "1.0.0" });
for (const name of TOOLS_WITH_ERROR_OUTPUT) {
  queueErrorServer.registerTool(name, { inputSchema: {}, outputSchema: toolOutputSchemaFor(name) }, async () =>
    toolError("The queued operation did not run", { code: "WRITE_QUEUE_FULL", retryable: true }),
  );
}
const queueErrorClient = await connectInMemory(queueErrorServer, "queue-error-schema-test");
try {
  const advertised = (await queueErrorClient.listTools()).tools;
  const workspaceSchema = advertised.find(tool => tool.name === "get_workspace").outputSchema;
  for (const field of ["name", "avatar", "url", "profileStatus"]) {
    assert.ok(workspaceSchema.properties[field], `get_workspace must advertise ${field}`);
    assert.ok(advertised.find(tool => tool.name === "list_workspaces")
      .outputSchema.properties.items.items.properties[field], `workspace list items must advertise ${field}`);
  }
  for (const name of TOOLS_WITH_ERROR_OUTPUT) {
    const result = await queueErrorClient.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, `${name} must deliver its structured error to schema-validating clients`);
    assert.equal(result.structuredContent.code, "WRITE_QUEUE_FULL");
  }
} finally {
  await queueErrorClient.close();
  await queueErrorServer.close();
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

const trashStateOutput = {
  kind: "doc.trash",
  ok: true,
  status: "trashed",
  workspaceId: "workspace-1",
  docId: "doc-1",
  title: "Example",
  changed: true,
  previouslyInTrash: false,
  inTrash: true,
  trashDate: Date.now(),
  readBackVerified: true,
};
assert.equal(toolOutputSchemaFor("trash_doc").safeParse(trashStateOutput).success, true);
assert.equal(toolOutputSchemaFor("restore_doc").safeParse({
  ...trashStateOutput,
  kind: "doc.restore",
  status: "restored",
  inTrash: false,
  trashDate: null,
}).success, true);
assert.equal(
  toolOutputSchemaFor("trash_doc").safeParse({ ...trashStateOutput, readBackVerified: "yes" }).success,
  false,
  "trash_doc must advertise readBackVerified as a boolean",
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
let columnPayload = columnOutput;
server.registerTool(
  "add_database_column",
  {
    inputSchema: {},
    outputSchema: toolOutputSchemaFor("add_database_column"),
  },
  async () => text(columnPayload),
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
stripSchemaDialect(server);

const client = await connectInMemory(server, "output-schema-test");

const listed = await client.listTools();
for (const tool of listed.tools) {
  assert.equal(tool.outputSchema?.type, "object", `${tool.name} did not advertise an object output schema`);
  // Clients that only support JSON Schema 2020-12 reject any declared dialect.
  assert.equal(tool.inputSchema.$schema, undefined, `${tool.name} advertised a JSON Schema dialect on its input schema`);
  assert.equal(tool.outputSchema.$schema, undefined, `${tool.name} advertised a JSON Schema dialect on its output schema`);
}
const listedByName = Object.fromEntries(listed.tools.map(tool => [tool.name, tool]));
assert.equal(listedByName.add_database_column.outputSchema.anyOf.length, 2);
assert.deepEqual(listedByName.add_database_column.outputSchema.anyOf[0].required,
  ["added", "columnId", "name", "type"]);
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

for (const payload of [{}, { ...columnOutput, columnId: undefined }]) {
  columnPayload = payload;
  const rejected = await client.callTool({ name: "add_database_column", arguments: {} });
  assert.equal(rejected.isError, true, "the server must reject an incomplete successful write result");
}
columnPayload = columnOutput;

// A low-level server deliberately bypasses server-side output validation so
// this independently proves that tools/list preserves the client-side branches.
const wireServer = new Server({ name: "output-schema-wire-test", version: "1.0.0" }, { capabilities: { tools: {} } });
let wireResult = text(columnOutput);
wireServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [listedByName.add_database_column] }));
wireServer.setRequestHandler(CallToolRequestSchema, async () => wireResult);
const wireClient = await connectInMemory(wireServer, "output-schema-wire-test");
try {
  await wireClient.listTools();
  for (const payload of invalidColumnOutputs) {
    wireResult = { ...text(payload), ...(payload.ok === false ? { isError: true } : {}) };
    await assert.rejects(wireClient.callTool({ name: "add_database_column", arguments: {} }),
      error => error instanceof McpError && error.code === ErrorCode.InvalidParams,
      "the client must reject invalid success and error branches");
  }
  wireResult = text(columnOutput);
  assert.deepEqual((await wireClient.callTool({ name: "add_database_column", arguments: {} })).structuredContent, columnOutput);
  wireResult = toolError("Queued write did not run", { code: "WRITE_QUEUE_FULL", retryable: true });
  assert.equal((await wireClient.callTool({ name: "add_database_column", arguments: {} })).isError, true);
} finally {
  await wireClient.close();
  await wireServer.close();
}

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
  recoveryGuidance: "Check the error details and active workspace. For a write, inspect the target before retrying to avoid duplicating a completed change.",
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
  recoveryGuidance: "Check the error details and active workspace. For a write, inspect the target before retrying to avoid duplicating a completed change.",
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
for (const name of ["create_mindmap", "add_mindmap_node", "update_mindmap_node", "reparent_mindmap_node"]) {
  const definition = listedDocTools.tools.find(tool => tool.name === name);
  assert.equal(definition?.outputSchema?.properties?.nodeId?.type, "string", `${name} must advertise nodeId`);
  assert.equal(toolOutputSchemaFor(name).safeParse({ ok: true, nodeId: 42 }).success, false);
  assert.equal(toolOutputSchemaFor(name).safeParse(representativeError).success, true);
}
const getDocDefinition = listedDocTools.tools.find(tool => tool.name === "get_doc");
assert.equal(getDocDefinition.outputSchema?.type, "object");
assert.equal(getDocDefinition.outputSchema?.properties?.value?.type, "null");
const listDocsDefinition = listedDocTools.tools.find(tool => tool.name === "list_docs");
assert.deepEqual(Object.keys(listDocsDefinition.outputSchema.properties).sort(), [
  "causeCode",
  "code",
  "details",
  "edges",
  "error",
  "ok",
  "pageInfo",
  "recoveryGuidance",
  "retryable",
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
