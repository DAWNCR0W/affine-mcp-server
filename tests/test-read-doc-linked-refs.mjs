#!/usr/bin/env node
/**
 * Focused integration test for read_doc inline LinkedPage references.
 *
 * Covers:
 * - WebSocket-loaded block text can contain inline LinkedPage reference deltas
 * - read_doc preserves those reference page ids in each block row
 * - plain blocks expose an empty linkedDocIds array for backward-safe scanning
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Y from "yjs";

import { acquireCredentials } from "./acquire-credentials.mjs";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate } from "../dist/ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required - run: . tests/generate-test-env.sh");
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || "60000");

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function makeLinkedPageText(...pageIds) {
  const text = new Y.Text();
  let offset = 0;
  const segments = [
    { insert: "Before " },
    { insert: "\u200B", attributes: { reference: { type: "LinkedPage", pageId: pageIds[0] } } },
    { insert: " between " },
    ...(pageIds[1]
      ? [
          { insert: "\u200B", attributes: { reference: { type: "LinkedPage", pageId: pageIds[1] } } },
          { insert: " after" },
        ]
      : []),
  ];
  for (const segment of segments) {
    text.insert(offset, segment.insert, segment.attributes ?? {});
    offset += segment.insert.length;
  }
  return text;
}

async function seedLinkedPageRefs({ workspaceId, blockRefs }) {
  const { cookie } = await acquireCredentials(BASE_URL, EMAIL, PASSWORD);
  const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${BASE_URL}/graphql`), cookie, undefined);
  try {
    await joinWorkspace(socket, workspaceId);
    for (const { docId, blockId, pageIds } of blockRefs) {
      const snapshot = await loadDoc(socket, workspaceId, docId);
      if (!snapshot.missing) {
        throw new Error(`Document ${docId} was not found while seeding LinkedPage refs`);
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks");
      const block = blocks.get(blockId);
      if (!(block instanceof Y.Map)) {
        throw new Error(`Block ${blockId} was not found while seeding LinkedPage refs`);
      }

      block.set("prop:text", makeLinkedPageText(...pageIds));
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, docId, Buffer.from(delta).toString("base64"));
    }
  } finally {
    socket.disconnect();
  }
}

async function main() {
  console.log("=== read_doc LinkedPage Reference Integration Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const client = new Client({ name: "affine-mcp-read-doc-linked-refs", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-e2e-read-doc-linked-refs-noconfig",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  -> ${toolName}(${JSON.stringify(args).slice(0, 240)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const parsed = parseContent(result);
    if (result?.isError) {
      throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
    }
    if (parsed && typeof parsed === "object" && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === "string" && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }
    console.log("     OK");
    return parsed;
  }

  async function readUntil(workspaceId, docId, predicate, description, attempts = 20, delayMs = 800) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await call("read_doc", { workspaceId, docId });
      if (predicate(last)) {
        return last;
      }
      if (attempt < attempts) await delay(delayMs);
    }
    throw new Error(`${description}: timed out. Last read_doc result: ${JSON.stringify(last)}`);
  }

  let workspaceId;
  let hostDocId;
  let firstTargetDocId;
  let secondTargetDocId;

  try {
    await client.connect(transport);

    const timestamp = Date.now();
    const workspace = await call("create_workspace", { name: `linked-ref-read-doc-${timestamp}` });
    workspaceId = workspace?.id;
    expectTruthy(workspaceId, "workspace id");

    const hostDoc = await call("create_doc", {
      workspaceId,
      title: "Linked Reference Host",
      content: "host body",
    });
    hostDocId = hostDoc?.docId;
    expectTruthy(hostDocId, "host doc id");

    const firstTarget = await call("create_doc", {
      workspaceId,
      title: "Linked Target One",
      content: "target one body",
    });
    firstTargetDocId = firstTarget?.docId;
    expectTruthy(firstTargetDocId, "first target doc id");

    const secondTarget = await call("create_doc", {
      workspaceId,
      title: "Linked Target Two",
      content: "target two body",
    });
    secondTargetDocId = secondTarget?.docId;
    expectTruthy(secondTargetDocId, "second target doc id");

    const linkedParagraph = await call("append_block", {
      workspaceId,
      docId: hostDocId,
      type: "paragraph",
      text: "placeholder paragraph",
    });
    expectTruthy(linkedParagraph?.blockId, "linked paragraph block id");

    const linkedList = await call("append_block", {
      workspaceId,
      docId: hostDocId,
      type: "list",
      text: "placeholder list",
      style: "bulleted",
    });
    expectTruthy(linkedList?.blockId, "linked list block id");

    const plainParagraph = await call("append_block", {
      workspaceId,
      docId: hostDocId,
      type: "paragraph",
      text: "Plain paragraph",
    });
    expectTruthy(plainParagraph?.blockId, "plain paragraph block id");

    await seedLinkedPageRefs({
      workspaceId,
      blockRefs: [
        {
          docId: hostDocId,
          blockId: linkedParagraph.blockId,
          pageIds: [firstTargetDocId, secondTargetDocId],
        },
        {
          docId: hostDocId,
          blockId: linkedList.blockId,
          pageIds: [secondTargetDocId],
        },
      ],
    });

    const read = await readUntil(
      workspaceId,
      hostDocId,
      result => {
        const linkedBlock = result?.blocks?.find(block => block.id === linkedParagraph.blockId);
        const listBlock = result?.blocks?.find(block => block.id === linkedList.blockId);
        return Array.isArray(linkedBlock?.linkedDocIds) &&
          linkedBlock.linkedDocIds.length === 2 &&
          Array.isArray(listBlock?.linkedDocIds) &&
          listBlock.linkedDocIds.length === 1;
      },
      "read_doc linked references",
    );

    const linkedBlock = read.blocks.find(block => block.id === linkedParagraph.blockId);
    expectDeepEqual(
      linkedBlock.linkedDocIds,
      [firstTargetDocId, secondTargetDocId],
      "read_doc should return LinkedPage ids in delta order",
    );

    const listBlock = read.blocks.find(block => block.id === linkedList.blockId);
    expectDeepEqual(
      listBlock.linkedDocIds,
      [secondTargetDocId],
      "read_doc should return LinkedPage ids for list blocks",
    );

    const plainBlock = read.blocks.find(block => block.id === plainParagraph.blockId);
    expectTruthy(plainBlock, "plain paragraph block");
    expectDeepEqual(plainBlock.linkedDocIds, [], "plain paragraph linkedDocIds");

    console.log();
    console.log("=== read_doc LinkedPage reference integration test passed ===");
  } finally {
    try {
      if (hostDocId) await call("delete_doc", { workspaceId, docId: hostDocId }).catch(() => {});
      if (firstTargetDocId) await call("delete_doc", { workspaceId, docId: firstTargetDocId }).catch(() => {});
      if (secondTargetDocId) await call("delete_doc", { workspaceId, docId: secondTargetDocId }).catch(() => {});
    } finally {
      await client.close();
    }
  }
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
