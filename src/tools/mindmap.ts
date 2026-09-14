import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";
import { z } from "zod";
import type { GraphQLClient } from "../graphqlClient.js";
import { text, toolError } from "../util/mcp.js";
import { secureRandomInt31, secureRandomString } from "../util/random.js";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from "../ws.js";

// Native BlockSuite contract, verified against AFFiNE 174ad9bc5:
// affine/model/src/{consts/mindmap,elements/mindmap/mindmap}.ts.
// Connectors are LOCAL editor models derived from children, never stored shapes/edges.
export const MINDMAP_LAYOUTS = { right: 0, left: 1, balance: 2 } as const;
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const Label = z.string().min(1).max(4096).refine(s => s.trim().length > 0, "text must not be blank");
const Direction = z.enum(["right", "left", "balance"]);
const Style = z.number().int().min(1).max(4);
const Coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const MAX_NODES = 500;
const MAX_DEPTH = 64;
type Detail = { index: string; parent?: string; collapsed?: boolean };
type Values = Y.Map<any>;
type Node = { id: string; detail: Detail; element: Values; children: Node[] };
type Tree = { map: Values; details: Y.Map<Detail>; nodes: Map<string, Node>; root: Node };
export type MindmapHelpers = {
  getSurfaceElementsValueMap: (blocks: Values, options: { create: boolean }) => { surfaceId: string; value: Values } | null;
  buildSurfaceElementData: (type: "shape", index: string, input: { text: string }) => { elementId: string; data: Record<string, any> };
  writeSurfaceElement: (values: Values, id: string, data: Record<string, any>) => void;
  nextSurfaceElementIndex: (values: Values) => string;
};

/** Stops local processing before a mutation delta can be sent. */
function fail(message: string): never { throw new Error(message); }
/** Decodes positive shape bounds before layout or resizing. */
function bounds(element: Values): number[] {
  let b: unknown;
  try { b = JSON.parse(element.get("xywh")); } catch { fail("Invalid native node bounds"); }
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= 0 || b[3] <= 0) fail("Invalid native node bounds");
  return b as number[];
}

/** Validates native ownership and topology, then returns ordered shape nodes. */
function readTree(values: Values, mindmapId: string): Tree {
  Id.parse(mindmapId);
  const map = values.get(mindmapId);
  if (!(map instanceof Y.Map) || map.get("type") !== "mindmap") fail("mindmapId does not identify a native mindmap in this document");
  if (![0, 1, 2].includes(map.get("layoutType"))) fail("Unsupported native layoutType; supported: right, left, balance");
  Style.parse(map.get("style") ?? 1);
  const details = map.get("children");
  if (!(details instanceof Y.Map) || !details.size || details.size > MAX_NODES) fail("Invalid or oversized native mindmap children map");
  const nodes = new Map<string, Node>();
  for (const [id, detail] of details.entries()) {
    Id.parse(id);
    if (!detail || typeof detail !== "object" || typeof detail.index !== "string") fail("Invalid native node detail");
    generateKeyBetween(detail.index, null); // Validate BlockSuite fractional indices.
    if (detail.parent !== undefined) Id.parse(detail.parent);
    if (detail.collapsed !== undefined && typeof detail.collapsed !== "boolean") fail("Invalid collapsed state");
    const element = values.get(id);
    if (!(element instanceof Y.Map) || element.get("type") !== "shape" || !(element.get("text") instanceof Y.Text)) fail("Native node must reference an existing shape with Y.Text");
    bounds(element);
    nodes.set(id, { id, detail, element, children: [] });
  }
  const roots = [...nodes.values()].filter(n => n.detail.parent === undefined);
  if (roots.length !== 1) fail("Native mindmap must have exactly one root");
  for (const node of nodes.values()) {
    if (node.detail.parent !== undefined) {
      const parent = nodes.get(node.detail.parent);
      if (!parent) fail("Native node parent is missing or belongs to another mindmap");
      parent.children.push(node);
    }
    const seen = new Set<string>();
    let current: Node | undefined = node;
    while (current) {
      if (seen.has(current.id)) fail("Native mindmap contains a cycle");
      seen.add(current.id);
      if (seen.size > MAX_DEPTH) fail("Native mindmap exceeds maximum depth 64");
      current = current.detail.parent ? nodes.get(current.detail.parent) : undefined;
    }
  }
  // Sort only after every child has been linked.
  for (const node of nodes.values()) node.children.sort((a, b) => a.detail.index < b.detail.index ? -1 : a.detail.index > b.detail.index ? 1 : a.id.localeCompare(b.id));
  for (const [id, other] of values.entries()) {
    if (id === mindmapId || !(other instanceof Y.Map) || !["mindmap", "group"].includes(other.get("type"))) continue;
    const children = other.get("children");
    if (children instanceof Y.Map && [...nodes.keys()].some(key => children.has(key))) fail("Native node is also owned by another mindmap or group");
  }
  return { map, details, nodes, root: roots[0] };
}

