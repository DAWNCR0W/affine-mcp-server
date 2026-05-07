#!/usr/bin/env node
/** Seeds a clean, centered edgeless-canvas layout via stackAfter/childElementIds
 *  wherever the tool supports them, and asserts the default-note xywh +
 *  connector labelXYWH + frame ownership invariants at the CRDT level. Writes
 *  tests/test-edgeless-state.json for the Playwright verifier. */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MCP = path.resolve(REPO_ROOT, "dist", "index.js");
const STATE_PATH = path.resolve(__dirname, "test-edgeless-state.json");

const BASE = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) {
  throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
}

const expect = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const client = new Client({ name: "affine-mcp-edgeless-setup", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP],
    cwd: REPO_ROOT,
    env: {
      AFFINE_BASE_URL: BASE,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-edgeless-setup-noconfig",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", c => process.stderr.write(`[mcp-server] ${c}`));

  async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    if (r?.isError) throw new Error(`${name}: ${r?.content?.[0]?.text}`);
    return parseContent(r);
  }

  await client.connect(transport);
  try {
    const workspace = await call("create_workspace", { name: `edgeless-canvas-${Date.now()}` });
    const doc = await call("create_doc", { workspaceId: workspace.id, title: "Edgeless Canvas Verify" });
    const W = workspace.id, D = doc.docId;

    const initial = await call("get_edgeless_canvas", { workspaceId: W, docId: D });
    const defaultNote = initial.edgelessBlocks.find(
      b => b.flavour === "affine:note" && b.bounds?.x === 0 && b.bounds?.y === 0,
    );
    expect(defaultNote, "default note at origin missing from get_edgeless_canvas");
    expect(
      defaultNote.bounds?.width === 800 && defaultNote.bounds?.height === 92,
      `default note xywh should be [0,0,800,92], got ${JSON.stringify(defaultNote.bounds)}`,
    );

    // User note — stackAfter centers on the default note's X midpoint; markdown
    // height estimate keeps the stored xywh close to rendered so siblings don't overlap.
    const userNote = await call("append_block", {
      workspaceId: W, docId: D, type: "note",
      width: 600,
      stackAfter: { blockId: defaultNote.id },
      background: "--affine-note-background-blue",
      markdown: [
        "# Edgeless Canvas Demo",
        "- Notes render as real **DOM** — that's what you're reading.",
        "- Shapes and connectors render to `<canvas>` pixels.",
        "- Frames, canvas text, and images live on the same surface.",
      ].join("\n"),
    });

    // Shapes are the only elements that need literal coords — surface elements
    // don't support stackAfter. Place them as a centered pair under the 800-wide
    // default note, well below any plausible user-note rendered height.
    const shapeA = await call("add_surface_element", {
      workspaceId: W, docId: D, type: "shape", shapeType: "rect",
      x: 260, y: 500, width: 120, height: 80, text: "A",
      fillColor: "--affine-palette-shape-yellow",
    });
    const shapeB = await call("add_surface_element", {
      workspaceId: W, docId: D, type: "shape", shapeType: "ellipse",
      x: 420, y: 500, width: 120, height: 80, text: "B",
    });
    // Connector is inherently relational — endpoints resolve by id.
    const connector = await call("add_surface_element", {
      workspaceId: W, docId: D, type: "connector",
      sourceId: shapeA.elementId, targetId: shapeB.elementId,
      label: "flows to", rearEndpointStyle: "Arrow",
    });

    // Frame auto-sizes and auto-positions to enclose its children.
    const frame = await call("append_block", {
      workspaceId: W, docId: D, type: "frame",
      text: "A → B",
      childElementIds: [shapeA.elementId, shapeB.elementId, connector.elementId],
      padding: 40,
    });

    // Caption — edgeless-text block so it can stackAfter the frame.
    const caption = await call("append_block", {
      workspaceId: W, docId: D, type: "edgeless_text",
      text: "canvas text renders as pixels",
      width: 380, height: 44,
      stackAfter: { blockId: frame.blockId, gap: 40 },
    });

    // CRDT invariants — trivial here, hard from the DOM side.
    const canvas = await call("get_edgeless_canvas", { workspaceId: W, docId: D });
    const connectorEl = canvas.surfaceElements.find(e => e.id === connector.elementId);
    expect(
      Array.isArray(connectorEl?.labelXYWH) && connectorEl.labelXYWH.length === 4
        && connectorEl.labelXYWH.every(n => Number.isFinite(n)),
      `connector labelXYWH should be a numeric 4-tuple, got ${JSON.stringify(connectorEl?.labelXYWH)}`,
    );

    const frameBlock = canvas.edgelessBlocks.find(b => b.id === frame.blockId);
    expect(frameBlock, "frame block missing from canvas dump");
    expect(
      Array.isArray(frameBlock.childElementIds)
        && [shapeA.elementId, shapeB.elementId, connector.elementId]
          .every(id => frameBlock.childElementIds.includes(id)),
      `frame.childElementIds should include all three seeded ids, got ${JSON.stringify(frameBlock.childElementIds)}`,
    );

    const userNoteBlock = canvas.edgelessBlocks.find(b => b.id === userNote.blockId);
    expect(
      userNoteBlock.bounds?.y >= defaultNote.bounds.y + defaultNote.bounds.height,
      `user note should stack below default note, got bounds=${JSON.stringify(userNoteBlock.bounds)}`,
    );
    expect(
      Math.abs((userNoteBlock.bounds.x + userNoteBlock.bounds.width / 2)
             - (defaultNote.bounds.x + defaultNote.bounds.width / 2)) < 1,
      `user note should center on default note's X-midpoint, got bounds=${JSON.stringify(userNoteBlock.bounds)}`,
    );

    const captionBlock = canvas.edgelessBlocks.find(b => b.id === caption.blockId);
    expect(
      captionBlock.bounds?.y >= frameBlock.bounds.y + frameBlock.bounds.height,
      `caption should stack below frame, got bounds=${JSON.stringify(captionBlock.bounds)}`,
    );

    const state = {
      baseUrl: BASE,
      email: EMAIL,
      workspaceId: W,
      docId: D,
      docUrl: `${BASE}/workspace/${W}/${D}`,
      expectations: {
        defaultNoteXywh: "[0,0,800,92]",
        userNote: {
          blockId: userNote.blockId,
          heading: "Edgeless Canvas Demo",
          bullets: [
            "Notes render as real",
            "Shapes and connectors render to",
            "Frames, canvas text, and images",
          ],
        },
        frame: {
          blockId: frame.blockId,
          title: "A → B",
          childElementIds: frameBlock.childElementIds,
        },
        connector: {
          elementId: connectorEl.id,
          label: "flows to",
          labelXYWH: connectorEl.labelXYWH,
        },
        shapeA: { id: shapeA.elementId, text: "A" },
        shapeB: { id: shapeB.elementId, text: "B" },
      },
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    console.log(`[edgeless-setup] Wrote ${STATE_PATH}`);
    console.log(`[edgeless-setup] Doc: ${state.docUrl}`);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
