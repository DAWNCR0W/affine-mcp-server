import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ALL_TOOLS } from "../src/toolSurface.ts";
import { registerAccessTokenTools } from "../src/tools/accessTokens.ts";
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
registerAccessTokenTools(server, {
  async request() {
    return { revokeUserAccessToken: false };
  },
});

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

await client.close();
await server.close();

console.log(`Verified output schema coverage for ${ALL_TOOLS.length} tools.`);
