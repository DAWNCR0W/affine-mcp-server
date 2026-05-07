#!/usr/bin/env node
/** Locks in color-default conventions at the CRDT level and writes a state file
 *  for the Playwright verifier. Shape fill/stroke/label stay on fixed palette
 *  tokens (+ literal `#000000` label); canvas text and connector stroke/label
 *  default to `--affine-text-primary-color`; note/frame backgrounds pass through
 *  caller-supplied tokens or `{light,dark}` objects unchanged. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
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
  process.exit(1);
}

const client = new Client({ name: "affine-mcp-theme-defaults", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [MCP],
  cwd: REPO_ROOT,
  env: {
    AFFINE_BASE_URL: BASE,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: "sync",
    XDG_CONFIG_HOME: "/tmp/affine-mcp-theme-defaults",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", c => process.stderr.write(`[mcp] ${c}`));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const firstText = r?.content?.[0]?.text;
  if (r?.isError) throw new Error(`${name}: ${firstText ?? "unknown error"}`);
  if (typeof firstText !== "string") return null;
  try { return JSON.parse(firstText); } catch { return firstText; }
}

const expect = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };
const isPaletteShape = v => typeof v === "string" && v.startsWith("--affine-palette-shape-");
const isPaletteLine  = v => typeof v === "string" && v.startsWith("--affine-palette-line-");
const isNoteBgToken  = v => typeof v === "string" && v.startsWith("--affine-note-background-");
const isAdaptiveText = v => typeof v === "string" && v.startsWith("--affine-text-");
const isRawHex       = v => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);

await client.connect(transport);
try {
  const ws = await call("create_workspace", { name: `affine-theme-defaults-${Date.now()}` });
  const { docId } = await call("create_doc", { workspaceId: ws.id, title: "Theme Defaults" });
  const W = ws.id, D = docId;

  // ────────────── Seed surface elements (all defaults) ──────────────
  const shape = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "shape", shapeType: "rect",
    x: 200, y: 400, width: 140, height: 80, text: "default shape",
  });
  const shape2 = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "shape", shapeType: "rect",
    x: 500, y: 400, width: 140, height: 80, text: "target",
  });
  const connector = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "connector",
    sourceId: shape.elementId, targetId: shape2.elementId, label: "default connector",
  });
  const canvasText = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "text",
    x: 200, y: 560, width: 400, text: "default canvas text",
  });

  // ────────────── Seed notes for each background form ──────────────
  // Stacked via stackAfter so each note inherits the previous one's X and
  // lands at (prev.bottom + gap) — no explicit coords, no drift.
  const noteAdaptiveToken = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: 300,
    background: "--affine-note-background-blue",
    markdown: "# adaptive token bg",
  });
  const noteLightDarkObj = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: 300,
    stackAfter: { blockId: noteAdaptiveToken.blockId },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: "# {light, dark} bg",
  });
  const notePaletteShape = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: 300,
    stackAfter: { blockId: noteLightDarkObj.blockId },
    background: "--affine-palette-shape-yellow",
    markdown: "# palette-shape bg (fixed)",
  });
  const noteRawHex = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: 300,
    stackAfter: { blockId: notePaletteShape.blockId },
    background: "#fab6b6",
    markdown: "# raw-hex bg (literal)",
  });

  // ────────────── CRDT-level assertions ──────────────
  const canvas = await call("get_edgeless_canvas", { workspaceId: W, docId: D });
  const getElem  = id => canvas.surfaceElements.find(e => e.id === id);
  const getBlock = id => canvas.edgelessBlocks.find(b => b.id === id);

  // --- SHAPES are fixed ---
  const shapeEl = getElem(shape.elementId);
  expect(isPaletteShape(shapeEl.fillColor),
    `shape.fillColor must be --affine-palette-shape-* (fixed), got ${shapeEl.fillColor}`);
  expect(isPaletteLine(shapeEl.strokeColor),
    `shape.strokeColor must be --affine-palette-line-* (fixed), got ${shapeEl.strokeColor}`);
  expect(shapeEl.color === "#000000",
    `shape.color (label) must be literal "#000000" to match AFFiNE's native shapeTextColor, got ${shapeEl.color}`);

  // --- CONNECTORS + CANVAS TEXT are theme-adaptive ---
  const connectorEl = getElem(connector.elementId);
  expect(isAdaptiveText(connectorEl.stroke),
    `connector.stroke must be an --affine-text-* adaptive token, got ${connectorEl.stroke}`);
  expect(!isRawHex(connectorEl.stroke),
    `connector.stroke must not be a raw hex, got ${connectorEl.stroke}`);
  expect(isAdaptiveText(connectorEl.labelStyle?.color),
    `connector.labelStyle.color must be an --affine-text-* adaptive token, got ${connectorEl.labelStyle?.color}`);

  const canvasTextEl = getElem(canvasText.elementId);
  expect(isAdaptiveText(canvasTextEl.color),
    `canvas text.color must be an --affine-text-* adaptive token, got ${canvasTextEl.color}`);

  // --- NOTE BACKGROUND: three forms pass through as-is ---
  const adaptiveBlock = getBlock(noteAdaptiveToken.blockId);
  expect(isNoteBgToken(adaptiveBlock.background),
    `adaptive-token note bg must be '--affine-note-background-*', got ${JSON.stringify(adaptiveBlock.background)}`);

  const lightDarkBlock = getBlock(noteLightDarkObj.blockId);
  expect(lightDarkBlock.background?.light === "#ffffff" && lightDarkBlock.background?.dark === "#252525",
    `{light, dark} note bg must be stored as an object with both keys, got ${JSON.stringify(lightDarkBlock.background)}`);

  const paletteShapeBlock = getBlock(notePaletteShape.blockId);
  expect(isPaletteShape(paletteShapeBlock.background),
    `palette-shape note bg must pass through as-is (fixed), got ${JSON.stringify(paletteShapeBlock.background)}`);

  const rawHexBlock = getBlock(noteRawHex.blockId);
  expect(isRawHex(rawHexBlock.background),
    `raw-hex note bg must pass through as-is (literal), got ${JSON.stringify(rawHexBlock.background)}`);

  // Write state file for the Playwright companion test.
  const statePath = path.resolve(__dirname, "test-theme-defaults-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    baseUrl: BASE,
    email: EMAIL,
    workspaceId: W,
    docId: D,
    docUrl: `${BASE}/workspace/${W}/${D}`,
    expectations: {
      shape: {
        id: shape.elementId,
        fillColor: shapeEl.fillColor,
        strokeColor: shapeEl.strokeColor,
        color: shapeEl.color,
      },
      connector: {
        id: connector.elementId,
        stroke: connectorEl.stroke,
        labelColor: connectorEl.labelStyle.color,
      },
      canvasText: { id: canvasText.elementId, color: canvasTextEl.color },
      noteBackgrounds: {
        adaptiveToken: { blockId: noteAdaptiveToken.blockId, background: adaptiveBlock.background },
        lightDarkObj:  { blockId: noteLightDarkObj.blockId,  background: lightDarkBlock.background },
        paletteShape:  { blockId: notePaletteShape.blockId,  background: paletteShapeBlock.background },
        rawHex:        { blockId: noteRawHex.blockId,        background: rawHexBlock.background },
      },
    },
  }, null, 2) + "\n");
  console.log(`[theme-defaults] All default-color conventions hold at the CRDT level.`);
  console.log(`[theme-defaults] State written to ${statePath}`);
  console.log(`[theme-defaults] Doc URL: ${BASE}/workspace/${W}/${D}`);
} finally {
  await client.close();
}
