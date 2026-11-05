#!/usr/bin/env node
/**
 * Edgeless image regression: image blocks accept x/y/width/height placement,
 * connectors bind to image ids, and every read path returns the geometry plus the
 * blob key (get_edgeless_canvas, read_doc, list_surface_elements, get_blob).
 *
 * Prerequisites: a running AFFiNE instance reachable via AFFINE_BASE_URL with
 * AFFINE_ADMIN_EMAIL / AFFINE_ADMIN_PASSWORD (see tests/run-e2e.sh).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { testResourceName, testRunId, testTempPath } from "./require-destructive-test-safety.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MCP = path.resolve(REPO_ROOT, "dist", "index.js");

const BASE = process.env.AFFINE_BASE_URL;
const EMAIL = process.env.AFFINE_ADMIN_EMAIL;
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD;
let WORKSPACE = process.env.AFFINE_TEST_WORKSPACE_ID || process.env.AFFINE_WORKSPACE_ID;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error("Set AFFINE_BASE_URL, AFFINE_ADMIN_EMAIL and AFFINE_ADMIN_PASSWORD first.");
  console.error("Typical flow (from repo root):");
  console.error("  . tests/generate-test-env.sh");
  console.error("  node tests/acquire-credentials.mjs");
  process.exit(1);
}

// 1x1 transparent PNG — small, dependency-free fixture for structural checks.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_SHA = crypto.createHash("sha256").update(Buffer.from(PNG_B64, "base64")).digest("hex");
const PNG_BYTES = Buffer.from(PNG_B64, "base64").length;

const client = new Client({ name: "affine-mcp-image-edgeless", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [MCP],
  cwd: REPO_ROOT,
  env: {
    AFFINE_BASE_URL: BASE,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: "sync",
    XDG_CONFIG_HOME: testTempPath("image-edgeless-config"),
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk}`));

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const textPart = result?.content?.find((entry) => entry.type === "text")?.text;
  if (result?.isError) throw new Error(`${name}: ${textPart ?? "unknown error"}`);
  if (typeof textPart !== "string") return null;
  try {
    return JSON.parse(textPart);
  } catch {
    return textPart;
  }
}

const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectError(name, promise, pattern) {
  try {
    await promise;
    check(name, false, "expected an error but the call succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), message.slice(0, 160));
  }
}

await client.connect(transport);

// CI has no configured workspace; create one per run like the other e2e suites.
if (!WORKSPACE) {
  const workspace = await call("create_workspace", { name: testResourceName("image-edgeless-ws") });
  WORKSPACE = workspace.id;
  check("workspace available", Boolean(WORKSPACE), WORKSPACE);
}

let docId;
try {
  const doc = await call("create_doc", { workspaceId: WORKSPACE, title: testResourceName("mcp image edgeless") });
  docId = doc.docId ?? doc.id;
  check("create scratch doc", Boolean(docId), docId);

  // Blob keys are not namespaced per upload on every server build, so keep
  // fixture names unique per run to avoid clobbering an earlier fixture.
  const files = ["node-a.png", "node-b.png", "node-c.png"].map((name) => `img-${testRunId}-${name}`);
  const uploaded = [];
  for (const filename of files) {
    const up = await call("upload_blob", {
      workspaceId: WORKSPACE,
      content: PNG_B64,
      encoding: "base64",
      filename,
      contentType: "image/png",
    });
    uploaded.push({ filename, key: up.key ?? up.id });
    check(`upload ${filename}`, Boolean(uploaded.at(-1).key), uploaded.at(-1).key);
  }

  const positions = [
    { x: 0, y: 0 },
    { x: 560, y: 0 },
    { x: 1120, y: 0 },
  ];
  const imageIds = [];
  for (let i = 0; i < uploaded.length; i += 1) {
    const created = await call("append_block", {
      workspaceId: WORKSPACE,
      docId,
      type: "image",
      sourceId: uploaded[i].key,
      name: uploaded[i].filename,
      mimeType: "image/png",
      size: Buffer.from(PNG_B64, "base64").length,
      x: positions[i].x,
      y: positions[i].y,
      width: 480,
      height: 300,
      caption: uploaded[i].filename,
    });
    imageIds.push(created.blockId ?? created.id);
    check(`append image ${i + 1}`, Boolean(imageIds.at(-1)), `${imageIds.at(-1)} @ ${positions[i].x},${positions[i].y}`);
  }

  const edges = [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
  ];
  for (const [index, edge] of edges.entries()) {
    const connector = await call("add_surface_element", {
      workspaceId: WORKSPACE,
      docId,
      type: "connector",
      sourceId: imageIds[edge.from],
      targetId: imageIds[edge.to],
      label: "next",
      rearEndpointStyle: "Arrow",
    });
    check(`connector ${index + 1}`, Boolean(connector.elementId ?? connector.id), connector.elementId ?? connector.id);
  }

  const canvas = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const images = (canvas.edgelessBlocks ?? []).filter((block) => block.flavour === "affine:image");
  check("canvas exposes image blocks", images.length === imageIds.length, `got ${images.length}`);

  for (let i = 0; i < imageIds.length; i += 1) {
    const block = images.find((entry) => entry.id === imageIds[i]);
    const ok =
      Boolean(block) &&
      block.sourceId === uploaded[i].key &&
      block.bounds?.x === positions[i].x &&
      block.bounds?.y === positions[i].y &&
      block.bounds?.width === 480 &&
      block.bounds?.height === 300;
    check(`image ${i + 1} geometry + sourceId`, ok, block ? JSON.stringify(block.bounds) : "missing");
  }

  const surface = await call("list_surface_elements", { workspaceId: WORKSPACE, docId });
  const connectors = (surface.elements ?? surface.surfaceElements ?? []).filter((entry) => entry.type === "connector");
  check("connectors readable", connectors.length === edges.length, `got ${connectors.length}`);
  for (let i = 0; i < edges.length; i += 1) {
    const connector = connectors[i];
    const ok =
      connector?.source?.id === imageIds[edges[i].from] &&
      connector?.target?.id === imageIds[edges[i].to] &&
      connector?.text === "next";
    check(`connector ${i + 1} endpoints + label`, ok, connector ? `${connector.source?.id}->${connector.target?.id}` : "missing");
  }

  const read = await call("read_doc", { workspaceId: WORKSPACE, docId });
  const readImages = (read.blocks ?? []).filter((block) => block.flavour === "affine:image");
  check(
    "read_doc exposes image sourceId",
    readImages.length === imageIds.length && readImages.every((block) => typeof block.sourceId === "string" && block.sourceId.length > 0),
    `images=${readImages.length}`,
  );

  check(
    "positioned images are children of the surface block",
    readImages.length > 0 && readImages.every((block) => block.parentId === canvas.surfaceBlockId),
    `surface=${canvas.surfaceBlockId}`,
  );

  // A position without dimensions must still produce a consistent 100x100 block.
  const positionOnly = await call("append_block", {
    workspaceId: WORKSPACE,
    docId,
    type: "image",
    sourceId: uploaded[0].key,
    name: "position-only.png",
    mimeType: "image/png",
    size: PNG_BYTES,
    x: 0,
    y: 400,
  });
  const positionOnlyId = positionOnly.blockId;

  // An image appended without geometry stays inside the page note.
  const noteImage = await call("append_block", {
    workspaceId: WORKSPACE,
    docId,
    type: "image",
    sourceId: uploaded[1].key,
    name: "note-image.png",
    mimeType: "image/png",
    size: PNG_BYTES,
  });
  const noteImageId = noteImage.blockId;

  const canvasWithExtras = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const canvasImages = (canvasWithExtras.edgelessBlocks ?? []).filter((block) => block.flavour === "affine:image");
  const positionOnlyEntry = canvasImages.find((block) => block.id === positionOnlyId);

  check(
    "note-contained image is not listed on the canvas",
    canvasImages.every((block) => block.id !== noteImageId),
    `canvasImages=${canvasImages.length}`,
  );
  check(
    "position-only image uses 100x100 bounds",
    positionOnlyEntry?.bounds?.width === 100 && positionOnlyEntry?.bounds?.height === 100,
    JSON.stringify(positionOnlyEntry?.bounds ?? null),
  );
  check(
    "position-only image stores matching dimensions",
    positionOnlyEntry?.width === 100 && positionOnlyEntry?.height === 100,
    `w=${positionOnlyEntry?.width} h=${positionOnlyEntry?.height}`,
  );

  const readWithExtras = await call("read_doc", { workspaceId: WORKSPACE, docId });
  const noteImageBlock = (readWithExtras.blocks ?? []).find((block) => block.id === noteImageId);
  check(
    "note-contained image stays readable in read_doc",
    Boolean(noteImageBlock) && typeof noteImageBlock.sourceId === "string" && noteImageBlock.sourceId.length > 0,
    noteImageBlock?.parentId ?? "missing",
  );

  await expectError(
    "rejects image width 0",
    call("update_edgeless_block", { workspaceId: WORKSPACE, docId, blockId: positionOnlyId, width: 0 }),
    /between 1 and 10000/,
  );
  await expectError(
    "rejects image height -5",
    call("update_edgeless_block", { workspaceId: WORKSPACE, docId, blockId: positionOnlyId, height: -5 }),
    /between 1 and 10000/,
  );
  await expectError(
    "rejects fractional image width",
    call("update_edgeless_block", { workspaceId: WORKSPACE, docId, blockId: positionOnlyId, width: 12.5 }),
    /between 1 and 10000/,
  );

  const canvasAfterRejects = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const untouched = (canvasAfterRejects.edgelessBlocks ?? []).find((block) => block.id === positionOnlyId);
  check(
    "failed updates leave the image untouched",
    untouched?.bounds?.width === 100 && untouched?.bounds?.height === 100,
    JSON.stringify(untouched?.bounds ?? null),
  );

  const resized = await call("update_edgeless_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: positionOnlyId,
    width: 320,
  });
  check("accepts a valid image width", resized.updated === true, JSON.stringify(resized.changed ?? null));

  const canvasResized = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const resizedEntry = (canvasResized.edgelessBlocks ?? []).find((block) => block.id === positionOnlyId);
  check(
    "resize round-trips to the canvas",
    resizedEntry?.bounds?.width === 320 && resizedEntry?.width === 320,
    JSON.stringify(resizedEntry?.bounds ?? null),
  );

  // Image blocks have no background, so an update must report it as ignored.
  const backgroundIgnored = await call("update_edgeless_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: positionOnlyId,
    background: "#ff0000",
  });
  check(
    "image updates ignore background",
    Array.isArray(backgroundIgnored.ignored) && backgroundIgnored.ignored.includes("background"),
    JSON.stringify(backgroundIgnored.ignored ?? null),
  );

  // Explicit surface placement without geometry still needs a rendered size.
  const explicitSurface = await call("append_block", {
    workspaceId: WORKSPACE,
    docId,
    type: "image",
    sourceId: uploaded[2].key,
    name: "explicit-surface.png",
    mimeType: "image/png",
    size: PNG_BYTES,
    placement: { parentId: canvas.surfaceBlockId },
  });
  const canvasExplicit = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const explicitEntry = (canvasExplicit.edgelessBlocks ?? []).find((block) => block.id === explicitSurface.blockId);
  check(
    "explicit surface image gets 100x100 bounds",
    explicitEntry?.bounds?.width === 100 && explicitEntry?.bounds?.height === 100,
    JSON.stringify(explicitEntry?.bounds ?? null),
  );
  check(
    "explicit surface image stores matching dimensions",
    explicitEntry?.width === 100 && explicitEntry?.height === 100,
    `w=${explicitEntry?.width} h=${explicitEntry?.height}`,
  );

  // An explicit note parent wins over automatic surface attachment.
  const noteId = (read.blocks ?? []).find((block) => block.flavour === "affine:note")?.id;
  check("test doc exposes a page note", Boolean(noteId), noteId ?? "missing");
  const explicitNote = await call("append_block", {
    workspaceId: WORKSPACE,
    docId,
    type: "image",
    sourceId: uploaded[0].key,
    name: "explicit-note.png",
    mimeType: "image/png",
    size: PNG_BYTES,
    x: 0,
    y: 900,
    width: 120,
    height: 80,
    caption: "note caption",
    placement: { parentId: noteId },
  });
  const canvasNote = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  check(
    "explicit note placement keeps the image off the canvas",
    (canvasNote.edgelessBlocks ?? []).every((block) => block.id !== explicitNote.blockId),
  );

  const readNote = await call("read_doc", { workspaceId: WORKSPACE, docId });
  const noteRow = (readNote.blocks ?? []).find((block) => block.id === explicitNote.blockId);
  check(
    "read_doc returns image caption and bounds",
    noteRow?.caption === "note caption" && noteRow?.bounds?.width === 120 && noteRow?.bounds?.height === 80,
    `${noteRow?.caption ?? "no-caption"} ${JSON.stringify(noteRow?.bounds ?? null)}`,
  );

  // move_block must accept an image under the surface.
  const moveResult = await call("move_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: explicitNote.blockId,
    placement: { parentId: canvas.surfaceBlockId },
  });
  check(
    "move_block moves an image onto the surface",
    moveResult.moved === true && moveResult.toParentId === canvas.surfaceBlockId,
    JSON.stringify({ moved: moveResult.moved, to: moveResult.toParentId }),
  );
  const canvasMoved = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const movedEntry = (canvasMoved.edgelessBlocks ?? []).find((block) => block.id === explicitNote.blockId);
  check(
    "moved image is listed on the canvas with its geometry",
    movedEntry?.bounds?.width === 120 && movedEntry?.bounds?.height === 80,
    JSON.stringify(movedEntry?.bounds ?? null),
  );

  // Half-zero geometry keeps the nonzero dimension and defaults only the other.
  const partialNote = await call("append_block", {
    workspaceId: WORKSPACE,
    docId,
    type: "image",
    sourceId: uploaded[1].key,
    name: "partial.png",
    mimeType: "image/png",
    size: PNG_BYTES,
    placement: { parentId: noteId },
  });
  await call("update_edgeless_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: partialNote.blockId,
    width: 200,
  });
  await call("move_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: partialNote.blockId,
    placement: { parentId: canvas.surfaceBlockId },
  });
  const canvasPartial = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const partialEntry = (canvasPartial.edgelessBlocks ?? []).find((block) => block.id === partialNote.blockId);
  check(
    "half-zero geometry keeps the nonzero dimension",
    partialEntry?.bounds?.width === 200 &&
      partialEntry?.bounds?.height === 100 &&
      partialEntry?.width === 200 &&
      partialEntry?.height === 100,
    JSON.stringify(partialEntry?.bounds ?? null),
  );

  // An x-only update must not overwrite the stored size with the zero xywh.
  const xOnlyNote = await call("append_block", {
    workspaceId: WORKSPACE,
    docId,
    type: "image",
    sourceId: uploaded[2].key,
    name: "x-only.png",
    mimeType: "image/png",
    size: PNG_BYTES,
    placement: { parentId: noteId },
  });
  await call("update_edgeless_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: xOnlyNote.blockId,
    width: 200,
  });
  await call("update_edgeless_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: xOnlyNote.blockId,
    x: 10,
  });
  const readXOnly = await call("read_doc", { workspaceId: WORKSPACE, docId });
  const xOnlyRow = (readXOnly.blocks ?? []).find((block) => block.id === xOnlyNote.blockId);
  check(
    "x-only update keeps the stored width",
    xOnlyRow?.bounds?.x === 10 && xOnlyRow?.bounds?.width === 200,
    JSON.stringify(xOnlyRow?.bounds ?? null),
  );

  await call("move_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: xOnlyNote.blockId,
    placement: { parentId: canvas.surfaceBlockId },
  });
  const canvasXOnly = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const xOnlyEntry = (canvasXOnly.edgelessBlocks ?? []).find((block) => block.id === xOnlyNote.blockId);
  check(
    "x-only image keeps its size after moving to the surface",
    xOnlyEntry?.bounds?.width === 200 && xOnlyEntry?.bounds?.height === 100,
    JSON.stringify(xOnlyEntry?.bounds ?? null),
  );

  // A surface image keeps xywh precedence when only its position changes.
  await call("update_edgeless_block", {
    workspaceId: WORKSPACE,
    docId,
    blockId: imageIds[0],
    x: 40,
  });
  const canvasSurfaceX = await call("get_edgeless_canvas", { workspaceId: WORKSPACE, docId });
  const surfaceXEntry = (canvasSurfaceX.edgelessBlocks ?? []).find((block) => block.id === imageIds[0]);
  check(
    "surface image keeps its xywh size on x-only update",
    surfaceXEntry?.bounds?.x === 40 &&
      surfaceXEntry?.bounds?.width === 480 &&
      surfaceXEntry?.bounds?.height === 300,
    JSON.stringify(surfaceXEntry?.bounds ?? null),
  );

  for (const [index, item] of uploaded.entries()) {
    const blob = await call("get_blob", { workspaceId: WORKSPACE, key: item.key });
    check(`get_blob ${index + 1} matches uploaded bytes`, blob.sha256 === PNG_SHA, `${blob.contentType} ${blob.size}B`);
  }
} finally {
  if (docId) {
    try {
      await call("trash_doc", { workspaceId: WORKSPACE, docId });
    } catch {
      /* cleanup is best-effort */
    }
  }
  await client.close();
}

console.log(`\n${failures.length === 0 ? "All checks passed." : `${failures.length} check(s) failed.`}`);
process.exit(failures.length === 0 ? 0 : 1);