/** Resolves a node only within the already validated mindmap. */
function nodeIn(tree: Tree, id: string): Node {
  Id.parse(id);
  return tree.nodes.get(id) ?? fail("nodeId/parentId/beforeId is missing or belongs to another mindmap");
}
/** Allocates a native fractional index without changing sibling IDs. */
function insertionIndex(parent: Node, beforeId?: string, excludeId?: string): string {
  const siblings = parent.children.filter(n => n.id !== excludeId);
  const pos = beforeId === undefined ? siblings.length : siblings.findIndex(n => n.id === beforeId);
  if (pos < 0) fail("beforeId must be a different child of the requested parent");
  return generateKeyBetween(siblings[pos - 1]?.detail.index ?? null, siblings[pos]?.detail.index ?? null);
}

// Persist layout as well as topology: remote Yjs changes do not invoke all local
// editor watchers. Spacing/balance match affine/gfx/mindmap/src/view/layout.ts.
/** Persists native spacing while preserving the root anchor and collapsed subtrees. */
function layoutTree(tree: Tree) {
  /** Measures visible subtree height for native vertical spacing. */
  const height = (node: Node, children = node.children): number => Math.max(bounds(node.element)[3], node.detail.collapsed || !children.length ? 0 : children.reduce((sum, child) => sum + height(child), 0) + 45 * (children.length - 1));
  /** Positions one side of a branch recursively without moving its anchor. */
  const place = (node: Node, children: Node[], right: boolean, first: boolean) => {
    if (node.detail.collapsed) return;
    const [x, y, w, h] = bounds(node.element);
    const treeHeight = height(node, children);
    let cursor = y + (h - treeHeight) / 2;
    if (h >= treeHeight && children.length) cursor += (h - bounds(children[0].element)[3]) / 2;
    for (const child of children) {
      const [, , cw, ch] = bounds(child.element);
      const branchHeight = height(child);
      const cx = right ? x + w + (first ? 200 : 110) : x - (first ? 200 : 110) - cw;
      child.element.set("xywh", JSON.stringify([cx, cursor + (branchHeight - ch) / 2, cw, ch]));
      place(child, child.children, right, false);
      cursor += branchHeight + 45;
    }
  };
  const children = tree.root.children;
  if (tree.map.get("layoutType") === 2) {
    const split = Math.ceil(children.length / 2);
    place(tree.root, children.slice(0, split), true, true);
    place(tree.root, children.slice(split).reverse(), false, true);
  } else place(tree.root, children, tree.map.get("layoutType") === 0, true);
}

/** Estimates label bounds until the native editor can refine text measurements. */
function resizeLabel(element: Values, label: string) {
  const [x, y] = bounds(element);
  const fontSize = Number(element.get("fontSize")) || 20;
  const padding = element.get("padding") ?? [10, 20];
  const max = typeof element.get("maxWidth") === "number" ? element.get("maxWidth") : 512;
  const widths = label.split("\n").map(line => [...line].length * fontSize * 0.65);
  const width = Math.min(max, Math.max(100, ...widths.map(w => w + padding[1] * 2)));
  const lines = widths.reduce((sum, w) => sum + Math.max(1, Math.ceil(w / Math.max(1, width - padding[1] * 2))), 0);
  element.set("xywh", JSON.stringify([x, y, width, Math.max(30, lines * fontSize * 1.4 + padding[0] * 2)]));
}

