/**
 * Test create_doc_from_markdown formatting against the deployed HTTP server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = process.env.MCP_SERVER_URL || "http://nas.fairleadsoftware.com:3002/mcp";
const TOKEN = process.env.AFFINE_MCP_HTTP_TOKEN;
const WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;

if (!TOKEN || !WORKSPACE_ID) {
  console.error("Required: AFFINE_MCP_HTTP_TOKEN, AFFINE_WORKSPACE_ID");
  process.exit(1);
}

const client = new Client({ name: "debug-http", version: "1.0" });
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});

await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r?.content?.[0]?.text);
};

const md = `# Formatting Test

**Bold text**
*Italic text*
~~Strikethrough text~~
\`Inline code\`

> A **bold** quote.`;

console.log("Testing against:", SERVER_URL);

const doc = await call("create_doc_from_markdown", {
  workspaceId: WORKSPACE_ID,
  title: "http-formatting-test",
  markdown: md,
});
console.log("created:", doc.docId);

const exp = await call("export_doc_markdown", {
  workspaceId: WORKSPACE_ID,
  docId: doc.docId,
});
console.log("--- exported ---");
console.log(exp.markdown);
console.log("---");
console.log("**Bold**:       ", exp.markdown.includes("**Bold text**"));
console.log("*Italic*:       ", exp.markdown.includes("*Italic text*"));
console.log("~~Strike~~:     ", exp.markdown.includes("~~Strikethrough text~~"));
console.log("`Inline code`:  ", exp.markdown.includes("`Inline code`"));
console.log("> **bold**:     ", /> .*\*\*bold\*\*/.test(exp.markdown));

await call("delete_doc", { workspaceId: WORKSPACE_ID, docId: doc.docId });
await client.close();
