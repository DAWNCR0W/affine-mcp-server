import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = "http://nas.fairleadsoftware.com:3002/mcp";
const TOKEN = process.env.AFFINE_MCP_HTTP_TOKEN;
const WORKSPACE_ID = "cebf9206-76b3-4c77-a43f-2e72cb5ad426";

const client = new Client({ name: "debug-bugreport", version: "1.0" });
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r?.content?.[0]?.text);
};

const markdown = "# Markdown Formatting Test 2026-04-03\n\n## Text Styling\n\n**Bold text**\n*Italic text*\n~~Strikethrough text~~\n`Inline code`\n\n## Lists\n\n- Bullet item 1\n- Bullet item 2\n  - Nested bullet\n- Bullet item 3\n\n1. Numbered item 1\n2. Numbered item 2\n3. Numbered item 3\n\n## Code Block\n\n```python\ndef hello():\n    print(\"Hello, Affine!\")\n```\n\n## Tables\n\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Row 1 Col 1 | Row 1 Col 2 | Row 1 Col 3 |\n| Row 2 Col 1 | Row 2 Col 2 | Row 2 Col 3 |\n\n## Links\n\n[Example.com](https://example.com)\n\n## Blockquote\n\n> This is a blockquote. It can span multiple lines.\n> It's useful for highlighting important text.\n\n## Horizontal Rule\n\n---\n\n## Mixed Formatting\n\n**Bold and *italic* combined**\n*Italic with **bold** inside*";

console.log("Creating doc with bug report markdown...");
const doc = await call("create_doc_from_markdown", {
  workspaceId: WORKSPACE_ID,
  title: "Markdown Formatting Test 2026-04-03",
  markdown,
});
console.log("created:", doc.docId);

const exp = await call("export_doc_markdown", {
  workspaceId: WORKSPACE_ID,
  docId: doc.docId,
});

console.log("\n--- exported markdown ---");
console.log(exp.markdown);
console.log("---\n");

const checks = [
  ["**Bold text**",            /\*\*Bold text\*\*/],
  ["*Italic text*",            /\*Italic text\*/],
  ["~~Strikethrough text~~",   /~~Strikethrough text~~/],
  ["`Inline code`",            /`Inline code`/],
  ["[Example.com](url)",       /\[Example\.com\]/],
  ["> blockquote",             /^>/m],
  ["**Bold and *italic*",      /\*\*Bold and \*italic\*/],
];

let passed = 0, failed = 0;
for (const [label, pattern] of checks) {
  const ok = pattern.test(exp.markdown);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  ok ? passed++ : failed++;
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);

await call("delete_doc", { workspaceId: WORKSPACE_ID, docId: doc.docId });
await client.close();
