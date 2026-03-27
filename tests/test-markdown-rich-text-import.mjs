#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Y from "yjs";

import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc } from "../dist/ws.js";
import { acquireCredentials } from "./acquire-credentials.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) {
  throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
}

const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || "60000");
const MARKDOWN = [
  "Intro **paragraph** text",
  "",
  "- **Top level** item",
  "  - **Nested level** item",
  "",
  "| Role | Notes |",
  "| --- | --- |",
  "| **ADMIN** | Full access |",
  "| Normal | **Important** value |",
].join("\n");

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertResult(toolName, result) {
  if (result?.isError) {
    throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
  }
  const parsed = parseContent(result);
  if (parsed && typeof parsed === "object" && parsed.error) {
    throw new Error(`${toolName} failed: ${parsed.error}`);
  }
  return parsed;
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function textFromDelta(delta) {
  return delta.map(entry => String(entry.insert ?? "")).join("");
}

function hasBoldRun(delta, expectedText) {
  return delta.some(entry => entry.insert === expectedText && entry.attributes?.bold === true);
}

function childIdsFrom(value) {
  if (!(value instanceof Y.Array)) return [];
  const childIds = [];
  value.forEach(entry => {
    if (typeof entry === "string") {
      childIds.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) {
        if (typeof child === "string") {
          childIds.push(child);
        }
      }
    }
  });
  return childIds;
}

function getBlocks(doc) {
  return doc.getMap("blocks");
}

function findBlock(blocks, predicate) {
  for (const [id, block] of blocks) {
    if (!(block instanceof Y.Map)) continue;
    if (predicate(String(id), block)) {
      return { id: String(id), block };
    }
  }
  return null;
}

function listBlockDeltas(blocks) {
  const deltas = [];
  for (const [, block] of blocks) {
    if (!(block instanceof Y.Map)) continue;
    if (block.get("sys:flavour") !== "affine:list") continue;
    const text = block.get("prop:text");
    if (!(text instanceof Y.Text)) continue;
    deltas.push(text.toDelta());
  }
  return deltas;
}

function tableCellDeltas(tableBlock) {
  const result = [];
  for (const [key, value] of tableBlock) {
    if (!String(key).startsWith("prop:cells.") || !String(key).endsWith(".text")) continue;
    if (!(value instanceof Y.Text)) continue;
    result.push(value.toDelta());
  }
  return result;
}

async function loadLiveDoc(workspaceId, docId, cookie) {
  const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${BASE_URL}/graphql`), cookie, undefined);
  try {
    await joinWorkspace(socket, workspaceId);
    const snapshot = await loadDoc(socket, workspaceId, docId);
    if (!snapshot.missing) {
      throw new Error(`Document ${docId} not found`);
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
    return doc;
  } finally {
    socket.disconnect();
  }
}

async function main() {
  console.log("=== Markdown Rich Text Import Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);

  const client = new Client({ name: "affine-mcp-markdown-richtext-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-markdown-richtext",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    const parsed = assertResult(toolName, result);
    console.log("    ✓ OK");
    return parsed;
  }

  await client.connect(transport);

  try {
    const workspace = await call("create_workspace", { name: `markdown-richtext-${Date.now()}` });
    const workspaceId = workspace?.id;
    expect(workspaceId, "create_workspace did not return id");

    const createResult = await call("create_doc_from_markdown", {
      workspaceId,
      title: "Markdown Rich Text Import",
      markdown: MARKDOWN,
    });
    const createdDocId = createResult?.docId;
    expect(createdDocId, "create_doc_from_markdown did not return docId");

    const { cookie } = await acquireCredentials(BASE_URL, EMAIL, PASSWORD);
    expect(cookie, "failed to acquire cookie for live snapshot inspection");

    const createdDoc = await loadLiveDoc(workspaceId, createdDocId, cookie);
    const createdBlocks = getBlocks(createdDoc);
    const createdListDeltas = listBlockDeltas(createdBlocks);
    expect(createdListDeltas.some(delta => hasBoldRun(delta, "Top level")), "top-level list item did not preserve bold");
    expect(createdListDeltas.some(delta => hasBoldRun(delta, "Nested level")), "nested list item did not preserve bold");

    const createdTable = findBlock(createdBlocks, (_, block) => block.get("sys:flavour") === "affine:table");
    expect(createdTable, "table block not found after create_doc_from_markdown");
    const createdTableDeltas = tableCellDeltas(createdTable.block);
    expect(createdTableDeltas.some(delta => hasBoldRun(delta, "ADMIN")), "table cell bold text did not preserve bold");
    expect(createdTableDeltas.some(delta => hasBoldRun(delta, "Important")), "table cell mixed bold text did not preserve bold");

    const emptyDoc = await call("create_doc", {
      workspaceId,
      title: "Markdown Replace Rich Text",
      content: "",
    });
    const replaceDocId = emptyDoc?.docId;
    expect(replaceDocId, "create_doc did not return docId");

    await call("replace_doc_with_markdown", {
      workspaceId,
      docId: replaceDocId,
      markdown: MARKDOWN,
    });

    const replacedDoc = await loadLiveDoc(workspaceId, replaceDocId, cookie);
    const replacedBlocks = getBlocks(replacedDoc);
    const replacedListDeltas = listBlockDeltas(replacedBlocks);
    expect(replacedListDeltas.some(delta => hasBoldRun(delta, "Top level")), "replace_doc_with_markdown top-level list item lost bold");
    expect(replacedListDeltas.some(delta => hasBoldRun(delta, "Nested level")), "replace_doc_with_markdown nested list item lost bold");

    const replacedTable = findBlock(replacedBlocks, (_, block) => block.get("sys:flavour") === "affine:table");
    expect(replacedTable, "table block not found after replace_doc_with_markdown");
    const replacedTableDeltas = tableCellDeltas(replacedTable.block);
    expect(replacedTableDeltas.some(delta => hasBoldRun(delta, "ADMIN")), "replace_doc_with_markdown table cell bold text lost bold");
    expect(replacedTableDeltas.some(delta => hasBoldRun(delta, "Important")), "replace_doc_with_markdown table cell mixed bold text lost bold");

    console.log("=== Markdown rich text import test passed ===");
  } finally {
    await transport.close();
  }
}

main().catch(error => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
