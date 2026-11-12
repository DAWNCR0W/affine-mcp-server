# Edgeless Canvas Cookbook

A worked, live-authored walkthrough of the edgeless canvas tools. Every call in this doc was executed against a running AFFiNE instance while authoring it; the IDs, coordinates, and responses below are real output from that session, not illustrative fiction.

## What you'll build

An auth-flow diagram: four rectangles (User, Auth Service, Database, Cache) stitched with labeled connectors, wrapped in a **Frame that owns the diagram** — drag the frame in the editor and everything inside moves with it. Followed by an epilogue note that lands in the right place by itself, no coordinate math.

```
┌─ Frame "Auth Flow" ────────────────────────────────────────┐
│                                                            │
│   [ User ]  ──authenticate─→  [ Auth Service ]             │
│                                    │                       │
│                              ──verify──→                   │
│                                    │                       │
│                              [ Database ]                  │
│                                                            │
│                              [ Cache ]  ←─session lookup─  │
└────────────────────────────────────────────────────────────┘

[ Epilogue note — auto-placed below the frame with padding gap ]
```

## The full call sequence

Every step below is copy-pasteable. Replace `W` with your workspace id.

### 1. Fresh doc

```js
const { docId: D } = await call("create_doc", {
  workspaceId: W,
  title: "Edgeless Canvas Cookbook — Live Demo",
  content: "This doc was seeded live by the edgeless-canvas cookbook.",
});
```

AFFiNE seeds a default note at `[0,0,800,~268]` — we'll leave it; step 6 demonstrates how the auto-placement default dodges it.

### 2. Three surface shapes

```js
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
// → returns { added: true, elementId: "cczYKQ593K", type: "shape", surfaceBlockId: "wpv4iPX3Qj" }, ...
```

### 3. Labeled connectors between them

```js
const c1 = await call("add_surface_element", {
  workspaceId: W, docId: D, type: "connector",
  sourceId: user.elementId, targetId: auth.elementId, label: "authenticate",
});
const c2 = await call("add_surface_element", {
  workspaceId: W, docId: D, type: "connector",
  sourceId: auth.elementId, targetId: db.elementId, label: "verify",
});
```

With both endpoints bound by id and no explicit `sourcePosition` / `targetPosition`, BlockSuite's side-midpoint auto-snap kicks in — each endpoint lands on one of `[0.5,0]`, `[0.5,1]`, `[0,0.5]`, `[1,0.5]`. `labelXYWH` is seeded at the source→target midpoint so the label renders on first open.

### 4. Wrap the diagram in a frame that **owns** it

```js
const frame = await call("append_block", {
  workspaceId: W, docId: D, type: "frame",
  text: "Auth Flow",
  childElementIds: [user.elementId, auth.elementId, db.elementId, c1.elementId, c2.elementId],
  padding: 50,
});
// → {
//     appended: true, blockId: "wx0OB2I2cp", flavour: "affine:frame",
//     ownedIds: ["cczYKQ593K","dSfmVkc3Io","goh9bQO5sg","jDvyiSy5Su","O5Gtcr17O2"],
//     missing: []
//   }
```

With `width`/`height` omitted, the frame auto-sizes to the union of its children's bounds plus `padding` on each side and a 30px title band at the top. Every resolved id lands in `ownedIds` — dragging the frame in the editor now drags the whole diagram. BlockSuite's `prop:childElementIds` accepts both surface elements (shapes/connectors/groups) and edgeless blocks (notes/frames/edgeless-text), so you can wrap either without triage.

### 5. Add a new member and let the frame regrow

