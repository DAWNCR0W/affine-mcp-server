/** Pure-function edgeless-canvas layout helpers. No Y.Doc, no MCP wiring. */

/** Matches BlockSuite's `IBound`. */
export interface Bound {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type EdgeSide = "top" | "bottom" | "left" | "right";

/** Only these four positions carry tangent vectors in BlockSuite's connector model. */
export const SIDE_TO_NORMALIZED_POSITION: Record<EdgeSide, readonly [number, number]> = {
  top: [0.5, 0],
  bottom: [0.5, 1],
  left: [0, 0.5],
  right: [1, 0.5],
} as const;

/** Pick connector sides for a src/tgt pair. Single-axis → that axis; diagonal →
 *  dominant by center displacement; overlap → 4×4 midpoint minimization. Ports
 *  BlockSuite's `getNearestConnectableAnchor` (`connector-manager.ts:174-190`). */
export function pickConnectorSides(
  src: Bound,
  tgt: Bound
): { from: EdgeSide; to: EdgeSide } {
  const srcBottom = src.y + src.h;
  const srcRight = src.x + src.w;
  const tgtBottom = tgt.y + tgt.h;
  const tgtRight = tgt.x + tgt.w;

  const above = srcBottom <= tgt.y;
  const below = tgtBottom <= src.y;
  const leftOf = srcRight <= tgt.x;
  const rightOf = tgtRight <= src.x;

  const vSeparated = above || below;
  const hSeparated = leftOf || rightOf;

  if (vSeparated && !hSeparated) {
    return above ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
  }
  if (hSeparated && !vSeparated) {
    return leftOf ? { from: "right", to: "left" } : { from: "left", to: "right" };
  }

  if (vSeparated && hSeparated) {
    const dx = (tgt.x + tgt.w / 2) - (src.x + src.w / 2);
    const dy = (tgt.y + tgt.h / 2) - (src.y + src.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
    }
    return dy >= 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
  }

  const anchors = (b: Bound) => [
    { side: "top" as EdgeSide, x: b.x + b.w / 2, y: b.y },
    { side: "bottom" as EdgeSide, x: b.x + b.w / 2, y: b.y + b.h },
    { side: "left" as EdgeSide, x: b.x, y: b.y + b.h / 2 },
    { side: "right" as EdgeSide, x: b.x + b.w, y: b.y + b.h / 2 },
  ];
  const srcA = anchors(src);
  const tgtA = anchors(tgt);

  let best: { from: EdgeSide; to: EdgeSide; dist: number } = {
    from: "bottom",
    to: "top",
    dist: Infinity,
  };
  for (const a of srcA) {
    for (const b of tgtA) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = dx * dx + dy * dy;
      if (dist < best.dist) best = { from: a.side, to: b.side, dist };
    }
  }
  return { from: best.from, to: best.to };
}

/** Enclosing bound of `children`, expanded by `padding` and `titleBand` (extra on top for a frame title). */
export function encloseBounds(
  children: Bound[],
  opts: { padding?: number; titleBand?: number } = {}
): Bound | null {
  if (children.length === 0) return null;
  const padding = opts.padding ?? 40;
  const titleBand = opts.titleBand ?? 60;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of children) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  return {
    x: Math.floor(minX - padding),
    y: Math.floor(minY - padding - titleBand),
    w: Math.max(1, Math.ceil(maxX - minX + padding * 2)),
    h: Math.max(1, Math.ceil(maxY - minY + padding * 2 + titleBand)),
  };
}

/** Pick the bound furthest along `direction` (bottommost for `"down"`, etc). */
export function pickFurthestInDirection(
  candidates: Bound[],
  direction: "down" | "up" | "left" | "right"
): Bound | null {
  if (candidates.length === 0) return null;
  let chosen = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (direction === "down" && c.y + c.h > chosen.y + chosen.h) chosen = c;
    else if (direction === "up" && c.y < chosen.y) chosen = c;
    else if (direction === "right" && c.x + c.w > chosen.x + chosen.w) chosen = c;
    else if (direction === "left" && c.x < chosen.x) chosen = c;
  }
  return chosen;
}

