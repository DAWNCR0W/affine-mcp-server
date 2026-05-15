#!/usr/bin/env node
/**
 * Live integration test for markdown rich-text import/export round-trip.
 *
 * Requires environment variables:
 *   AFFINE_MCP_HTTP_URL      - base MCP server URL, e.g. http://localhost:3002/mcp
 *   AFFINE_MCP_HTTP_TOKEN    - bearer token
 *   AFFINE_WORKSPACE_ID      - workspace ID to run the test against
 *
 * Creates a doc, exports it, asserts all marks survive, then deletes the doc.
 */
import assert from 'node:assert/strict';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = process.env.AFFINE_MCP_HTTP_URL;
const TOKEN = process.env.AFFINE_MCP_HTTP_TOKEN;
const WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;

if (!SERVER_URL) throw new Error("AFFINE_MCP_HTTP_URL is required");
if (!TOKEN) throw new Error("AFFINE_MCP_HTTP_TOKEN is required");
if (!WORKSPACE_ID) throw new Error("AFFINE_WORKSPACE_ID is required");

const client = new Client({ name: "test-markdown-rich-text-import-live", version: "1.0" });
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r?.content?.[0]?.text);
};

const markdown = "# Test\n\n**Bold text**\n*Italic text*\n~~Strikethrough~~\n`Inline code`\n\n**Bold and *italic* combined**";

console.log("Creating doc...");
const doc = await call("create_doc_from_markdown", { workspaceId: WORKSPACE_ID, title: "Inline Formatting Test", markdown });
console.log("created:", doc.docId);

let failed = false;
try {
  const exp = await call("export_doc_markdown", { workspaceId: WORKSPACE_ID, docId: doc.docId });
  console.log("\nExported markdown:");
  console.log(exp.markdown);
  console.log();

  const checks = [
    ["**Bold text** preserved",          () => assert.ok(exp.markdown.includes("**Bold text**"))],
    ["~~Strikethrough~~ preserved",       () => assert.ok(exp.markdown.includes("~~Strikethrough~~"))],
    ["`Inline code` preserved",           () => assert.ok(exp.markdown.includes("`Inline code`"))],
    ["bold+italic combination preserved", () => assert.ok(/\*{2,3}Bold and [\*_]italic[\*_]\*{2,3}/.test(exp.markdown))],
  ];

  for (const [name, fn] of checks) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch {
      console.error(`  ✗ ${name}`);
      failed = true;
    }
  }
} finally {
  await call("delete_doc", { workspaceId: WORKSPACE_ID, docId: doc.docId });
  console.log("\ncleaned up doc", doc.docId);
  await client.close();
}

if (failed) process.exit(1);
