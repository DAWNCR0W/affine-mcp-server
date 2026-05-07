#!/usr/bin/env node
/**
 * End-to-end regression guard for layout helpers: stackAfter (single + array form),
 * childElementIds frame ownership, y-omitted auto-stack-below, connector auto-snap,
 * labelXYWH seeding, get_edgeless_canvas readback. Prerequisites in tests/run-e2e.sh.
 */
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
  console.error("  node tests/test-canvas-tool-map-demo.mjs");
  process.exit(1);
}

const client = new Client({ name: "affine-mcp-tool-map-example", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [MCP],
  cwd: REPO_ROOT,
  env: {
    AFFINE_BASE_URL: BASE,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: "sync",
    XDG_CONFIG_HOME: "/tmp/affine-mcp-tool-map-example",
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

await client.connect(transport);
try {
  const ws = await call("create_workspace", { name: `affine-mcp-tool-map-${Date.now()}` });
  const docId = (await call("create_doc", { workspaceId: ws.id, title: "AFFiNE MCP Server — Tool Map" })).docId;
  const W = ws.id;
  const D = docId;

  // Orientation banner — neither x nor y passed; auto-stack-below the default note.
  // Exercises the y-omitted fallback and markdown-driven height estimation.
  const orientation = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: 1850,
    background: "--affine-note-background-blue",
    markdown: [
      "# A local bridge from AI agents to AFFiNE",
      "Exposes ~90 tools over **MCP** (stdio or HTTP+bearer/OAuth). Talks to any AFFiNE instance via its GraphQL + y.js WebSocket protocol — no AFFiNE plugin required.",
      "- Works with **Claude Code**, **Cursor**, **Windsurf**, or anything speaking MCP",
      "- Authors docs, databases, comments, tags, collections, and now the **edgeless canvas**",
      "- Reads back every artifact as structured JSON for agent reasoning",
    ].join("\n"),
  });

  // Column 1: Authoring. Place the first note by absolute coords, then stackAfter for siblings,
  // then a frame with childElementIds that auto-sizes to the column and owns its notes.
  const COL1_X = 120, NOTE_W = 440, GAP = 50;
  const BANNER_TO_FIRST_NOTE_GAP = 200;

  const notesAndDocs = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    x: COL1_X, width: NOTE_W,
    stackAfter: { blockId: orientation.blockId, gap: BANNER_TO_FIRST_NOTE_GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Docs & Workspaces",
      "- `create_workspace`, `create_doc`, `delete_doc`, `duplicate_doc`",
      "- `update_doc_title`, `move_doc`, `publish_doc`",
      "- `batch_create_docs` for 20-at-a-time seeding",
      "- `create_doc_from_template`, `create_semantic_page`",
      "- `list_workspace_tree`, `list_children`, `get_doc_by_title`",
    ].join("\n"),
  });

  const markdownPower = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: NOTE_W,
    stackAfter: { blockId: notesAndDocs.blockId, gap: GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Markdown → BlockSuite blocks",
      "Markdown parses into real heading/paragraph/list/code blocks — *not* literal `#` characters.",
      "- `create_doc_from_markdown` · fresh doc",
      "- `replace_doc_with_markdown` · overwrite main note",
      "- `append_markdown`, `append_block(markdown: ...)` · add inside a note",
      "",
      "```ts",
      "append_block({ type: 'note', markdown });",
      "```",
    ].join("\n"),
  });

  const databases = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: NOTE_W,
    stackAfter: { blockId: markdownPower.blockId, gap: GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Databases & Data Views",
      "- `compose_database_from_intent` · high-level builder",
      "- `add_database_column`, `add_database_row`",
      "- `update_database_cell`, `update_database_row`",
      "- `read_database_columns`, `read_database_cells`",
      "- Kanban / Table views via `viewMode`",
    ].join("\n"),
  });

  const authoringFrame = await call("append_block", {
    workspaceId: W, docId: D, type: "frame",
    text: "Authoring",
    childElementIds: [notesAndDocs.blockId, markdownPower.blockId, databases.blockId],
    padding: 50,
  });

  // Column 3: Edgeless Canvas (NEW).
  const COL2_X = 1360;

  const layoutPrimitives = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    x: COL2_X, width: NOTE_W,
    stackAfter: { blockId: orientation.blockId, gap: BANNER_TO_FIRST_NOTE_GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Layout primitives",
      "Positioned blocks on the edgeless canvas.",
      "- `append_block(type: 'frame', x, y, width, height)` — regions with labels",
      "- `append_block(type: 'note', x, y, ...)` — markdown-backed content",
      "- `append_block(type: 'edgeless_text', x, y, ...)` — standalone canvas text",
      "- Auto-layout: `childElementIds: [...]` on frames (owns surface elements + auto-sizes), `stackAfter` on any edgeless block",
    ].join("\n"),
  });

  const surfaceElements = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: NOTE_W,
    stackAfter: { blockId: layoutPrimitives.blockId, gap: GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Surface elements",
      "- `add_surface_element(type: 'shape')` · rect/ellipse/diamond/rounded",
      "- `add_surface_element(type: 'connector')` · endpoints can be blocks or elements; **`labelXYWH` seeded at midpoint**",
      "- `add_surface_element(type: 'group')` · logical containment",
      "- `update_surface_element` · partial xywh merge preserves size on move",
      "- `delete_surface_element(pruneConnectors: true)`",
    ].join("\n"),
  });

  const readback = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: NOTE_W,
    stackAfter: { blockId: surfaceElements.blockId, gap: GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Read-back for agents",
      "`get_edgeless_canvas` returns the full scene — **deterministic z-order** (fractional index) + structured note `children[]` so markdown round-trips with heading/list/code semantics intact.",
      "- `list_surface_elements` · filter by id or type",
      "- `get_edgeless_canvas` · the agent-facing view",
    ].join("\n"),
  });

  const edgelessFrame = await call("append_block", {
    workspaceId: W, docId: D, type: "frame",
    text: "Edgeless Canvas",
    childElementIds: [layoutPrimitives.blockId, surfaceElements.blockId, readback.blockId],
    padding: 50,
  });

  // Column 2: Discovery & Ops.
  const COL3_X = 740;

  const finding = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    x: COL3_X, width: NOTE_W,
    stackAfter: { blockId: orientation.blockId, gap: BANNER_TO_FIRST_NOTE_GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Finding content",
      "- `search_docs` · full-text",
      "- `list_docs`, `list_docs_by_tag`, `get_docs_by_tag`",
      "- `get_doc` / `read_doc` · structured block tree",
      "- `export_doc_markdown` · round-trip to markdown",
      "- `find_and_replace` · bulk edits across a doc",
    ].join("\n"),
  });

  const relationships = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: NOTE_W,
    stackAfter: { blockId: finding.blockId, gap: GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Relationships & graph",
      "- `list_backlinks` · who links here?",
      "- `get_orphan_docs` · unreachable from any tree",
      "- `list_workspace_tree` · full hierarchy",
      "- `list_organize_nodes`, `add_organize_link` · sidebar organization",
      "- `list_collections`, `update_collection_rules` · smart collections",
    ].join("\n"),
  });

  const authUsers = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: NOTE_W,
    stackAfter: { blockId: relationships.blockId, gap: GAP },
    background: { light: "#ffffff", dark: "#252525" },
    markdown: [
      "# Auth, users, notifications",
      "- `current_user`, `update_profile`, `update_settings`",
      "- `generate_access_token`, `list_access_tokens`, `revoke_access_token`",
      "- `list_comments`, `create_comment`, `resolve_comment`",
      "- `list_notifications`, `read_all_notifications`",
    ].join("\n"),
  });

  const discoveryFrame = await call("append_block", {
    workspaceId: W, docId: D, type: "frame",
    text: "Discovery & Ops",
    childElementIds: [finding.blockId, relationships.blockId, authUsers.blockId],
    padding: 50,
  });

  // Bottom banner — array form of stackAfter picks the bottommost anchor for direction="down".
  const agentView = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    width: 1850,
    stackAfter: {
      blockId: [authoringFrame.blockId, edgelessFrame.blockId, discoveryFrame.blockId],
      gap: 80,
    },
    background: "--affine-note-background-purple",
    markdown: [
      "# What an agent actually reads",
      "`get_edgeless_canvas` returns everything above as JSON an agent can reason over directly.",
      "- Each note emits `children: [{ flavour, type, text, language?, checked? }]` — typed block tree",
      "- Connectors expose `source.id` / `target.id` → joinable to block ids → the canvas **is a typed graph**",
      "- `bounds` mirrors `gfx.fitToScreen`; z-order is the canonical fractional-index sort",
    ].join("\n"),
  });

  // Visual embellishments — "NEW" badge and decorative shapes.
  const newBadge = await call("add_surface_element", {
    workspaceId: W, docId: D, type: "shape",
    shapeType: "diamond",
    x: 1870, y: 498, width: 100, height: 52,
    text: "NEW",
    fillColor: "--affine-palette-shape-orange",
  });
  await call("add_surface_element", {
    workspaceId: W, docId: D, type: "connector",
    sourceId: newBadge.elementId,
    targetId: edgelessFrame.blockId,
    label: "this branch",
    rearEndpointStyle: "Arrow",
  });

  // Connectors: fan-out from orientation banner, vertical chains per column, fan-in to bottom banner.
  const edges = [
    // Top-down fan-out
    [orientation.blockId, notesAndDocs.blockId,     "authoring"],
    [orientation.blockId, layoutPrimitives.blockId, "edgeless"],
    [orientation.blockId, finding.blockId,          "discovery"],

    // Vertical chains (one per column)
    [notesAndDocs.blockId,   markdownPower.blockId,   ""],
    [markdownPower.blockId,  databases.blockId,       ""],
    [layoutPrimitives.blockId, surfaceElements.blockId, ""],
    [surfaceElements.blockId,  readback.blockId,        "reads as graph"],
    [finding.blockId,       relationships.blockId,   ""],
    [relationships.blockId, authUsers.blockId,       ""],

    // Bottom fan-in
    [databases.blockId,  agentView.blockId, ""],
    [readback.blockId,   agentView.blockId, "feeds"],
    [authUsers.blockId,  agentView.blockId, ""],
  ];
  for (const [sId, tId, label] of edges) {
    await call("add_surface_element", {
      workspaceId: W, docId: D, type: "connector",
      sourceId: sId, targetId: tId,
      label: label || undefined,
      rearEndpointStyle: "Arrow",
    });
  }

  // Group the three column notes in the Edgeless section — logical cluster
  await call("add_surface_element", {
    workspaceId: W, docId: D, type: "group",
    title: "Edgeless tools",
    children: [layoutPrimitives.blockId, surfaceElements.blockId, readback.blockId],
  });

  // Assertions — read the scene back and verify layout-helper contracts.
  const canvas = await call("get_edgeless_canvas", { workspaceId: W, docId: D });

  const expect = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };
  // get_edgeless_canvas emits `id` on both edgelessBlocks and surfaceElements
  // (not `blockId` / `elementId` — those are append_block / add_surface_element
  // response fields). Match on `id`.
  const findBlock = (id) => canvas.edgelessBlocks.find(b => b.id === id);
  const findElem  = (id) => canvas.surfaceElements.find(e => e.id === id);

  // Block/element counts — shape of the seeded scene.
  expect(canvas.elementCounts.connector === 13, `expected 13 connectors, got ${canvas.elementCounts.connector}`);
  expect(canvas.elementCounts.shape === 1,      `expected 1 shape, got ${canvas.elementCounts.shape}`);
  expect(canvas.elementCounts.group === 1,      `expected 1 group, got ${canvas.elementCounts.group}`);
  // 15 = 1 default note (seeded by create_doc per BlockSuite's createDefaultDoc)
  //    + 11 authored notes (1 orientation banner + 9 column notes + 1 agent-view)
  //    + 3 frames
  expect(canvas.edgelessBlocks.length === 15,   `expected 15 edgeless blocks (1 default + 11 notes + 3 frames), got ${canvas.edgelessBlocks.length}`);

  // stackAfter contract: every sibling produced with stackAfter sits
  // strictly below the block it references, with no overlap on the y-axis.
  const chains = [
    [notesAndDocs,      markdownPower,    "authoring 1→2"],
    [markdownPower,     databases,        "authoring 2→3"],
    [layoutPrimitives,  surfaceElements,  "edgeless 1→2"],
    [surfaceElements,   readback,         "edgeless 2→3"],
    [finding,           relationships,    "discovery 1→2"],
    [relationships,     authUsers,        "discovery 2→3"],
  ];
  for (const [prev, next, label] of chains) {
    const p = findBlock(prev.blockId).bounds;
    const n = findBlock(next.blockId).bounds;
    expect(n.y >= p.y + p.height, `stackAfter ${label}: next.y (${n.y}) must be >= prev.y+height (${p.y + p.height})`);
  }

  // stackAfter array form: agentView references all three bottom frames
  // and must sit below whichever is lowest.
  const aBounds = findBlock(agentView.blockId).bounds;
  const lowestFrameBottom = Math.max(
    ...[authoringFrame, edgelessFrame, discoveryFrame].map(f => {
      const b = findBlock(f.blockId).bounds;
      return b.y + b.height;
    }),
  );
  expect(aBounds.y >= lowestFrameBottom, `stackAfter array form: agentView.y (${aBounds.y}) must be >= max frame bottom (${lowestFrameBottom})`);

  // childElementIds contract: every frame wraps its declared contents with
  // padding >= the requested 50 on all sides, and every passed id ends up
  // owned (in `ownedIds`) — BlockSuite's prop:childElementIds holds both
  // surface elements and block ids, so dragging the frame drags the notes.
  const enclosures = [
    [authoringFrame, [notesAndDocs, markdownPower, databases],           "Authoring"],
    [edgelessFrame,  [layoutPrimitives, surfaceElements, readback],      "Edgeless"],
    [discoveryFrame, [finding, relationships, authUsers],                "Discovery & Ops"],
  ];
  for (const [frame, kids, name] of enclosures) {
    const f = findBlock(frame.blockId).bounds;
    for (const k of kids) {
      const c = findBlock(k.blockId).bounds;
      expect(c.x >= f.x && c.x + c.width  <= f.x + f.width,
        `${name} frame must enclose child on x-axis (child [${c.x}..${c.x+c.width}] vs frame [${f.x}..${f.x+f.width}])`);
      expect(c.y >= f.y && c.y + c.height <= f.y + f.height,
        `${name} frame must enclose child on y-axis (child [${c.y}..${c.y+c.height}] vs frame [${f.y}..${f.y+f.height}])`);
    }
    const expectedOwned = kids.map(k => k.blockId).sort();
    const actualOwned = [...(frame.ownedIds ?? [])].sort();
    expect(
      actualOwned.length === expectedOwned.length &&
        actualOwned.every((v, i) => v === expectedOwned[i]),
      `${name} frame: ownedIds expected ${JSON.stringify(expectedOwned)}, got ${JSON.stringify(actualOwned)}`
    );
  }

  // Connector auto-snap: every connector we seeded with sourceId+targetId
  // and no explicit position must come back with source.position and
  // target.position on one of the four tangent-carrying side-midpoints.
  const SIDE_MIDPOINTS = [[0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]];
  const onSideMidpoint = (pos) =>
    Array.isArray(pos) && SIDE_MIDPOINTS.some(([x, y]) => pos[0] === x && pos[1] === y);
  const connectors = canvas.surfaceElements.filter(e => e.type === "connector");
  for (const c of connectors) {
    expect(onSideMidpoint(c.source?.position),
      `connector ${c.elementId}: source.position ${JSON.stringify(c.source?.position)} is not a side-midpoint`);
    expect(onSideMidpoint(c.target?.position),
      `connector ${c.elementId}: target.position ${JSON.stringify(c.target?.position)} is not a side-midpoint`);
  }

  // labelXYWH seeding: every connector we passed a `label` to must have
  // a labelXYWH tuple of four finite numbers (midpoint rectangle).
  const labeledConnectors = connectors.filter(c => typeof c.text === "string" && c.text.length > 0);
  expect(labeledConnectors.length >= 5, `expected >=5 labeled connectors, got ${labeledConnectors.length}`);
  for (const c of labeledConnectors) {
    const lx = c.labelXYWH;
    expect(Array.isArray(lx) && lx.length === 4 && lx.every(n => Number.isFinite(n)),
      `connector ${c.elementId} "${c.text}": labelXYWH must be [x,y,w,h] of finite numbers, got ${JSON.stringify(lx)}`);
  }

  // Auto-stack-below fallback inherits x from the default note and places y
  // at (default-note bottom + gap) or lower.
  const orientationBounds = findBlock(orientation.blockId).bounds;
  expect(orientationBounds.x === 0,
    `orientation banner x should inherit default note's x=0, got ${JSON.stringify(orientationBounds)}`);
  expect(orientationBounds.y >= 92 + 40,
    `orientation banner y should be at or below (default-note bottom + gap): ${JSON.stringify(orientationBounds)}`);

  const summary = {
    docUrl: `${BASE}/workspace/${W}/${D}`,
    workspaceId: W,
    docId: D,
    counts: {
      edgelessBlocks: canvas.edgelessBlocks.length,
      surfaceElements: canvas.surfaceElements.length,
      connectors: canvas.elementCounts.connector,
      shapes: canvas.elementCounts.shape,
      groups: canvas.elementCounts.group,
    },
    bounds: canvas.bounds,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log();
  console.log(`All layout-helper assertions passed. Open in AFFiNE: ${summary.docUrl}`);
} finally {
  await client.close();
}
