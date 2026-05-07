#!/usr/bin/env node
/** Executes the auth-flow scene from docs/edgeless-canvas-cookbook.md end-to-end
 *  and asserts the cookbook's claims: connector auto-snap + labelXYWH seeding,
 *  frame auto-size via childElementIds, update_frame_children (resizeToFit true/false),
 *  y-omitted auto-stack-below, and get_edgeless_canvas readback. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MCP = path.resolve(REPO_ROOT, "dist", "index.js");

const BASE = process.env.AFFINE_BASE_URL;
const EMAIL = process.env.AFFINE_ADMIN_EMAIL;
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD;
if (!BASE || !EMAIL || !PASSWORD) {
  console.error("Set AFFINE_BASE_URL, AFFINE_ADMIN_EMAIL, AFFINE_ADMIN_PASSWORD first.");
  console.error("Typical flow (from repo root):");
  console.error("  . tests/generate-test-env.sh");
  console.error("  docker compose -f docker/docker-compose.yml up -d");
  console.error("  node tests/acquire-credentials.mjs");
  console.error("  node tests/test-edgeless-canvas-cookbook.mjs");
  process.exit(1);
}

const client = new Client({ name: "affine-mcp-cookbook-auth-flow", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [MCP],
  cwd: REPO_ROOT,
  env: {
    AFFINE_BASE_URL: BASE,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: "sync",
    XDG_CONFIG_HOME: "/tmp/affine-mcp-cookbook-auth-flow",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", c => process.stderr.write(`[mcp] ${c}`));

/**
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
async function call(name, args = {}) {
  const r = /** @type {{ isError?: boolean; content?: Array<{ text?: string }> }} */ (
    await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
  );
  const firstText = r?.content?.[0]?.text;
  if (r?.isError) throw new Error(`${name}: ${firstText ?? "unknown error"}`);
  if (typeof firstText !== "string") return null;
  try { return JSON.parse(firstText); } catch { return firstText; }
}

const expect = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };

await client.connect(transport);
try {
  // ────────────── §1 Fresh doc ──────────────
  const ws = await call("create_workspace", { name: `affine-mcp-cookbook-${Date.now()}` });
  const W = ws.id;
  const { docId: D } = await call("create_doc", {
    workspaceId: W,
    title: "Edgeless Canvas Cookbook — Live Demo",
    content: "This doc was seeded live by the edgeless-canvas cookbook test.",
  });

  // ────────────── §2 Three surface shapes ──────────────
  const user = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "shape", shapeType: "rect", radius: 0.2,
    x: 200, y: 400, width: 160, height: 80, text: "User", fontSize: 18,
    fillColor: "--affine-palette-shape-blue",
  });
  const auth = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "shape", shapeType: "rect", radius: 0.2,
    x: 500, y: 400, width: 160, height: 80, text: "Auth Service", fontSize: 18,
    fillColor: "--affine-palette-shape-green",
  });
  const db = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "shape", shapeType: "rect", radius: 0.2,
    x: 800, y: 400, width: 160, height: 80, text: "Database", fontSize: 18,
    fillColor: "--affine-palette-shape-purple",
  });

  // ────────────── §3 Labeled connectors ──────────────
  const c1 = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "connector",
    sourceId: user.elementId, targetId: auth.elementId, label: "authenticate",
  });
  const c2 = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "connector",
    sourceId: auth.elementId, targetId: db.elementId, label: "verify",
  });

  // ────────────── §4 Frame owns the diagram ──────────────
  // No width/height → frame auto-sizes to union(children) + padding 50 + 30px title band.
  const frame = await call("append_block", {
    workspaceId: W, docId: D, type: "frame",
    text: "Auth Flow",
    childElementIds: [user.elementId, auth.elementId, db.elementId, c1.elementId, c2.elementId],
    padding: 50,
  });
  expect(frame.appended === true, `frame append should succeed, got ${JSON.stringify(frame)}`);
  expect(frame.flavour === "affine:frame", `frame flavour must be affine:frame, got ${frame.flavour}`);
  expect(Array.isArray(frame.ownedIds) && frame.ownedIds.length === 5,
    `frame.ownedIds must have all 5 ids, got ${JSON.stringify(frame.ownedIds)}`);
  expect(Array.isArray(frame.missing) && frame.missing.length === 0,
    `frame.missing must be empty, got ${JSON.stringify(frame.missing)}`);
  const expectedOwned = [user.elementId, auth.elementId, db.elementId, c1.elementId, c2.elementId].sort();
  const actualOwned = [...frame.ownedIds].sort();
  expect(actualOwned.every((v, i) => v === expectedOwned[i]),
    `frame ownedIds mismatch: expected ${JSON.stringify(expectedOwned)}, got ${JSON.stringify(actualOwned)}`);

  // ────────────── §5 Grow the frame ──────────────
  const cache = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "shape", shapeType: "rect", radius: 0.2,
    x: 500, y: 600, width: 160, height: 80, text: "Cache", fontSize: 18,
    fillColor: "--affine-palette-shape-orange",
  });
  const c3 = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "connector", mode: 1,
    sourceId: auth.elementId, targetId: cache.elementId, label: "session lookup",
  });

  // Default resizeToFit=true → frame.xywh must grow to contain the new cache shape.
  const grown = await call("update_frame_children", {
    workspaceId: W, docId: D, blockId: frame.blockId,
    childElementIds: [
      user.elementId, auth.elementId, db.elementId,
      c1.elementId, c2.elementId,
      cache.elementId, c3.elementId,
    ],
    padding: 50,
  });
  expect(grown.updated === true, `update_frame_children should succeed, got ${JSON.stringify(grown)}`);
  expect(grown.resized === true, `default call should set resized=true, got resized=${grown.resized}`);
  expect(grown.ownedIds.length === 7, `grown.ownedIds should have 7 ids, got ${grown.ownedIds.length}`);
  expect(grown.missing.length === 0, `grown.missing should be empty, got ${JSON.stringify(grown.missing)}`);
  expect(
    grown.xywh && typeof grown.xywh === "object" &&
      Number.isFinite(grown.xywh.x) && Number.isFinite(grown.xywh.y) &&
      Number.isFinite(grown.xywh.width) && Number.isFinite(grown.xywh.height),
    `grown.xywh must be a full rect, got ${JSON.stringify(grown.xywh)}`);

  // Frame must enclose cache (600..680 on y) with padding 50.
  const GX = grown.xywh;
  expect(GX.x <= 200 - 50 + 1 && GX.x + GX.width >= 800 + 160 + 50 - 1,
    `grown frame must enclose shapes on x with padding 50, got ${JSON.stringify(GX)}`);
  expect(GX.y + GX.height >= 600 + 80 + 50 - 1,
    `grown frame bottom must clear cache (y=600..680) + padding, got ${JSON.stringify(GX)}`);

  // resizeToFit=false → xywh preserved from the previous state.
  const shrunk = await call("update_frame_children", {
    workspaceId: W, docId: D, blockId: frame.blockId,
    childElementIds: [user.elementId, auth.elementId, db.elementId, c1.elementId, c2.elementId],
    resizeToFit: false,
  });
  expect(shrunk.updated === true, `shrunk update should succeed, got ${JSON.stringify(shrunk)}`);
  expect(shrunk.resized === false, `resizeToFit:false must return resized=false, got ${shrunk.resized}`);
  expect(shrunk.ownedIds.length === 5, `shrunk ownedIds length should be 5, got ${shrunk.ownedIds.length}`);

  // Reinstate the full membership with default resize so the frame shown
  // in the doc matches what the cookbook depicts.
  const finalFrame = await call("update_frame_children", {
    workspaceId: W, docId: D, blockId: frame.blockId,
    childElementIds: [
      user.elementId, auth.elementId, db.elementId,
      c1.elementId, c2.elementId,
      cache.elementId, c3.elementId,
    ],
    padding: 50,
  });
  expect(finalFrame.resized === true, `reinstated frame should resize again, got ${finalFrame.resized}`);

  // ────────────── §6 Auto-stacked epilogue note ──────────────
  const epilogue = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: 800, height: 120,
    markdown: [
      "## How this canvas was built",
      "",
      "Every block, shape, and frame above was authored with a single MCP tool call.",
      "The frame owns its shapes via `prop:childElementIds` — drag it and the diagram moves with it.",
    ].join("\n"),
  });
  expect(epilogue.appended === true, `epilogue note should append, got ${JSON.stringify(epilogue)}`);

  // ────────────── Read-back + deeper assertions ──────────────
  const canvas = await call("get_edgeless_canvas", { workspaceId: W, docId: D });
  const findBlock = (id) => canvas.edgelessBlocks.find(b => b.id === id);
  const findElem = (id) => canvas.surfaceElements.find(e => e.id === id);

  // §4/§5 frame entry exposes childElementIds for agents.
  const frameEntry = findBlock(frame.blockId);
  expect(frameEntry, `frame must appear in edgelessBlocks`);
  expect(frameEntry.flavour === "affine:frame", `frame flavour in canvas = ${frameEntry.flavour}`);
  expect(Array.isArray(frameEntry.childElementIds) && frameEntry.childElementIds.length === 7,
    `frame.childElementIds should have 7 ids, got ${JSON.stringify(frameEntry.childElementIds)}`);

  // §3 connector auto-snap: every connector seeded with sourceId+targetId only
  // must land on one of the four side-midpoints.
  const SIDE_MIDPOINTS = [[0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]];
  const onSideMidpoint = (pos) =>
    Array.isArray(pos) && SIDE_MIDPOINTS.some(([x, y]) => pos[0] === x && pos[1] === y);
  for (const c of [c1, c2, c3]) {
    const el = findElem(c.elementId);
    expect(el, `connector ${c.elementId} must appear in surfaceElements`);
    expect(onSideMidpoint(el.source?.position),
      `connector ${c.elementId}: source.position ${JSON.stringify(el.source?.position)} not a side-midpoint`);
    expect(onSideMidpoint(el.target?.position),
      `connector ${c.elementId}: target.position ${JSON.stringify(el.target?.position)} not a side-midpoint`);
    const lx = el.labelXYWH;
    expect(Array.isArray(lx) && lx.length === 4 && lx.every(n => Number.isFinite(n)),
      `connector ${c.elementId} "${el.text}": labelXYWH must be [x,y,w,h] of finite numbers, got ${JSON.stringify(lx)}`);
  }

  // §6 auto-stack fallback: epilogue note must sit below the frame's bottom
  // edge (NOT at [0,0,…]). Default gap is 40 in the layout helper.
  const frameBounds = findBlock(frame.blockId).bounds;
  const epilogueBounds = findBlock(epilogue.blockId).bounds;
  expect(epilogueBounds.y >= frameBounds.y + frameBounds.height,
    `epilogue note (y=${epilogueBounds.y}) must sit at or below the frame bottom (${frameBounds.y + frameBounds.height})`);
  expect(epilogueBounds.y !== 0,
    `epilogue note must NOT land at y=0 — that's the papercut the cookbook says is gone`);

  // ────────────── Summary ──────────────
  const summary = {
    docUrl: `${BASE}/workspace/${W}/${D}`,
    workspaceId: W,
    docId: D,
    frame: {
      blockId: frame.blockId,
      ownedIds: frameEntry.childElementIds,
      xywh: frameBounds,
    },
    epilogueBounds,
    counts: {
      edgelessBlocks: canvas.edgelessBlocks.length,
      surfaceElements: canvas.surfaceElements.length,
      connectors: canvas.elementCounts.connector,
      shapes: canvas.elementCounts.shape,
    },
    bounds: canvas.bounds,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log();
  console.log(`All cookbook assertions passed. Open in AFFiNE: ${summary.docUrl}`);
} finally {
  await client.close();
}