// Shape fields from AFFiNE 174ad9bc5 mindmap/style.ts; colors from its pinned
// @toeverything/theme 1.1.23. Connectors still come from the native style getter.
/** Selects the verified BlockSuite preset for a node depth and root branch. */
function nativeNodeStyle(style: number, root: boolean, branch: number, depth: number): Record<string, any> {
  const black = { light: "#000000", dark: "#ffffff" };
  const common = { textResizing: 0, maxWidth: 512, filled: true, color: "#000000", fontFamily: "blocksuite:surface:Poppins" };
  if (style === 4) return { ...common, radius: 0, strokeWidth: 0, strokeColor: "transparent", fillColor: "transparent", color: black, fontFamily: "blocksuite:surface:Kalam", fontSize: root ? 22 : 18, fontWeight: "700", padding: root ? [0, 10] : [1.5, 10] };
  if (style === 3) return { ...common, radius: 10, strokeWidth: root ? 0 : 2, strokeColor: root ? "transparent" : ["#fcd34d", "#3cbc36", "#5cc7ba"][(depth - 1) % 3], fillColor: root ? "#fcd34d" : "#ffffff", fontSize: 16, fontWeight: "500", padding: root ? [10, 22] : [6, 22], shadow: { blur: 12, offsetX: 0, offsetY: 0, color: "rgba(66, 65, 73, 0.18)" } };
  if (style === 2) return { ...common, radius: 3, strokeWidth: 3, strokeColor: black, fillColor: root ? "#fcd34d" : ["#84cfff", "#7ae2d5", "#fcd34d"][Math.min(depth - 1, 2)], fontSize: root ? 18 : 16, fontWeight: "600", padding: root ? [11, 22] : [6, 22], shadow: { blur: 0, offsetX: 3, offsetY: 3, color: black } };
  return { ...common, radius: 8, strokeWidth: root ? 4 : 3, strokeColor: root ? "#53b2ef" : ["#6e52df", "#e96cab", "#ff8c38", "#fcd34d", "#3cbc36", "#7ae2d5"][branch % 6], fillColor: "#ffffff", fontSize: root ? 20 : 16, fontWeight: root ? "600" : "500", padding: root ? [11, 22] : [6, 22], shadow: { offsetX: 0, offsetY: 6, blur: 12, color: "rgba(0, 0, 0, 0.14)" } };
}

/** Applies a remote style switch to every node, clearing obsolete preset fields. */
function styleTree(tree: Tree) {
  /** Propagates each root branch color and depth-specific style to descendants. */
  const visit = (node: Node, branch: number, depth: number) => {
    const style = nativeNodeStyle(tree.map.get("style") ?? 1, depth === 0, branch, depth);
    for (const [key, value] of Object.entries(style)) node.element.set(key, value);
    // FOUR has no shadow; clear a previous preset's shadow on a remote switch.
    if (!("shadow" in style)) node.element.delete("shadow");
    resizeLabel(node.element, node.element.get("text").toString());
    node.children.forEach((child, index) => visit(child, depth === 0 ? index : branch, depth + 1));
  };
  visit(tree.root, 0, 0);
}

/** Reads an optional native lock flag and rejects malformed stored values. */
function selfLocked(element: Values): boolean {
  const value = element.get("lockedBySelf");
  if (value !== undefined && typeof value !== "boolean") fail("Invalid native lockedBySelf state");
  return value ?? false;
}

