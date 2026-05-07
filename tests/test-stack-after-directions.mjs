#!/usr/bin/env node
/** End-to-end test for `stackAfter` in all four directions: asserts the stack axis
 *  advances correctly with gap ≥ caller-provided, and the orthogonal axis stays
 *  centered on the anchor's center. */
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
  process.exit(1);
}

const client = new Client({ name: "affine-mcp-stack-after-directions", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [MCP],
  cwd: REPO_ROOT,
  env: {
    AFFINE_BASE_URL: BASE,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: "sync",
    XDG_CONFIG_HOME: "/tmp/affine-mcp-stack-after-directions",
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

const GAP = 40;
const ROOT = { x: 2000, y: 2000, w: 400, h: 200 };

await client.connect(transport);
try {
  const ws = await call("create_workspace", { name: `affine-stack-directions-${Date.now()}` });
  const { docId } = await call("create_doc", { workspaceId: ws.id, title: "stackAfter directions" });
  const W = ws.id, D = docId;

  // Root note at a clear origin well away from (0,0) so up/left chains have
  // room without colliding with the seeded default note.
  const root = await call("append_block", {
    workspaceId: W, docId: D, type: "note",
    x: ROOT.x, y: ROOT.y, width: ROOT.w, height: ROOT.h,
    markdown: "# root",
  });

  /** @param {"down"|"up"|"left"|"right"} direction */
  async function chain(direction) {
    const notes = [];
    let anchor = root.blockId;
    for (let i = 1; i <= 3; i++) {
      const n = await call("append_block", {
        workspaceId: W, docId: D, type: "note",
        width: ROOT.w, height: ROOT.h,
        stackAfter: { blockId: anchor, direction, gap: GAP },
        markdown: `# ${direction[0]}${i}`,
      });
      notes.push(n);
      anchor = n.blockId;
    }
    return notes;
  }

  const down  = await chain("down");
  const up    = await chain("up");
  const right = await chain("right");
  const left  = await chain("left");

  const canvas = await call("get_edgeless_canvas", { workspaceId: W, docId: D });
  const byId = id => canvas.edgelessBlocks.find(b => b.id === id);

  const rb = byId(root.blockId).bounds;
  // Every chain should share the orthogonal axis with root (centers match
  // because widths/heights are identical — centering == inherit).
  const rootCenterX = rb.x + rb.width / 2;
  const rootCenterY = rb.y + rb.height / 2;

  // Verify each chain: advances in the expected direction, no overlap,
  // orthogonal axis stays centered on root.
  function verifyChain(label, direction, chainNotes) {
    let prev = rb;
    chainNotes.forEach((n, i) => {
      const b = byId(n.blockId).bounds;
      const bCenterX = b.x + b.width / 2;
      const bCenterY = b.y + b.height / 2;

      switch (direction) {
        case "down":
          expect(b.y >= prev.y + prev.height + GAP - 1,
            `${label}[${i}]: y=${b.y} must be >= prev bottom + gap (${prev.y + prev.height + GAP})`);
          expect(Math.abs(bCenterX - rootCenterX) < 1,
            `${label}[${i}]: orthogonal X center drifted from root (got ${bCenterX}, root ${rootCenterX})`);
          break;
        case "up":
          expect(b.y + b.height + GAP - 1 <= prev.y,
            `${label}[${i}]: y+height=${b.y + b.height} must be <= prev.y - gap (${prev.y - GAP})`);
          expect(Math.abs(bCenterX - rootCenterX) < 1,
            `${label}[${i}]: orthogonal X center drifted from root (got ${bCenterX}, root ${rootCenterX})`);
          break;
        case "right":
          expect(b.x >= prev.x + prev.width + GAP - 1,
            `${label}[${i}]: x=${b.x} must be >= prev right + gap (${prev.x + prev.width + GAP})`);
          expect(Math.abs(bCenterY - rootCenterY) < 1,
            `${label}[${i}]: orthogonal Y center drifted from root (got ${bCenterY}, root ${rootCenterY})`);
          break;
        case "left":
          expect(b.x + b.width + GAP - 1 <= prev.x,
            `${label}[${i}]: x+width=${b.x + b.width} must be <= prev.x - gap (${prev.x - GAP})`);
          expect(Math.abs(bCenterY - rootCenterY) < 1,
            `${label}[${i}]: orthogonal Y center drifted from root (got ${bCenterY}, root ${rootCenterY})`);
          break;
      }
      prev = b;
    });
  }

  verifyChain("down",  "down",  down);
  verifyChain("up",    "up",    up);
  verifyChain("right", "right", right);
  verifyChain("left",  "left",  left);

  console.log(`[stack-after-directions] All four directions stacked and centered.`);
  console.log(`[stack-after-directions] Doc URL: ${BASE}/workspace/${W}/${D}`);
} finally {
  await client.close();
}