```js
const cache = await call("add_surface_element", {
  workspaceId: W, docId: D, type: "shape", shapeType: "rect", radius: 0.2,
  x: 500, y: 600, width: 160, height: 80, text: "Cache", fontSize: 18,
  fillColor: "--affine-palette-shape-orange",
});
const c3 = await call("add_surface_element", {
  workspaceId: W, docId: D, type: "connector", mode: 1,
  sourceId: auth.elementId, targetId: cache.elementId, label: "session lookup",
});

await call("update_frame_children", {
  workspaceId: W, docId: D, blockId: frame.blockId,
  childElementIds: [user.elementId, auth.elementId, db.elementId, c1.elementId, c2.elementId, cache.elementId, c3.elementId],
  padding: 50,
});
// → {
//     updated: true, blockId: "wx0OB2I2cp", flavour: "affine:frame",
//     ownedIds: [..., "9aYW_HNajo", "wzoKIrLkO-"],
//     missing: [],
//     resized: true, xywh: { x: 150, y: 290, width: 860, height: 440 }
//   }
```

`update_frame_children` replaces ownership **wholesale** (same semantics as `update_surface_element` for a group's `children`) and by default recomputes `xywh` so the box fits its new contents. Pass `resizeToFit: false` to keep the box untouched:

```js
await call("update_frame_children", {
  workspaceId: W, docId: D, blockId: frame.blockId,
  childElementIds: [user.elementId, auth.elementId, db.elementId, c1.elementId, c2.elementId],
  resizeToFit: false,
});
// → { updated: true, ownedIds: [...], resized: false }
```

Use the opt-out when you want to shrink ownership without the frame jumping around the canvas.

### 6. Append a note with no coordinates — it lands in the right place

```js
await call("append_block", {
  workspaceId: W, docId: D, type: "note",
  width: 800, height: 120,
  markdown: [
    "## How this canvas was built",
    "",
    "Every block, shape, and frame above was authored with a single MCP tool call.",
    "The frame owns its shapes via `prop:childElementIds` — drag it and the diagram moves with it.",
  ].join("\n"),
});
// → note xywh ends up at [150, 770, 800, 166.5]
```

No `x`/`y`, no `stackAfter` — yet the note lands at `y=770`, which is the frame's bottom edge (`290 + 440 = 730`) plus the default `padding` gap of 40. When you append a `frame`/`note`/`edgeless_text` to a doc and don't provide an explicit position or `stackAfter`, the server auto-stacks it below whichever edgeless block sits lowest. The common "new note overlaps AFFiNE's seeded default note at `[0,0,…]`" papercut is gone.

Pass `x: 0, y: 0` explicitly if you *want* the old behavior back.

## The id triage: owned vs missing

`childElementIds` (on both `append_block` and `update_frame_children`) accepts any mix of surface-element and block ids. Everything that resolves gets written to the frame's `prop:childElementIds` Y.Map — the same shape BlockSuite's editor writes when you drag members into a frame, so dragging the frame drags every owned member regardless of flavour.

| Lands in | When |
| --- | --- |
| `ownedIds` | id resolves to an existing surface element OR edgeless block. Written to `prop:childElementIds`. Frame drags them along. |
| `missing` | id doesn't resolve to either. Skipped; returned so callers can tell stale ids from intentional ones. |

If **every** id is missing on `append_block`, the call throws (`None of the ids in childElementIds were found: [...]`) — that's almost always a caller bug. `update_frame_children` tolerates all-missing and treats it as "clear ownership" (paired with a skipped resize).

## Read the whole canvas back

```js
const canvas = await call("get_edgeless_canvas", { workspaceId: W, docId: D });
// canvas.edgelessBlocks: [
//   { flavour: "affine:note",  xywh: "[0,0,800,268]",     bounds: {...}, children: [...] },
//   { flavour: "affine:frame", xywh: "[150,290,860,440]", title: "Auth Flow",
//     childElementIds: ["cczYKQ593K","dSfmVkc3Io","goh9bQO5sg","jDvyiSy5Su","O5Gtcr17O2","9aYW_HNajo","wzoKIrLkO-"] },
//   { flavour: "affine:note",  xywh: "[150,770,800,166.5]", children: [
//       { flavour: "affine:paragraph", text: "How this canvas was built", type: "h2" },
//       { flavour: "affine:paragraph", text: "Every block, shape, and frame above...", type: "text" },
//   ] },
// ],
// canvas.surfaceElements: [shape(User), shape(Auth), shape(Database),
//                          connector(authenticate), connector(verify),
//                          shape(Cache), connector(session lookup)],
// canvas.bounds: { minX: 0, minY: 0, maxX: 1010, maxY: 936.5, width: 1010, height: 936.5 }
```

Frame entries now carry `childElementIds: string[]` so agents can see ownership without crawling the surface layer. Note entries emit a structured `children: [{ flavour, type, text, language?, checked? }]` array — markdown round-trips with heading/list/code semantics intact, no re-parsing needed.

## Running it

From the repo root with Docker available:

```bash
. tests/generate-test-env.sh
docker compose --env-file "$AFFINE_TEST_ENV_FILE" -p "affine_mcp_cookbook_$$" -f docker/docker-compose.yml up -d
node tests/acquire-credentials.mjs
npm run build
```

Then drop the calls above into a Node script that opens a `StdioClientTransport` against `dist/index.js` — `tests/test-canvas-tool-map-demo.mjs` is a complete example of the client wiring, minus the auth-flow content. The script prints the seeded doc URL; open it in a browser, switch to edgeless mode (icon next to the doc title), and the frame + its five owned elements select and drag as one.

The live example is destructive and is loopback-only by default. See the
live-test safety section in `CONTRIBUTING.md` before using any non-loopback
disposable target. Remove the Compose project and the generated private env
file when the manual run is complete.

## Advanced: the tool-map showcase

`tests/test-canvas-tool-map-demo.mjs` seeds a much larger canvas — three color-coded columns mapping the full tool catalog, with each column's notes owned by a frame via `childElementIds` so dragging the frame moves the entire column together. It doubles as a layout-helper regression test wired into `tests/run-e2e.sh`. It's the right place to look for end-to-end coverage of `stackAfter`, `childElementIds` ownership across flavours, connector side-midpoint auto-snap, and `labelXYWH` seeding all in one run.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/edgeless-canvas-demo-advanced-dark.png">
  <img alt="AFFiNE MCP Tool Map — three color-coded columns wrapped in frames, connectors fanning out from a top banner into column chains and fanning in to a bottom agent-view banner" src="./assets/edgeless-canvas-demo-advanced-light.png">
</picture>

## Tool surface at a glance

| Tool | Purpose |
| --- | --- |
| `add_surface_element` | Shapes / connectors / canvas text / groups on `affine:surface`. Connectors auto-snap endpoints to side-midpoints when both are bound by id. |
| `append_block(type="frame", childElementIds)` | Create a frame that owns surface elements and auto-sizes to contain them. |
| `update_frame_children` | Replace a frame's contents wholesale. Default resizes to fit; `resizeToFit: false` preserves the current box. |
| `append_block(type="note" / "frame" / "edgeless_text")` | Edgeless blocks. Bare calls auto-stack below existing blocks; pass `x`/`y` or `stackAfter` to override. |
| `get_edgeless_canvas` | Read the full canvas: edgeless blocks + surface elements with parsed bounds, aggregate bounding box, and per-type counts. Frame entries now include `childElementIds`. |

## BlockSuite alignment notes

Everything above writes to the native BlockSuite schema — no custom overlay:

- Surface elements land in `affine:surface` → `prop:elements.value` as `Y.Map` entries with fractional-index strings for stable z-order.
- Frame ownership uses `prop:childElementIds` as a `Y.Map<boolean>` keyed by element id — identical shape to a group's `children` map.
- Connectors with both endpoints bound by id and no explicit position auto-snap to the four tangent-carrying side-midpoints (`[0.5,0]`, `[0.5,1]`, `[0,0.5]`, `[1,0.5]`).
- `labelXYWH` is seeded at the source→target midpoint so BlockSuite's label renderer doesn't short-circuit on first render.
- `append_block(type="edgeless_text", text=…)` auto-creates a child `affine:paragraph` — the edgeless-text view walks `sys:children` for glyphs, so without it the block renders as an invisible sliver.
- `src/edgeless/layout.ts` is a dependency-free module citing the upstream BlockSuite files each helper mirrors (`connector.ts`, `connector-manager.ts`, `edgeless-note-mask.ts`), so future parity audits stay cheap.

## Canvas layer and frame presentation order

Canvas blocks and surface elements share one fractional-index layer space.
New notes, canvas text, surface-parented images and surface elements receive a
key after the greatest existing layer key. Frames receive a key before the
lowest existing layer key so their backgrounds stay behind their contents.
Page-contained media retain their legacy properties.

Frame presentation order uses a separate `prop:presentationIndex`: each newly
appended frame receives a key after all existing frame presentation keys.
`get_edgeless_canvas` reports this as `presentationIndex`; its array remains
sorted by layer `index`, so sort frames by `presentationIndex` to read the
presentation sequence. Do not use document children or Y.Map iteration order
as a substitute. Existing frame keys are not automatically renumbered.
For legacy frames without a stored presentation key, allocation accounts for
AFFiNE's `a0`-prefixed default so a new frame still follows them on browser load.

This follows AFFiNE v0.27.4's
[`LayerManager.generateIndex`](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/framework/std/src/gfx/layer.ts)
and
[`EdgelessFrameManager`](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/affine/blocks/frame/src/frame-manager.ts):
`generateIndex(true)` places frames behind content, while
`generatePresentationIndex()` and `framePresentationComparator` govern slides.

## Image blocks: page vs canvas

AFFiNE stores an image's rendered size in `prop:width`/`prop:height` and its
canvas placement in `prop:xywh`. The two are not interchangeable:

| Concern | Page (inside a note) | Canvas (surface child) |
| --- | --- | --- |
| `prop:xywh` | unused or stale (`[0,0,0,0]`) | authoritative placement |
| `prop:width` / `prop:height` | intrinsic size, written by the editor | must equal the `xywh` width/height |
| Source of truth | stored dimensions | `xywh` (kept in sync) |
| `get_edgeless_canvas` | excluded | listed with `sourceId`, `caption`, `bounds` |
| `update_edgeless_block` | stored dimensions win for omitted fields; never write `0` | `xywh` wins for omitted fields; reject dimensions outside 1–10000 |
| `move_block` | flavour maps to `"image"` | page → canvas prefers the stored dimensions; canvas → page flow (note/paragraph/list) copies the canvas size into the stored dimensions |
| `append_block` | no geometry → `[0,0,0,0]` | missing dimensions default to 100 |

Rules:

- The AFFiNE editor can resize an image without touching `prop:xywh`, so a page
  image's `xywh` may be stale. When it moves to the surface, the stored
  dimensions win.
- When a parameter is omitted, preserve the existing value; never write `0`
  over a stored dimension.
- Only images parented to `affine:surface` are canvas elements. Images inside a
  page note stay in `read_doc` and must not appear in `get_edgeless_canvas`.

## Native mindmap deletion

Native mindmaps own their node shapes through their `children` map, as defined
by AFFiNE's [native mindmap model](https://github.com/toeverything/AFFiNE/blob/174ad9bc5/blocksuite/affine/model/src/elements/mindmap/mindmap.ts).
Deleting a valid map removes these shapes too. With `pruneConnectors: true`,
cleanup covers endpoints bound to every deleted ID and removes those IDs from
frame ownership. A malformed map is removed without guessing which shapes it owns.

## Markdown lists inside notes

Markdown-seeded notes use native `affine:list` blocks. A nested item belongs in
its parent list's `sys:children`, while `sys:parent` may remain `null`, as for
other native blocks in this server. Each sibling sequence keeps its own
insertion anchor so an item following a subtree remains at its original level.
This follows AFFiNE v0.27.4's
[`ListBlockSchema`](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/affine/model/src/blocks/list/list-model.ts)
and
[`BlockModel`](https://github.com/toeverything/AFFiNE/blob/v0.27.4/blocksuite/framework/store/src/model/block/block-model.ts).