/** Combines the map lock with inherited group locks, rejecting ownership cycles. */
function mapLock(values: Values, mindmapId: string) {
  const ancestors = new Set<string>();
  /** Walks group owners to collect inherited locks without revisiting ancestors. */
  const visit = (id: string, path: Set<string>) => {
    for (const [parentId, parent] of values.entries()) {
      if (!(parent instanceof Y.Map) || !["group", "mindmap"].includes(parent.get("type"))) continue;
      const children = parent.get("children");
      if (!(children instanceof Y.Map) || !children.has(id)) continue;
      if (path.has(parentId)) fail("Cyclic native group ownership");
      if (!ancestors.has(parentId)) {
        ancestors.add(parentId); visit(parentId, new Set([...path, parentId]));
      }
    }
  };
  visit(mindmapId, new Set([mindmapId]));
  const lockedBySelf = selfLocked(values.get(mindmapId));
  const lockedByAncestor = [...ancestors].some(id => selfLocked(values.get(id)));
  return { lockedBySelf, lockedByAncestor, locked: lockedBySelf || lockedByAncestor };
}

/** Creates a uniquely identified shape while preserving literal label text. */
function addShape(values: Values, helpers: MindmapHelpers, label: string) {
  const built = helpers.buildSurfaceElementData("shape", helpers.nextSurfaceElementIndex(values), { text: label });
  if (values.has(built.elementId)) fail("Generated node ID collision; retry the operation");
  // Preserve literal backslash-n text, unlike the general shape convenience API.
  built.data.text = new Y.Text(label);
  helpers.writeSurfaceElement(values, built.elementId, built.data);
  return built.elementId;
}

/** Returns a validated, serializable hierarchy with geometry and effective locks. */
export function readNativeMindmap(values: Values, mindmapId: string) {
  const tree = readTree(values, mindmapId);
  const lock = mapLock(values, mindmapId);
  return {
    mindmapId, rootId: tree.root.id, layout: Object.keys(MINDMAP_LAYOUTS).find(k => MINDMAP_LAYOUTS[k as keyof typeof MINDMAP_LAYOUTS] === tree.map.get("layoutType")),
    layoutType: tree.map.get("layoutType"), style: tree.map.get("style") ?? 1, nodeCount: tree.nodes.size,
    ...lock,
    nodes: [...tree.nodes.values()].map(n => ({ nodeId: n.id, parentId: n.detail.parent ?? null, index: n.detail.index, collapsed: n.detail.collapsed ?? false, text: n.element.get("text").toString(), lockedBySelf: selfLocked(n.element), locked: selfLocked(n.element) || lock.locked, xywh: n.element.get("xywh"), children: n.children.map(c => c.id) })),
    supportedLayouts: Object.keys(MINDMAP_LAYOUTS),
  };
}

