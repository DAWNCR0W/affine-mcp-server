import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = "http://nas.fairleadsoftware.com:3002/mcp";
const TOKEN = process.env.AFFINE_MCP_HTTP_TOKEN;
const WORKSPACE_ID = "cebf9206-76b3-4c77-a43f-2e72cb5ad426";

const client = new Client({ name: "debug-exact", version: "1.0" });
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r?.content?.[0]?.text);
};

// Exact markdown from the failing MCP call
const markdown = "# Test\n\n**Bold text**\n*Italic text*\n~~Strikethrough~~\n`Inline code`\n\n**Bold and *italic* combined**";

console.log("Input markdown:");
console.log(markdown);
console.log("\nCreating doc...");

const doc = await call("create_doc_from_markdown", { workspaceId: WORKSPACE_ID, title: "Inline Formatting Test", markdown });
console.log("created:", doc.docId);

const exp = await call("export_doc_markdown", { workspaceId: WORKSPACE_ID, docId: doc.docId });
console.log("\nExported markdown:");
console.log(exp.markdown);
console.log("\nChecks:");
console.log("**Bold text**:              ", exp.markdown.includes("**Bold text**"));
console.log("*Italic text*:              ", exp.markdown.includes("*Italic text*"));
console.log("~~Strikethrough~~:          ", exp.markdown.includes("~~Strikethrough~~"));
console.log("`Inline code`:              ", exp.markdown.includes("`Inline code`"));
console.log("**Bold and *italic*:        ", /\*\*Bold and \*italic\*/.test(exp.markdown));

await call("delete_doc", { workspaceId: WORKSPACE_ID, docId: doc.docId });
await client.close();
