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
import { parseMarkdownToOperations } from "../dist/markdown/parse.js";

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

  // Parse the exported markdown once and walk every run so we can assert on
  // the actual delta attributes rather than chasing fragile string patterns.
  const allDeltas = parseMarkdownToOperations(exp.markdown)
    .operations
    .flatMap(op => op.deltas ?? []);
  const findRun = (text) => allDeltas.find(d => d.insert === text);
  const findRunContaining = (substr) => allDeltas.find(d => typeof d.insert === "string" && d.insert.includes(substr));

  const checks = [
    ["bold text run carries bold attribute",          () => assert.ok(findRun("Bold text")?.attributes?.bold)],
    ["italic text run carries italic attribute",      () => assert.ok(findRun("Italic text")?.attributes?.italic)],
    ["strikethrough run carries strike attribute",    () => assert.ok(findRun("Strikethrough")?.attributes?.strike)],
    ["inline code run carries code attribute",        () => assert.ok(findRun("Inline code")?.attributes?.code)],
    ["bold+italic 'italic' run carries both marks",   () => {
      const r = findRun("italic");
      assert.ok(r?.attributes?.bold && r?.attributes?.italic, "expected bold+italic on the 'italic' run");
    }],
    ["bold+italic 'Bold and' segment stays bold",     () => {
      const r = findRunContaining("Bold and");
      assert.ok(r?.attributes?.bold, "expected 'Bold and' segment to stay bold");
    }],
    ["bold+italic 'combined' segment stays bold",     () => {
      const r = findRunContaining("combined");
      assert.ok(r?.attributes?.bold, "expected 'combined' segment to stay bold");
    }],
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
