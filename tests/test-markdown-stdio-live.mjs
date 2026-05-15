#!/usr/bin/env node
/**
 * Live integration test for markdown round-trip over the stdio MCP transport.
 *
 * Complements test-markdown-rich-text-import-live.mjs (which uses HTTP):
 * this variant boots a local stdio MCP server child process and exercises
 * a broader markdown surface — headings, inline marks, lists, code blocks.
 *
 * Requires environment variables:
 *   AFFINE_BASE_URL       - AFFiNE instance base URL
 *   AFFINE_EMAIL          - login email
 *   AFFINE_PASSWORD       - login password
 *   AFFINE_WORKSPACE_ID   - workspace ID to run the test against
 *
 * Creates a doc, exports it, parses the result through parseMarkdownToOperations,
 * asserts the structure survived, then deletes the doc.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseMarkdownToOperations } from "../dist/markdown/parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.AFFINE_BASE_URL;
const EMAIL = process.env.AFFINE_EMAIL;
const PASSWORD = process.env.AFFINE_PASSWORD;
const WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;

if (!BASE_URL) throw new Error("AFFINE_BASE_URL is required");
if (!EMAIL) throw new Error("AFFINE_EMAIL is required");
if (!PASSWORD) throw new Error("AFFINE_PASSWORD is required");
if (!WORKSPACE_ID) throw new Error("AFFINE_WORKSPACE_ID is required");

const markdown = `# Markdown Formatting Test

## Text Styling

**Bold text**
*Italic text*
~~Strikethrough text~~
\`Inline code\`

## Lists

- Bullet item 1
- Bullet item 2
- Bullet item 3

1. Numbered item 1
2. Numbered item 2
3. Numbered item 3

## Code Block

\`\`\`python
def hello():
    print("Hello, Affine!")
\`\`\``;

const client = new Client({ name: "test-markdown-stdio-live", version: "1.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve(__dirname, "..", "dist", "index.js")],
  env: {
    ...process.env,
    AFFINE_BASE_URL: BASE_URL,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: "sync",
  },
});
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r?.content?.[0]?.text);
};

console.log("Creating doc...");
const doc = await call("create_doc_from_markdown", { workspaceId: WORKSPACE_ID, title: "Formatting Test (stdio live)", markdown });
console.log("created:", doc.docId);

let failed = false;
try {
  const exp = await call("export_doc_markdown", { workspaceId: WORKSPACE_ID, docId: doc.docId });
  console.log("\nExported markdown:");
  console.log(exp.markdown);
  console.log();

  const ops = parseMarkdownToOperations(exp.markdown).operations;
  const allDeltas = ops.flatMap(op => op.deltas ?? []);
  const findRun = (text) => allDeltas.find(d => d.insert === text);
  const opsOfType = (type) => ops.filter(op => op.type === type);

  const checks = [
    ["heading present",                            () => assert.ok(opsOfType("heading").some(op => /Markdown Formatting Test/.test(op.text)), "expected a heading containing the title")],
    ["bold run preserved",                         () => assert.ok(findRun("Bold text")?.attributes?.bold)],
    ["italic run preserved",                       () => assert.ok(findRun("Italic text")?.attributes?.italic)],
    ["strikethrough run preserved",                () => assert.ok(findRun("Strikethrough text")?.attributes?.strike)],
    ["inline code run preserved",                  () => assert.ok(findRun("Inline code")?.attributes?.code)],
    ["bulleted list items preserved",              () => assert.ok(opsOfType("list").some(op => op.style === "bulleted" && /Bullet item/.test(op.text)), "expected at least one bulleted list item")],
    ["numbered list items preserved",              () => assert.ok(opsOfType("list").some(op => op.style === "numbered" && /Numbered item/.test(op.text)), "expected at least one numbered list item")],
    ["fenced code block preserved with language",  () => {
      const code = opsOfType("code").find(op => op.text.includes("Hello, Affine!"));
      assert.ok(code, "expected a code block containing 'Hello, Affine!'");
      assert.equal(code.language, "python", "code block language should be 'python'");
    }],
  ];

  for (const [name, fn] of checks) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed = true;
    }
  }
} finally {
  await call("delete_doc", { workspaceId: WORKSPACE_ID, docId: doc.docId });
  console.log("\ncleaned up doc", doc.docId);
  await client.close();
}

if (failed) process.exit(1);