/** Parse BlockSuite's `[x,y,w,h]` string. Returns null if the input isn't well-formed. */
export function parseXywhString(
  value: unknown
): { x: number; y: number; width: number; height: number } | null {
  if (typeof value !== "string") return null;
  const m = value.match(
    /^\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*$/
  );
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

/** Inverse of `parseXywhString`. */
export function formatXywhString(x: number, y: number, width: number, height: number): string {
  return `[${x},${y},${width},${height}]`;
}

/** Asymmetric defaults: notes default to wide/short, so equal gaps feel tight horizontally. */
export const DEFAULT_STACK_GAP_VERTICAL = 40;
export const DEFAULT_STACK_GAP_HORIZONTAL = 80;

/** BlockSuite's createDefaultDoc constants (packages/affine/model/src/consts/note.ts). */
export const DEFAULT_PAGE_BLOCK_WIDTH = 800;
export const DEFAULT_NOTE_HEIGHT = 92;
export const DEFAULT_NOTE_XYWH = `[0,0,${DEFAULT_PAGE_BLOCK_WIDTH},${DEFAULT_NOTE_HEIGHT}]`;

/** Position a new block relative to `ref` along `direction`. The orthogonal axis
 *  inherits from `ref` unless `preserveX` / `preserveY` is supplied. */
export function stackRelativeTo(
  ref: Bound,
  newSize: { w: number; h: number },
  opts: {
    direction?: "down" | "up" | "left" | "right";
    gap?: number;
    preserveX?: number;
    preserveY?: number;
  } = {}
): { x: number; y: number } {
  const direction = opts.direction ?? "down";
  const isHorizontal = direction === "left" || direction === "right";
  const gap = opts.gap ?? (isHorizontal ? DEFAULT_STACK_GAP_HORIZONTAL : DEFAULT_STACK_GAP_VERTICAL);
  if (direction === "down") {
    return { x: opts.preserveX ?? ref.x, y: ref.y + ref.h + gap };
  }
  if (direction === "up") {
    return { x: opts.preserveX ?? ref.x, y: ref.y - gap - newSize.h };
  }
  if (direction === "right") {
    return { x: ref.x + ref.w + gap, y: opts.preserveY ?? ref.y };
  }
  return { x: ref.x - gap - newSize.w, y: opts.preserveY ?? ref.y };
}

/** Over-estimate note height from markdown. BlockSuite's `EdgelessNoteMask`
 *  `ResizeObserver` corrects `prop:xywh.h` to the DOM-measured height on first render. */
export function estimateNoteHeightForMarkdown(
  markdown: string,
  widthPx: number
): number {
  const NOTE_V_PADDING = 64;
  const BODY_LINE_H = 34;
  const CHAR_WIDTH = 8;
  const H_PADDING = 52;
  const H1_LINE_H = 58;
  const H2_LINE_H = 48;
  const H3_LINE_H = 40;
  const CODE_LINE_H = 32;
  const CODE_FENCE_PAD = 30;
  const CODE_BLOCK_EXTRA = 20;
  const BLANK_LINE_H = 14;

  const usableWidth = Math.max(80, widthPx - H_PADDING);
  const charsPerLine = Math.max(16, Math.floor(usableWidth / CHAR_WIDTH));

  let total = NOTE_V_PADDING;
  let inCode = false;
  const lines = markdown.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inCode = !inCode;
      total += CODE_FENCE_PAD;
      if (inCode) total += CODE_BLOCK_EXTRA;
      continue;
    }
    if (inCode) {
      total += CODE_LINE_H;
      continue;
    }
    if (line === "") {
      total += BLANK_LINE_H;
      continue;
    }
    let lineHeight = BODY_LINE_H;
    let prefixChars = 0;
    if (/^#\s/.test(line)) {
      lineHeight = H1_LINE_H;
      prefixChars = 2;
    } else if (/^##\s/.test(line)) {
      lineHeight = H2_LINE_H;
      prefixChars = 3;
    } else if (/^###\s/.test(line)) {
      lineHeight = H3_LINE_H;
      prefixChars = 4;
    } else if (/^[-*]\s/.test(line)) {
      prefixChars = 2;
    } else if (/^\d+\.\s/.test(line)) {
      prefixChars = 3;
    }
    const contentChars = Math.max(1, line.length - prefixChars);
    const wraps = Math.max(1, Math.ceil(contentChars / charsPerLine));
    total += lineHeight * wraps;
  }
  return Math.max(120, Math.ceil(total));
}

/** Initial `labelXYWH` at source→target midpoint so BlockSuite's `hasLabel()` gate passes on first render. */
export function estimateConnectorLabelXYWH(
  labelText: string,
  fontSize: number,
  midpoint: { x: number; y: number } | null,
  maxWidth: number
): [number, number, number, number] {
  const charWidth = fontSize * 0.55;
  const estimatedW = Math.max(16, Math.ceil(labelText.length * charWidth));
  const w = Math.min(estimatedW, maxWidth);
  const h = Math.ceil(fontSize + 4);
  if (!midpoint) return [0, 0, Math.max(w, 16), Math.max(h, 16)];
  return [Math.round(midpoint.x - w / 2), Math.round(midpoint.y - h / 2), w, h];
}

/** Sort by fractional `index` string ascending. Y.Map iteration order is not stable across reloads. */
export function sortByFractionalIndex<T extends { index?: unknown }>(
  entries: T[]
): T[] {
  return entries.slice().sort((a, b) => {
    const ai = typeof a.index === "string" ? a.index : "";
    const bi = typeof b.index === "string" ? b.index : "";
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  });
}
