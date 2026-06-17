#!/usr/bin/env node
/**
 * Focused integration test for the explorer-icon tools.
 *
 * Covers the full round-trip against a live AFFiNE instance:
 * - update_doc_icon with an emoji shorthand, a full emoji object, and a named icon
 * - get_doc_icon reflects each write
 * - clearing a doc icon (icon = null) removes it
 * - update_folder_icon / get_folder_icon for an organize folder
 * - clearing a folder icon
 *
 * The icons live in the workspace's `db$<workspaceId>$explorerIcon` sub-doc,
 * which never exists until the first write — so this also exercises creating a
 * brand-new sub-doc through the sync server.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || "60000");

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function expectThrows(fn, message) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`${message}: expected the call to fail, but it succeeded`);
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Explorer-Icon Integration Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const client = new Client({ name: "affine-mcp-icons", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-e2e-icons-noconfig",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const parsed = parseContent(result);
    if (result?.isError) {
      const err = new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
      err.toolError = parsed ?? result?.content?.[0]?.text;
      throw err;
    }
    if (parsed && typeof parsed === "object" && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === "string" && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }
    console.log("    ✓ OK");
    return parsed;
  }

  // The icon write is acked by the sync server, but the read re-loads the
  // sub-doc; poll briefly to absorb any propagation lag.
  async function getWithRetry(toolName, args, predicate, description, attempts = 15, delayMs = 1000) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await call(toolName, args);
      if (predicate(last)) return last;
      if (attempt < attempts) await delay(delayMs);
    }
    throw new Error(`${description}: timed out. Last response: ${JSON.stringify(last)}`);
  }

  await client.connect(transport);

  let workspaceId;
  let docId;
  let folderId;

  try {
    const timestamp = Date.now();
    const workspace = await call("create_workspace", { name: `icons-${timestamp}` });
    expectTruthy(workspace?.id, "create_workspace id");
    workspaceId = workspace.id;

    const doc = await call("create_doc", { workspaceId, title: `Icon Doc ${timestamp}`, content: "body" });
    expectTruthy(doc?.docId, "create_doc docId");
    docId = doc.docId;

    // --- doc: read before any write (explorerIcon sub-doc does not exist yet) -
    const freshRead = await call("get_doc_icon", { workspaceId, docId });
    expectEqual(freshRead?.icon, null, "fresh doc icon is null");
    expectEqual(freshRead?.hasIcon, false, "fresh doc hasIcon is false");

    // --- doc: empty emoji string is rejected ---------------------------------
    await expectThrows(
      () => call("update_doc_icon", { workspaceId, docId, icon: "" }),
      "empty emoji string rejected",
    );

    // --- doc: emoji shorthand string -----------------------------------------
    const setEmoji = await call("update_doc_icon", { workspaceId, docId, icon: "🧪" });
    expectDeepEqual(setEmoji?.icon, { type: "emoji", unicode: "🧪" }, "doc emoji shorthand normalized");
    expectEqual(setEmoji?.cleared, false, "doc emoji shorthand not cleared");
    await getWithRetry(
      "get_doc_icon", { workspaceId, docId },
      r => r?.hasIcon === true && r?.icon?.unicode === "🧪",
      "doc emoji shorthand read-back",
    );

    // --- doc: full emoji object ----------------------------------------------
    await call("update_doc_icon", { workspaceId, docId, icon: { type: "emoji", unicode: "🚀" } });
    await getWithRetry(
      "get_doc_icon", { workspaceId, docId },
      r => r?.icon?.type === "emoji" && r?.icon?.unicode === "🚀",
      "doc full emoji object read-back",
    );

    // --- doc: named icon (passthrough, no validation) ------------------------
    await call("update_doc_icon", { workspaceId, docId, icon: { type: "icon", name: "check" } });
    await getWithRetry(
      "get_doc_icon", { workspaceId, docId },
      r => r?.icon?.type === "icon" && r?.icon?.name === "check",
      "doc named icon read-back",
    );

    // --- doc: clear ----------------------------------------------------------
    const clearedDoc = await call("update_doc_icon", { workspaceId, docId, icon: null });
    expectEqual(clearedDoc?.cleared, true, "doc icon cleared flag");
    expectEqual(clearedDoc?.icon, null, "doc icon cleared value");
    await getWithRetry(
      "get_doc_icon", { workspaceId, docId },
      r => r?.hasIcon === false && r?.icon === null,
      "doc icon cleared read-back",
    );

    // --- folder: create then set/read/clear ----------------------------------
    const folder = await call("create_folder", { workspaceId, name: `Icon Folder ${timestamp}` });
    expectTruthy(folder?.id, "create_folder id");
    folderId = folder.id;

    const setFolderIcon = await call("update_folder_icon", { workspaceId, folderId, icon: "📁" });
    expectDeepEqual(setFolderIcon?.icon, { type: "emoji", unicode: "📁" }, "folder emoji normalized");
    await getWithRetry(
      "get_folder_icon", { workspaceId, folderId },
      r => r?.hasIcon === true && r?.icon?.unicode === "📁",
      "folder emoji read-back",
    );

    const clearedFolder = await call("update_folder_icon", { workspaceId, folderId, icon: null });
    expectEqual(clearedFolder?.cleared, true, "folder icon cleared flag");
    await getWithRetry(
      "get_folder_icon", { workspaceId, folderId },
      r => r?.hasIcon === false && r?.icon === null,
      "folder icon cleared read-back",
    );

    console.log();
    console.log("=== ✅ All explorer-icon assertions passed ===");
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch(err => {
  console.error();
  console.error("=== ❌ Explorer-Icon Integration Test FAILED ===");
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
