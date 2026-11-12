#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * Integration test: deleting a native mindmap with delete_surface_element also removes its node shapes.
 * Nodes are plain shapes, so removing only the mindmap element would leave them orphaned on the canvas.
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

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  console.log("=== Mindmap Cascade Delete Integration Test ===");
  const client = new Client({ name: "affine-mcp-mindmap-cascade", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: testTempPath("mindmap-cascade-config"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", chunk => process.stderr.write(`[mcp-server] ${chunk}`));

  async function call(toolName, args = {}) {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    const parsed = parseContent(result);
    if (result?.isError) throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
    console.log(`  ✓ ${toolName}`);
    return parsed;
  }

  async function rejects(toolName, args, message) {
    try {
      await call(toolName, args);
    } catch {
      return;
    }
    throw new Error(`${message}: expected ${toolName} to fail`);
  }

  await client.connect(transport);
  try {
    const run = testResourceName("run");
    const { id: workspaceId } = await call("create_workspace", { name: `mindmap-cascade-${run}` });
    expect(workspaceId, "create_workspace id");

    const doc = await call("create_doc", { workspaceId, title: `Map ${run}` });
    const map = await call("create_mindmap", { workspaceId, docId: doc.docId, text: "Root" });
    const a = await call("add_mindmap_node", { workspaceId, docId: doc.docId, mindmapId: map.mindmapId, parentId: map.rootId, text: "A" });
    await call("add_mindmap_node", { workspaceId, docId: doc.docId, mindmapId: map.mindmapId, parentId: a.nodeId, text: "A1" });
    expectEqual((await call("list_surface_elements", { workspaceId, docId: doc.docId })).count, 4, "mindmap plus three node shapes");

    const outside = await call("add_surface_element", { workspaceId, docId: doc.docId, type: "shape", text: "Outside" });
    const fromRoot = await call("add_surface_element", { workspaceId, docId: doc.docId, type: "connector", sourceId: map.rootId, targetId: outside.elementId });
    const toChild = await call("add_surface_element", { workspaceId, docId: doc.docId, type: "connector", sourceId: outside.elementId, targetId: a.nodeId });
    const removed = await call("delete_surface_element", { workspaceId, docId: doc.docId, elementId: map.mindmapId, pruneConnectors: true });
    expectEqual(removed.deleted, true, "mindmap deleted");
    expectEqual(removed.deletedNodes.length, 3, "cascade removed every node shape");
    expectEqual([...removed.prunedConnectors].sort(), [fromRoot.elementId, toChild.elementId].sort(), "external connectors bound to deleted node shapes are pruned");
    expectEqual((await call("list_surface_elements", { workspaceId, docId: doc.docId })).count, 1, "only the unrelated outside shape remains");

    const shape = await call("add_surface_element", { workspaceId, docId: doc.docId, type: "shape", text: "plain" });
    expectEqual((await call("delete_surface_element", { workspaceId, docId: doc.docId, elementId: shape.elementId })).deletedNodes, [], "plain shapes report no cascaded nodes");

    console.log("\nMindmap Cascade Delete Integration Test passed");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
