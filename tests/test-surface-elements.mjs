#!/usr/bin/env node
/** Integration test: append_block edgeless positioning, add/update/delete_surface_element (shape/connector/text/group),
 *  xywh merge semantics, pruneConnectors, and get_edgeless_canvas readback. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");
const STATE_PATH = path.resolve(__dirname, "test-surface-elements-state.json");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) {
  throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
}
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
  if (!value) throw new Error(`${message}: expected truthy, got ${JSON.stringify(value)}`);
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`${message}: expected array, got ${JSON.stringify(value)}`);
  }
}

async function main() {
  console.log("=== Edgeless Canvas & Surface Elements Integration Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const client = new Client({ name: "affine-mcp-surface-elements", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-e2e-surface-elements-noconfig",
      ...(process.env.AFFINE_MCP_DEBUG_SURFACE_INDEX
        ? { AFFINE_MCP_DEBUG_SURFACE_INDEX: process.env.AFFINE_MCP_DEBUG_SURFACE_INDEX }
        : {}),
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
      { timeout: TOOL_TIMEOUT_MS }
    );
    if (result?.isError) {
      throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
    }
    const parsed = parseContent(result);
    if (parsed && typeof parsed === "object" && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === "string" && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }
    console.log("    ✓ OK");
    return parsed;
  }

  await client.connect(transport);

  try {
    const timestamp = Date.now();
    const workspace = await call("create_workspace", { name: `surface-elements-${timestamp}` });
    expectTruthy(workspace?.id, "create_workspace id");

    const doc = await call("create_doc", {
      workspaceId: workspace.id,
      title: "Surface Elements Canvas",
    });
    expectTruthy(doc?.docId, "create_doc docId");
    const docId = doc.docId;

    // 1. append_block(type="frame") honors x/y
    const frame = await call("append_block", {
      workspaceId: workspace.id,
      docId,
      type: "frame",
      text: "Demo Frame",
      x: 100,
      y: 150,
      width: 600,
      height: 400,
      background: "--affine-palette-line-blue",
    });
    expectTruthy(frame?.blockId, "append_block frame blockId");
    expectEqual(frame?.flavour, "affine:frame", "frame flavour");

    // 2. append_block(type="note") with string background + auto-paragraph.
    //    Regression guard for PR #142: caller-provided background must NOT be
    //    replaced with the hardcoded {light:"#ffffff", dark:"#252525"} Y.Map.
    const note = await call("append_block", {
      workspaceId: workspace.id,
      docId,
      type: "note",
      text: "hello from mcp",
      x: 50,
      y: 50,
      width: 400,
      height: 200,
      background: "blue",
    });
    expectTruthy(note?.blockId, "append_block note blockId");
    expectEqual(note?.flavour, "affine:note", "note flavour");

    // 3. append_block(type="edgeless_text")
    const edgelessText = await call("append_block", {
      workspaceId: workspace.id,
      docId,
      type: "edgeless_text",
      text: "standalone canvas text",
      x: 800,
      y: 80,
      width: 300,
      height: 60,
    });
    expectTruthy(edgelessText?.blockId, "append_block edgeless_text blockId");

    // 4. add_surface_element: two shapes + a connector
    const shapeA = await call("add_surface_element", {
      workspaceId: workspace.id,
      docId,
      type: "shape",
      shapeType: "rect",
      x: 200,
      y: 600,
      width: 120,
      height: 80,
      text: "A",
      fillColor: "--affine-palette-shape-yellow",
    });
    expectEqual(shapeA?.added, true, "shapeA added");
    expectTruthy(shapeA?.elementId, "shapeA elementId");
    expectTruthy(shapeA?.surfaceBlockId, "surfaceBlockId returned");

    const shapeB = await call("add_surface_element", {
      workspaceId: workspace.id,
      docId,
      type: "shape",
      shapeType: "ellipse",
      x: 500,
      y: 620,
      width: 120,
      height: 80,
      text: "B",
    });
    expectEqual(shapeB?.added, true, "shapeB added");

    const connector = await call("add_surface_element", {
      workspaceId: workspace.id,
      docId,
      type: "connector",
      sourceId: shapeA.elementId,
      targetId: shapeB.elementId,
      label: "flows to",
      rearEndpointStyle: "Arrow",
    });
    expectEqual(connector?.added, true, "connector added");

    // labelXYWH is what gates BlockSuite's connector label renderer
    // (ConnectorElementModel.hasLabel short-circuits if labelXYWH is missing).
    // When the caller supplies a label, we must seed labelXYWH at the midpoint
    // of source/target so the label is visible on first render.
    const connectorReadback = await call("list_surface_elements", {
      workspaceId: workspace.id,
      docId,
      elementId: connector.elementId,
    });
    const connectorEl = connectorReadback.elements[0];
    expectTruthy(connectorEl, "connector present on readback");
    expectEqual(connectorEl?.text, "flows to", "connector label text round-trips");
    expectArray(connectorEl?.labelXYWH, "connector labelXYWH array present");
    expectEqual(connectorEl?.labelXYWH?.length, 4, "connector labelXYWH length=4");
    // shapeA center ≈ (260, 640), shapeB center ≈ (560, 660), midpoint ≈ (410, 650)
    const [lx, ly, lw, lh] = connectorEl.labelXYWH;
    if (typeof lx !== "number" || typeof ly !== "number" || typeof lw !== "number" || typeof lh !== "number") {
      throw new Error(`labelXYWH entries must be numbers, got ${JSON.stringify(connectorEl.labelXYWH)}`);
    }
    if (lx < 200 || lx > 600) throw new Error(`labelXYWH x (${lx}) not near midpoint of A→B`);
    if (ly < 500 || ly > 800) throw new Error(`labelXYWH y (${ly}) not near midpoint of A→B`);
    if (lw < 16 || lh < 16) throw new Error(`labelXYWH too small: ${connectorEl.labelXYWH}`);

    const groupEl = await call("add_surface_element", {
      workspaceId: workspace.id,
      docId,
      type: "group",
      title: "AB pair",
      children: [shapeA.elementId, shapeB.elementId],
    });
    expectEqual(groupEl?.added, true, "group added");

    // Fractional z-order: every element must have a unique `index` string, and
    // list_surface_elements must return them in ascending z-order (Y.Map natural
    // iteration order is not stable across doc reloads, so the tool sorts).
    const zOrderCheck = await call("list_surface_elements", {
      workspaceId: workspace.id,
      docId,
    });
    const indices = zOrderCheck.elements.map(e => e.index);
    expectEqual(indices.length, 4, "z-order: 4 indices");
    for (const idx of indices) {
      if (typeof idx !== "string" || idx.length === 0) {
        throw new Error(`z-order: every element must carry a non-empty string index, got ${JSON.stringify(indices)}`);
      }
    }
    const unique = new Set(indices);
    expectEqual(unique.size, indices.length, "z-order: indices must be unique per element (not all 'a0')");
    for (let i = 1; i < indices.length; i++) {
      if (!(indices[i - 1] < indices[i])) {
        throw new Error(
          `z-order: list_surface_elements must return elements sorted ascending by fractional index, got ${JSON.stringify(indices)}`
        );
      }
    }

    // 5. list_surface_elements returns all four with parsed bounds
    const listed = await call("list_surface_elements", {
      workspaceId: workspace.id,
      docId,
    });
    expectEqual(listed?.count, 4, "list_surface_elements count");
    expectArray(listed?.elements, "list_surface_elements elements array");
    const byId = new Map(listed.elements.map(e => [e.id, e]));
    const shapeAEntry = byId.get(shapeA.elementId);
    expectTruthy(shapeAEntry, "shapeA present in list");
    expectEqual(shapeAEntry?.type, "shape", "shapeA type");
    expectEqual(shapeAEntry?.bounds?.x, 200, "shapeA bounds.x");
    expectEqual(shapeAEntry?.bounds?.y, 600, "shapeA bounds.y");
    expectEqual(shapeAEntry?.bounds?.width, 120, "shapeA bounds.width");
    expectEqual(shapeAEntry?.bounds?.height, 80, "shapeA bounds.height");
    expectEqual(shapeAEntry?.text, "A", "shapeA text serialized");

    // 6. update_surface_element — move shape A without resizing (xywh merge)
    const moved = await call("update_surface_element", {
      workspaceId: workspace.id,
      docId,
      elementId: shapeA.elementId,
      x: 240,
    });
    expectEqual(moved?.updated, true, "update moved updated=true");
    expectArray(moved?.changed, "update moved changed array");

    const movedListed = await call("list_surface_elements", {
      workspaceId: workspace.id,
      docId,
      elementId: shapeA.elementId,
    });
    expectEqual(movedListed?.count, 1, "moved list count");
    const movedShape = movedListed.elements[0];
    expectEqual(movedShape?.bounds?.x, 240, "moved bounds.x");
    expectEqual(movedShape?.bounds?.y, 600, "moved bounds.y unchanged");
    expectEqual(movedShape?.bounds?.width, 120, "moved bounds.width unchanged");
    expectEqual(movedShape?.bounds?.height, 80, "moved bounds.height unchanged");

    // 7. update_surface_element — replace shape text + change fill
    const reskinned = await call("update_surface_element", {
      workspaceId: workspace.id,
      docId,
      elementId: shapeA.elementId,
      text: "renamed",
      fillColor: "--affine-palette-shape-green",
    });
    expectEqual(reskinned?.updated, true, "reskinned updated=true");

    const reskinnedListed = await call("list_surface_elements", {
      workspaceId: workspace.id,
      docId,
      elementId: shapeA.elementId,
    });
    expectEqual(reskinnedListed?.elements?.[0]?.text, "renamed", "shapeA text after update");
    expectEqual(
      reskinnedListed?.elements?.[0]?.fillColor,
      "--affine-palette-shape-green",
      "shapeA fillColor after update"
    );

    // 8. update ignores type-inapplicable fields
    const ignoredUpdate = await call("update_surface_element", {
      workspaceId: workspace.id,
      docId,
      elementId: connector.elementId,
      x: 999,
      title: "bogus",
    });
    expectArray(ignoredUpdate?.ignored, "ignored array present");
    if (!ignoredUpdate.ignored.includes("x") || !ignoredUpdate.ignored.includes("title")) {
      throw new Error(
        `expected ignored to include x and title, got ${JSON.stringify(ignoredUpdate.ignored)}`
      );
    }

    // 9. delete_surface_element with pruneConnectors
    const deleted = await call("delete_surface_element", {
      workspaceId: workspace.id,
      docId,
      elementId: shapeA.elementId,
      pruneConnectors: true,
    });
    expectEqual(deleted?.deleted, true, "delete shapeA deleted=true");
    expectArray(deleted?.prunedConnectors, "prunedConnectors array");
    if (!deleted.prunedConnectors.includes(connector.elementId)) {
      throw new Error(
        `expected connector ${connector.elementId} pruned, got ${JSON.stringify(deleted.prunedConnectors)}`
      );
    }

    const afterDelete = await call("list_surface_elements", {
      workspaceId: workspace.id,
      docId,
    });
    expectEqual(afterDelete?.count, 2, "count after delete+prune (shapeB + group)");

    // 10. get_edgeless_canvas — full read
    const canvas = await call("get_edgeless_canvas", {
      workspaceId: workspace.id,
      docId,
    });
    expectEqual(canvas?.exists, true, "canvas exists");
    expectTruthy(canvas?.surfaceBlockId, "canvas surfaceBlockId");
    expectArray(canvas?.edgelessBlocks, "canvas edgelessBlocks");
    expectArray(canvas?.surfaceElements, "canvas surfaceElements");

    const flavours = canvas.edgelessBlocks.map(b => b.flavour).sort();
    for (const required of ["affine:frame", "affine:note", "affine:edgeless-text"]) {
      if (!flavours.includes(required)) {
        throw new Error(`canvas missing edgeless block ${required}; got ${JSON.stringify(flavours)}`);
      }
    }

    const frameEntry = canvas.edgelessBlocks.find(b => b.flavour === "affine:frame");
    expectEqual(frameEntry?.bounds?.x, 100, "frame bounds.x");
    expectEqual(frameEntry?.bounds?.y, 150, "frame bounds.y");

    const edgelessTextEntry = canvas.edgelessBlocks.find(b => b.flavour === "affine:edgeless-text");
    expectEqual(edgelessTextEntry?.text, "standalone canvas text", "edgeless_text prop:text round-trips");
    expectEqual(edgelessTextEntry?.bounds?.x, 800, "edgeless_text bounds.x");

    // create_doc seeds a default note at (0,0,800,92) to match BlockSuite's
    // createDefaultDoc, so find the user-seeded note by its coordinates rather
    // than taking the first one.
    const noteEntry = canvas.edgelessBlocks.find(
      b => b.flavour === "affine:note" && b.bounds?.x === 50 && b.bounds?.y === 50
    );
    expectTruthy(noteEntry, "user-seeded note present on canvas (at 50,50)");
    // Note background preservation — PR #142 regression guard.
    // Caller passed background:"blue"; the hardcoded default Y.Map must NOT
    // have replaced it. get_edgeless_canvas returns the raw persisted value.
    expectEqual(noteEntry?.background, "blue", "note background string round-trips (not replaced by default Y.Map)");
    expectEqual(noteEntry?.text, "hello from mcp", "note auto-paragraph text");

    expectEqual(canvas?.elementCounts?.shape, 1, "canvas elementCounts.shape");
    expectEqual(canvas?.elementCounts?.connector, 0, "canvas elementCounts.connector");
    expectEqual(canvas?.elementCounts?.group, 1, "canvas elementCounts.group");
    expectTruthy(canvas?.bounds, "canvas aggregate bounds");

    // 11. Markdown round-trip into a note — BlockSuite-native block-first model:
    // append_block(type="note", markdown) parses via the existing markdown-it
    // pipeline and seeds heading/paragraph/list/code children. get_edgeless_canvas
    // returns these as a structured `children` array per note.
    const mdNote = await call("append_block", {
      workspaceId: workspace.id,
      docId,
      type: "note",
      x: 1200,
      y: 50,
      width: 500,
      height: 400,
      markdown: [
        "# Heading",
        "Paragraph body.",
        "- item one",
        "- item two",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    });
    expectTruthy(mdNote?.blockId, "markdown note blockId returned");
    expectTruthy(mdNote?.markdown, "markdown application receipt returned");

    const canvasWithMd = await call("get_edgeless_canvas", {
      workspaceId: workspace.id,
      docId,
    });
    const mdNoteEntry = canvasWithMd.edgelessBlocks.find(
      b => b.flavour === "affine:note" && b.bounds?.x === 1200
    );
    expectTruthy(mdNoteEntry, "markdown note present in canvas readback");
    expectArray(mdNoteEntry?.children, "markdown note has structured children array");
    const mdFlavours = mdNoteEntry.children.map(c => c.flavour);
    if (!mdFlavours.includes("affine:paragraph")) {
      throw new Error(`markdown note missing affine:paragraph child, got ${JSON.stringify(mdFlavours)}`);
    }
    if (!mdFlavours.includes("affine:list")) {
      throw new Error(`markdown note missing affine:list child, got ${JSON.stringify(mdFlavours)}`);
    }
    if (!mdFlavours.includes("affine:code")) {
      throw new Error(`markdown note missing affine:code child, got ${JSON.stringify(mdFlavours)}`);
    }
    const headingEntry = mdNoteEntry.children.find(c => c.flavour === "affine:paragraph" && c.type === "h1");
    expectTruthy(headingEntry, "markdown heading → paragraph with type=h1");
    expectEqual(headingEntry?.text, "Heading", "heading text preserved");
    const codeEntry = mdNoteEntry.children.find(c => c.flavour === "affine:code");
    expectEqual(codeEntry?.language, "ts", "code block language preserved");

    console.log();
    console.log("✅ All surface-element CRUD + canvas read assertions passed");
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
