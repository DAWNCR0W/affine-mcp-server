#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * Integration test for add_surface_elements / update_surface_elements and the compact canvas reads.
 * Every batch is atomic, so each rejection case also checks that nothing was written.
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
  console.log("=== Surface Batch Integration Test ===");
  const client = new Client({ name: "affine-mcp-surface-batch", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: testTempPath("surface-batch-config"),
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
    const { id: workspaceId } = await call("create_workspace", { name: `surface-batch-${run}` });
    expect(workspaceId, "create_workspace id");

    const canvas = await call("create_doc", { workspaceId, title: `Canvas ${run}` });
    const added = await call("add_surface_elements", {
      workspaceId, docId: canvas.docId,
      elements: [
        { key: "a", type: "shape", text: "A", x: 0, y: 0, width: 120, height: 60 },
        { key: "b", type: "shape", text: "B", x: 300, y: 0, width: 120, height: 60 },
        { type: "connector", sourceId: "a", targetId: "b" },
      ],
    });
    expectEqual(added.added, 3, "three elements added");
    const [shapeA, shapeB, connector] = added.elements;

    const listed = await call("list_surface_elements", { workspaceId, docId: canvas.docId, compact: true });
    const stored = listed.elements.find(el => el.id === connector.elementId);
    expectEqual([stored.source.id, stored.target.id], [shapeA.elementId, shapeB.elementId], "connector keys resolved to element ids");
    expect(!("fillColor" in listed.elements[0]), "compact read omits style data");
    const canvasRead = await call("get_edgeless_canvas", { workspaceId, docId: canvas.docId, compact: true });
    expect(!("fillColor" in canvasRead.surfaceElements[0]), "compact canvas read omits style data");

    await call("update_surface_elements", { workspaceId, docId: canvas.docId, updates: [{ elementId: shapeA.elementId, x: 40 }, { elementId: shapeB.elementId, text: "B2" }] });
    await rejects("update_surface_elements", { workspaceId, docId: canvas.docId, updates: [{ elementId: shapeA.elementId, x: 999 }, { elementId: "nope", x: 1 }] }, "missing element rejects the batch");
    const afterUpdate = (await call("list_surface_elements", { workspaceId, docId: canvas.docId, elementId: shapeA.elementId })).elements[0];
    expect(JSON.parse(afterUpdate.xywh)[0] === 40, "rejected batch left earlier updates untouched");

    await rejects("add_surface_elements", { workspaceId, docId: canvas.docId, elements: [{ type: "connector", sourceId: "later", targetId: "later" }, { key: "later", type: "shape" }] }, "forward reference rejected");
    expectEqual((await call("list_surface_elements", { workspaceId, docId: canvas.docId })).count, 3, "rejected batch added nothing")

    console.log("\nSurface Batch Integration Test passed");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