type Operation = "create" | "add" | "update" | "reparent" | "layout" | "style" | "lock";
/** Mutates a request-local document; callers persist its delta only after success. */
export function mutateNativeMindmap(values: Values, operation: Operation, p: Record<string, any>, helpers: MindmapHelpers) {
  let mindmapId = p.mindmapId as string;
  let nodeId: string | undefined;
  // All mutations run on the request-local doc. No delta is pushed on failure.
  if (operation === "create") {
    Label.parse(p.text); Direction.parse(p.layout ?? "right"); Style.parse(p.style ?? 1);
    Coordinate.parse(p.x ?? 0); Coordinate.parse(p.y ?? 0);
    mindmapId = secureRandomString(10, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");
    if (values.has(mindmapId)) fail("Generated mindmap ID collision; retry the operation");
    nodeId = addShape(values, helpers, p.text);
    if (nodeId === mindmapId) fail("Generated ID collision; retry the operation");
    const element = values.get(nodeId);
    const [, , w, h] = bounds(element);
    element.set("xywh", JSON.stringify([p.x ?? 0, p.y ?? 0, w, h]));
    const details = new Y.Map<Detail>(); details.set(nodeId, { index: "a0" });
    helpers.writeSurfaceElement(values, mindmapId, { id: mindmapId, type: "mindmap", index: helpers.nextSurfaceElementIndex(values), seed: secureRandomInt31(), style: p.style ?? 1, lockedBySelf: false, layoutType: MINDMAP_LAYOUTS[(p.layout ?? "right") as keyof typeof MINDMAP_LAYOUTS], children: details });
  } else {
    const tree = readTree(values, mindmapId);
    if (operation === "lock") {
      const locked = z.boolean().parse(p.locked);
      tree.map.set("lockedBySelf", locked);
      return readNativeMindmap(values, mindmapId); // Never restyle/relayout during lock/unlock.
    }
    if (mapLock(values, mindmapId).locked || [...tree.nodes.values()].some(n => selfLocked(n.element))) {
      fail("Native mindmap or a node is locked; unlock the owning element before editing");
    }
    if (operation === "add") {
      Label.parse(p.text);
      if (tree.nodes.size >= MAX_NODES) fail("Native mindmap exceeds maximum node count 500");
      const parent = nodeIn(tree, p.parentId);
      const index = insertionIndex(parent, p.beforeId);
      nodeId = addShape(values, helpers, p.text);
      tree.details.set(nodeId, { index, parent: parent.id });
    } else if (operation === "update") {
      const node = nodeIn(tree, p.nodeId); nodeId = node.id;
      if (p.text === undefined && p.collapsed === undefined) fail("Provide text or collapsed to update a node");
      if (p.text !== undefined) {
        Label.parse(p.text);
        const value = node.element.get("text") as Y.Text;
        value.delete(0, value.length); value.insert(0, p.text);
        resizeLabel(node.element, p.text);
      }
      if (p.collapsed !== undefined) tree.details.set(node.id, { ...node.detail, collapsed: z.boolean().parse(p.collapsed) });
    } else if (operation === "reparent") {
      const node = nodeIn(tree, p.nodeId); nodeId = node.id;
      const parent = nodeIn(tree, p.parentId);
      if (node.id === tree.root.id) fail("Cannot reparent the root of a native mindmap");
      let current: Node | undefined = parent;
      while (current) {
        if (current.id === node.id) fail("Cannot reparent a node to itself or its descendant (cycle)");
        current = current.detail.parent ? tree.nodes.get(current.detail.parent) : undefined;
      }
      const index = insertionIndex(parent, p.beforeId, node.id);
      tree.details.set(node.id, { ...node.detail, parent: parent.id, index });
    } else if (operation === "style") {
      tree.map.set("style", Style.parse(p.style));
    } else {
      const direction = Direction.parse(p.layout);
      tree.map.set("layoutType", MINDMAP_LAYOUTS[direction]);
    }
  }
  const tree = readTree(values, mindmapId); // Validate before layout/persistence.
  if (["create", "add", "reparent", "style"].includes(operation)) styleTree(tree);
  layoutTree(tree);
  return { ...readNativeMindmap(values, mindmapId), ...(nodeId ? { nodeId } : {}) };
}

/** Registers native mindmap tools with per-request Yjs documents and socket cleanup. */
export function registerMindmapTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }, helpers: MindmapHelpers) {
  const base = { workspaceId: z.string().min(1).optional(), docId: Id };
  const target = { ...base, mindmapId: Id };
  /** Loads and validates one document, persists successful mutations, and releases resources. */
  const run = (operation: Operation | "get") => async (p: Record<string, any>): Promise<CallToolResult> => {
    const workspaceId = p.workspaceId || defaults.workspaceId;
    if (!workspaceId) return toolError("workspaceId is required", { code: "invalid_mindmap_input" }) as CallToolResult;
    let socket: Awaited<ReturnType<typeof connectWorkspaceSocket>> | undefined;
    const doc = new Y.Doc();
    try {
      const { endpoint, cookie, bearer } = await gql.getConnectionAuth();
      socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, p.docId);
      if (!snapshot.missing) fail("Document not found or has no content; create a document first");
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const blocks = doc.getMap("blocks");
      if (![...blocks.values()].some(b => b instanceof Y.Map && b.get("sys:flavour") === "affine:page")) fail("Document has no page root");
      const previous = Y.encodeStateVector(doc);
      const ctx = helpers.getSurfaceElementsValueMap(blocks, { create: operation === "create" });
      if (!ctx) fail("Document has no native surface");
      let result: ReturnType<typeof readNativeMindmap> & { nodeId?: string };
      if (operation === "get") result = readNativeMindmap(ctx.value, p.mindmapId);
      else {
        result = mutateNativeMindmap(ctx.value, operation, p, helpers);
        const delta = Y.encodeStateAsUpdate(doc, previous);
        await pushDocUpdate(socket, workspaceId, p.docId, Buffer.from(delta).toString("base64"));
      }
      return text({ ok: true, workspaceId, docId: p.docId, surfaceBlockId: ctx.surfaceId, ...result }) as CallToolResult;
    } catch (error) {
      return toolError(error, { code: "mindmap_operation_failed" }) as CallToolResult;
    } finally { socket?.disconnect(); doc.destroy(); }
  };
  server.registerTool("create_mindmap", {
    title: "Create Native Mindmap",
    description: "Create a native AFFiNE mindmap with one root shape in an existing document. Returns mindmapId/rootId for add_mindmap_node. Only right/left/balance are supported; down/up are unsupported by BlockSuite. Does not create a document or sidebar link.",
    inputSchema: { ...base, text: Label, layout: Direction.optional(), style: Style.optional(), x: Coordinate.optional(), y: Coordinate.optional() },
  }, run("create"));
  server.registerTool("get_mindmap", {
    title: "Get Native Mindmap",
    description: "Read and validate native mindmap hierarchy, ordered child IDs, text, collapsed state, geometry, and supported directions. Discover mindmapId via get_edgeless_canvas.",
    inputSchema: target,
  }, run("get"));
  server.registerTool("add_mindmap_node", {
    title: "Add Native Mindmap Node",
    description: "Add one native child shape to parentId inside mindmapId. beforeId optionally inserts before a sibling; otherwise append. Returns nodeId. Persists hierarchy and layout together. Maximum 500 nodes, depth 64; shape nodes only.",
    inputSchema: { ...target, parentId: Id, text: Label, beforeId: Id.optional() },
  }, run("add"));
  server.registerTool("update_mindmap_node", {
    title: "Update Native Mindmap Node",
    description: "Replace a native node's text and/or set collapsed. Keeps node IDs and hierarchy. Recalculates geometry; the editor may refine text dimensions when opened.",
    inputSchema: { ...target, nodeId: Id, text: Label.optional(), collapsed: z.boolean().optional() },
  }, run("update"));
  server.registerTool("reparent_mindmap_node", {
    title: "Reparent Native Mindmap Node",
    description: "Move a node with all descendants to a parent in the SAME native mindmap; beforeId optionally reorders siblings. Rejects root moves, cycles, missing/foreign IDs. Preserve collapsed state. One shared MCP server serializes workspace mutations; independent servers and native editors have no compare-and-swap protection.",
    inputSchema: { ...target, nodeId: Id, parentId: Id, beforeId: Id.optional() },
  }, run("reparent"));
  server.registerTool("set_mindmap_style", {
    title: "Set Native Mindmap Style",
    description: "Switch native style ONE=1, TWO=2, THREE=3, FOUR=4. Persists the preset on all nodes, sizes and layout; native connectors follow style. Keeps IDs, hierarchy, collapsed state and root anchor. Rejects locked maps/nodes.",
    inputSchema: { ...target, style: Style },
  }, run("style"));
  server.registerTool("set_mindmap_lock", {
    title: "Set Native Mindmap Lock",
    description: "Set the mindmap's native lockedBySelf flag. Nodes inherit the lock in AFFiNE. Unlock does not clear ancestor-group or independently locked node flags; read the returned effective locked state. Does not change layout or styles. This is an editor lock, not an access-control boundary.",
    inputSchema: { ...target, locked: z.boolean() },
  }, run("lock"));
  server.registerTool("set_mindmap_layout", {
    title: "Set Native Mindmap Layout",
    description: "Set right, left, or balance and persist native node positions. Root stays anchored; collapsed flags remain unchanged. BlockSuite does not support down/up. This is a native mindmap, with editor-derived connectors.",
    inputSchema: { ...target, layout: Direction },
  }, run("layout"));
}
