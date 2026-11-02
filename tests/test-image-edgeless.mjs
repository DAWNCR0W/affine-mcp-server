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
const WORKSPACE = process.env.AFFINE_TEST_WORKSPACE_ID || process.env.AFFINE_WORKSPACE_ID;

if (!BASE || !EMAIL || !PASSWORD || !WORKSPACE) {
  console.error("Set AFFINE_BASE_URL, AFFINE_ADMIN_EMAIL, AFFINE_ADMIN_PASSWORD and AFFINE_WORKSPACE_ID first.");
  console.error("Typical flow (from repo root):");
  console.error("  . tests/generate-test-env.sh");
  console.error("  node tests/acquire-credentials.mjs");
  process.exit(1);
}

// 1x1 transparent PNG — small, dependency-free fixture for structural checks.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_SHA = crypto.createHash("sha256").update(Buffer.from(PNG_B64, "base64")).digest("hex");

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

await client.connect(transport);

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
