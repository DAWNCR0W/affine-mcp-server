#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  testResourceName,
  testTempPath,
} from "./require-destructive-test-safety.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(PROJECT_DIR, "dist", "index.js");
const PROXY_PATH = path.join(PROJECT_DIR, "bin", "affine-mcp-http-proxy");
const BACKEND_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || "90000");

if (!PASSWORD) {
  throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
}

function payloadOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find(entry => entry?.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeResult(result) {
  return JSON.stringify(payloadOf(result) ?? result);
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(child, url, logs, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited before health check: ${JSON.stringify(logs())}`);
    }
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Retry until the isolated listener is ready.
    } finally {
      clearTimeout(requestTimer);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(logs())}`);
}

async function startHttpServer(token) {
  const port = await findFreePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(port),
      AFFINE_BASE_URL: BACKEND_URL,
      AFFINE_API_TOKEN: "",
      AFFINE_COOKIE: "",
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      AFFINE_TOOL_PROFILE: "full",
      AFFINE_DISABLED_GROUPS: "",
      AFFINE_DISABLED_TOOLS: "",
      AFFINE_HEADERS_JSON: "",
      AFFINE_MCP_AUTH_MODE: "bearer",
      AFFINE_MCP_HTTP_HOST: "127.0.0.1",
      AFFINE_MCP_HTTP_TOKEN: token,
      XDG_CONFIG_HOME: testTempPath("concurrent-writes-http-server"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const logs = () => ({ stdout, stderr });
  try {
    await waitForHealth(child, `${publicBaseUrl}/healthz`, logs);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
  return {
    child,
    mcpUrl: `${publicBaseUrl}/mcp`,
    logs,
  };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (exited || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function connectDirect(mcpUrl, name) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${HTTP_TOKEN}` } },
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  return { client, transport, name };
}

async function connectProxy(mcpUrl, name) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PROXY_PATH],
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      AFFINE_MCP_HTTP_TOKEN: HTTP_TOKEN,
      AFFINE_MCP_HTTP_PROXY_URL: mcpUrl,
      AFFINE_MCP_HTTP_PROXY_TIMEOUT_MS: String(TOOL_TIMEOUT_MS),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  return { client, transport, name };
}

async function rawCall(connection, toolName, args = {}) {
  const result = await connection.client.callTool(
    { name: toolName, arguments: args },
    undefined,
    { timeout: TOOL_TIMEOUT_MS },
  );
  return { result, payload: payloadOf(result) };
}

async function call(connection, toolName, args = {}) {
  const outcome = await rawCall(connection, toolName, args);
  if (outcome.result?.isError || outcome.payload?.ok === false) {
    throw new Error(`${connection.name}.${toolName} failed: ${describeResult(outcome.result)}`);
  }
  return outcome.payload;
}

function assertStaleConflict(outcome, expectedRevision, workspaceId, docId, message) {
  assert.equal(outcome.result?.isError, true, `${message}: MCP isError`);
  const payload = outcome.payload;
  assert.equal(payload?.ok, false, `${message}: ok`);
  assert.equal(payload?.code, "STALE_DOCUMENT_REVISION", `${message}: code`);
  assert.equal(payload?.retryable, false, `${message}: retryable`);
  assert.deepEqual(payload?.details, {
    workspaceId,
    docId,
    expectedRevision,
    currentRevision: payload?.details?.currentRevision,
  }, `${message}: details shape`);
  assert.ok(
    payload?.details?.currentRevision === null
      || /^[a-f0-9]{64}$/.test(payload?.details?.currentRevision || ""),
    `${message}: current revision`,
  );
  return payload;
}

function createBarrier(count, timeoutMs = 15_000) {
  let arrived = 0;
  let release;
  let reject;
  const gate = new Promise((resolve, rejectGate) => {
    release = resolve;
    reject = rejectGate;
  });
  const timer = setTimeout(() => reject(new Error(`parallel barrier timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  return async () => {
    arrived += 1;
    if (arrived === count) {
      clearTimeout(timer);
      release();
    }
    await gate;
  };
}

async function runParallel(label, operations) {
  const wait = createBarrier(operations.length);
  const settled = await Promise.allSettled(operations.map(async operation => {
    await wait();
    return operation();
  }));
  const failure = settled.find(entry => entry.status === "rejected");
  if (failure) {
    const detail = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
    throw new Error(`${label} failed: ${detail}`);
  }
  return settled.map(entry => entry.value);
}

function pageBlock(doc) {
  const page = doc?.blocks?.find(block => block?.flavour === "affine:page");
  assert.ok(page?.id, "read_doc must expose an affine:page root");
  return page;
}

function stableDoc(doc) {
  return {
    title: doc.title,
    tags: doc.tags,
    blockCount: doc.blockCount,
    blocks: doc.blocks,
    plainText: doc.plainText,
  };
}

function assertMindmapTree(result, expectedNodeIds, rootId, expectedRootChildren = expectedNodeIds) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  assert.equal(result.nodeCount, nodes.length, "mindmap nodeCount matches returned nodes");
  assert.equal(new Set(nodes.map(node => node.nodeId)).size, nodes.length, "mindmap node IDs are unique");
  assert.ok(byId.has(rootId), "mindmap root is present");
  for (const nodeId of expectedNodeIds) {
    assert.ok(byId.has(nodeId), `mindmap child ${nodeId} is present`);
  }
  const root = byId.get(rootId);
  for (const nodeId of expectedRootChildren) {
    assert.equal(byId.get(nodeId).parentId, rootId, `mindmap child ${nodeId} has the root parent`);
  }
  assert.deepEqual(new Set(root.children), new Set(expectedRootChildren), "mindmap root children are complete");
  for (const node of nodes) {
    for (const childId of node.children || []) {
      assert.equal(byId.get(childId)?.parentId, node.nodeId, `mindmap child linkage for ${childId}`);
    }
  }
  const visited = new Set();
  const visit = nodeId => {
    assert.equal(visited.has(nodeId), false, `mindmap graph has no cycle at ${nodeId}`);
    visited.add(nodeId);
    for (const childId of byId.get(nodeId).children || []) visit(childId);
  };
  visit(rootId);
  assert.equal(visited.size, nodes.length, "mindmap tree reaches every node exactly once");
}

const HTTP_TOKEN = `concurrent-writes-${randomBytes(24).toString("hex")}`;

async function main() {
  console.log("=== Concurrent HTTP MCP write integration test ===");
  console.log(`AFFiNE backend: ${BACKEND_URL}`);

  let server;
  let workspaceId;
  let secondaryWorkspaceId;
  const connections = [];
  try {
    server = await startHttpServer(HTTP_TOKEN);
    const connectionAttempts = [
      () => connectDirect(server.mcpUrl, "concurrent-direct-1"),
      () => connectDirect(server.mcpUrl, "concurrent-direct-2"),
      () => connectProxy(server.mcpUrl, "concurrent-proxy-1"),
      () => connectProxy(server.mcpUrl, "concurrent-proxy-2"),
    ];
    const connectionResults = await Promise.allSettled(connectionAttempts.map(connect => connect()));
    for (const result of connectionResults) {
      if (result.status === "fulfilled") connections.push(result.value);
    }
    const connectionFailure = connectionResults.find(result => result.status === "rejected");
    if (connectionFailure) {
      throw connectionFailure.reason instanceof Error
        ? connectionFailure.reason
        : new Error(String(connectionFailure.reason));
    }
    assert.equal(connections.length, 4, "the fixture has two direct and two proxy clients");

    // Populate every client's output-schema cache before exercising failures.
    const [listed] = await Promise.all(connections.map(connection => connection.client.listTools()));
    const revisionTools = [
      "append_block",
      "update_block",
      "update_table_cell",
      "replace_doc_with_markdown",
      "delete_block",
      "move_block",
      "update_doc_title",
      "delete_doc",
      "create_mindmap",
      "add_mindmap_node",
      "update_mindmap_node",
      "reparent_mindmap_node",
      "set_mindmap_style",
      "set_mindmap_lock",
      "set_mindmap_layout",
    ];
    for (const name of revisionTools) {
      const tool = listed.tools?.find(entry => entry.name === name);
      assert.ok(tool, `the server advertises ${name}`);
      assert.ok(tool.inputSchema.properties.expectedRevision, `${name} advertises expectedRevision`);
      assert.equal(tool.inputSchema.required?.includes("expectedRevision") || false, false,
        `${name} keeps expectedRevision optional`);
    }

    const capabilities = await call(connections[0], "get_capabilities");
    assert.equal(capabilities?.server?.writeCoordination?.scope, "workspace");
    assert.equal(capabilities?.server?.writeCoordination?.boundary, "single MCP server process");

    const workspace = await call(connections[0], "create_workspace", {
      name: testResourceName("concurrent-writes-workspace"),
    });
    workspaceId = workspace?.workspaceId || workspace?.id;
    assert.ok(workspaceId, "create_workspace returns workspaceId");
    const createdDoc = await call(connections[0], "create_doc", {
      workspaceId,
      title: testResourceName("concurrent-writes-doc"),
      content: "Concurrent write fixture",
    });
    const docId = createdDoc?.docId;
    assert.ok(docId, "create_doc returns docId");

    const initial = await call(connections[1], "read_doc", { workspaceId, docId });
    assert.equal(initial.exists, true);
    assert.match(initial.revision, /^[a-f0-9]{64}$/, "read_doc revision is lowercase SHA256 hex");
    const repeatedInitial = await call(connections[3], "read_doc", { workspaceId, docId });
    assert.equal(repeatedInitial.revision, initial.revision, "read_doc revision is stable across repeated reads");
    const page = pageBlock(initial);

    const deletedFixture = await call(connections[1], "create_doc", {
      workspaceId,
      title: testResourceName("concurrent-writes-deleted-doc"),
      content: "Document that will be deleted before a stale write",
    });
    const deletedSnapshot = await call(connections[2], "read_doc", {
      workspaceId,
      docId: deletedFixture.docId,
    });
    const deletedBlock = deletedSnapshot.blocks.find(block => block.flavour === "affine:paragraph");
    assert.ok(deletedBlock?.id, "deleted fixture has a writable block");
    await call(connections[0], "delete_doc", {
      workspaceId,
      docId: deletedFixture.docId,
      confirmDocId: deletedFixture.docId,
    });
    const staleAfterDelete = await rawCall(connections[3], "update_block", {
      workspaceId,
      docId: deletedFixture.docId,
      blockId: deletedBlock.id,
      text: "must not resurrect a deleted document",
      expectedRevision: deletedSnapshot.revision,
    });
    const deleteConflict = assertStaleConflict(
      staleAfterDelete,
      deletedSnapshot.revision,
      workspaceId,
      deletedFixture.docId,
      "stale write after delete",
    );
    if (deleteConflict.details.currentRevision !== null) {
      assert.match(deleteConflict.details.currentRevision, /^[a-f0-9]{64}$/, "deleted documents report a current revision token");
      assert.notEqual(deleteConflict.details.currentRevision, deletedSnapshot.revision,
        "deleting the workspace registration invalidates the old revision");
    }
    const missingDocId = testResourceName("concurrent-writes-never-created-doc");
    const staleMissingDoc = await rawCall(connections[0], "update_block", {
      workspaceId,
      docId: missingDocId,
      blockId: "missing-block",
      text: "must remain missing",
      expectedRevision: "a".repeat(64),
    });
    const missingDocConflict = assertStaleConflict(
      staleMissingDoc,
      "a".repeat(64),
      workspaceId,
      missingDocId,
      "stale write against a never-created document",
    );
    assert.equal(missingDocConflict.details.currentRevision, null,
      "a never-created document has no current revision");

    const appendTexts = connections.map((_, index) => `${testResourceName("append-marker")}-${index}`);
    const appendResults = await runParallel("simultaneous appends", appendTexts.map((text, index) => () =>
      call(connections[index], "append_block", { workspaceId, docId, type: "paragraph", text }),
    ));
    const appendIds = appendResults.map(result => result?.blockId);
    assert.equal(new Set(appendIds).size, appendIds.length, "simultaneous appends return unique block IDs");
    const afterAppends = await call(connections[2], "read_doc", { workspaceId, docId });
    const appendedBlocks = afterAppends.blocks.filter(block => appendTexts.includes(block.text));
    assert.equal(appendedBlocks.length, appendTexts.length, "all simultaneous appends are readable");
    assert.deepEqual(new Set(appendedBlocks.map(block => block.id)), new Set(appendIds),
      "read_doc IDs match append receipts");
    const appendParentIds = new Set(appendedBlocks.map(block => block.parentId));
    assert.equal(appendParentIds.size, 1, "simultaneous appends share one serialized parent");
    const appendParent = afterAppends.blocks.find(block => block.id === appendedBlocks[0].parentId);
    assert.ok(appendParent, "append parent is present in read_doc");
    const childPositions = appendIds.map(id => appendParent.childIds.indexOf(id));
    assert.ok(childPositions.every(position => position >= 0), "append receipts are linked from their parent");
    assert.equal(new Set(childPositions).size, appendIds.length, "append ordering has no duplicate child links");
    assert.equal(page.id, pageBlock(afterAppends).id, "document root linkage survives concurrent appends");

    const editedTexts = ["distinct block edit one", "distinct block edit two"];
    await runParallel("distinct block edits", editedTexts.map((text, index) => () =>
      call(connections[index], "update_block", {
        workspaceId,
        docId,
        blockId: appendIds[index],
        text,
      }),
    ));
    const table = await call(connections[0], "append_block", {
      workspaceId,
      docId,
      type: "table",
      rows: 2,
      columns: 2,
      tableData: [["cell 00", "cell 01"], ["cell 10", "cell 11"]],
    });
    assert.ok(table?.blockId, "table append returns blockId");
    await runParallel("distinct table cell edits", [
      () => call(connections[2], "update_table_cell", {
        workspaceId, docId, blockId: table.blockId, row: 0, column: 0, text: "cell 00 updated",
      }),
      () => call(connections[3], "update_table_cell", {
        workspaceId, docId, blockId: table.blockId, row: 1, column: 1, text: "cell 11 updated",
      }),
    ]);
    const afterDistinctEdits = await call(connections[1], "read_doc", { workspaceId, docId });
    assert.equal(afterDistinctEdits.blocks.find(block => block.id === appendIds[0]).text, editedTexts[0]);
    assert.equal(afterDistinctEdits.blocks.find(block => block.id === appendIds[1]).text, editedTexts[1]);
    const tableAfterEdits = afterDistinctEdits.blocks.find(block => block.id === table.blockId);
    assert.deepEqual(tableAfterEdits.tableData, [["cell 00 updated", "cell 01"], ["cell 10", "cell 11 updated"]]);

    const tableCasBase = await call(connections[0], "read_doc", { workspaceId, docId });
    const tableCasTexts = ["same cell CAS candidate A", "same cell CAS candidate B"];
    const tableCasOutcomes = await runParallel("same-cell compare-and-swap writes", [
      () => rawCall(connections[1], "update_table_cell", {
        workspaceId,
        docId,
        blockId: table.blockId,
        row: 0,
        column: 0,
        text: tableCasTexts[0],
        expectedRevision: tableCasBase.revision,
      }),
      () => rawCall(connections[3], "update_table_cell", {
        workspaceId,
        docId,
        blockId: table.blockId,
        row: 0,
        column: 0,
        text: tableCasTexts[1],
        expectedRevision: tableCasBase.revision,
      }),
    ]);
    const tableCasSuccesses = tableCasOutcomes.filter(outcome => !outcome.result?.isError);
    const tableCasConflicts = tableCasOutcomes.filter(outcome => outcome.payload?.code === "STALE_DOCUMENT_REVISION");
    assert.equal(tableCasSuccesses.length, 1, "exactly one same-cell CAS write succeeds");
    assert.equal(tableCasConflicts.length, 1, "exactly one same-cell CAS write conflicts");
    const tableWinningText = tableCasSuccesses[0].payload?.cell?.text;
    assert.ok(tableCasTexts.includes(tableWinningText), "same-cell CAS success reports one candidate text");
    const tableCasReadBack = await call(connections[2], "read_doc", { workspaceId, docId });
    assert.equal(tableCasReadBack.blocks.find(block => block.id === table.blockId).tableData[0][0], tableWinningText,
      "the final table cell is exactly the successful CAS value");
    assert.equal(tableCasConflicts[0].payload.details.currentRevision, tableCasReadBack.revision,
      "same-cell conflict reports the committed current revision");

    const casBase = await call(connections[2], "read_doc", { workspaceId, docId });
    const casTexts = ["CAS winner candidate A", "CAS winner candidate B"];
    const casOutcomes = await runParallel("same-block compare-and-swap writes", [
      () => rawCall(connections[0], "update_block", {
        workspaceId, docId, blockId: appendIds[0], text: casTexts[0], expectedRevision: casBase.revision,
      }),
      () => rawCall(connections[2], "update_block", {
        workspaceId, docId, blockId: appendIds[0], text: casTexts[1], expectedRevision: casBase.revision,
      }),
    ]);
    const casSuccesses = casOutcomes.filter(outcome => !outcome.result?.isError);
    const casConflicts = casOutcomes.filter(outcome => outcome.payload?.code === "STALE_DOCUMENT_REVISION");
    assert.equal(casSuccesses.length, 1, "exactly one same-block CAS write succeeds");
    assert.equal(casConflicts.length, 1, "exactly one same-block CAS write conflicts");
    const winningText = casSuccesses[0].payload?.block?.text;
    assert.ok(casTexts.includes(winningText), "CAS success reports one candidate text");
    const casReadBack = await call(connections[3], "read_doc", { workspaceId, docId });
    assert.equal(casReadBack.blocks.find(block => block.id === appendIds[0]).text, winningText,
      "the final block text is exactly the successful CAS value");
    assert.equal(casConflicts[0].payload.details.currentRevision, casReadBack.revision,
      "the conflict reports the committed current revision");
    assert.notEqual(casReadBack.blocks.find(block => block.id === appendIds[0]).text,
      casTexts.find(text => text !== winningText), "the losing CAS text was not applied");

    const staleSnapshot = await call(connections[0], "read_doc", { workspaceId, docId });
    await call(connections[1], "update_block", {
      workspaceId, docId, blockId: appendIds[1], text: "revision advanced before stale replacement",
    });
    const beforeStaleReplace = await call(connections[2], "read_doc", { workspaceId, docId });
    const staleReplace = await rawCall(connections[3], "replace_doc_with_markdown", {
      workspaceId,
      docId,
      markdown: "# This replacement must be rejected\n\nThe stale writer must not mutate the document.",
      expectedRevision: staleSnapshot.revision,
    });
    assertStaleConflict(staleReplace, staleSnapshot.revision, workspaceId, docId, "stale replacement");
    const afterStaleReplace = await call(connections[0], "read_doc", { workspaceId, docId });
    assert.equal(afterStaleReplace.revision, beforeStaleReplace.revision, "stale replacement leaves revision unchanged");
    assert.deepEqual(stableDoc(afterStaleReplace), stableDoc(beforeStaleReplace),
      "stale replacement leaves the full document snapshot unchanged");

    const failedOperation = await rawCall(connections[3], "update_block", {
      workspaceId, docId, blockId: "missing-block-for-recovery", text: "must fail",
    });
    assert.equal(failedOperation.result?.isError, true, "an invalid mutation fails explicitly");
    await call(connections[3], "update_block", {
      workspaceId, docId, blockId: appendIds[1], text: "successful operation after failure",
    });
    const afterRecovery = await call(connections[2], "read_doc", { workspaceId, docId });
    assert.equal(afterRecovery.blocks.find(block => block.id === appendIds[1]).text,
      "successful operation after failure", "the queue remains usable after a failed operation");

    const mindmap = await call(connections[0], "create_mindmap", {
      workspaceId, docId, text: "Concurrent mindmap root", layout: "right",
    });
    assert.ok(mindmap?.mindmapId && mindmap?.rootId, "create_mindmap returns native IDs");
    const childResults = await runParallel("concurrent mindmap children", connections.map((connection, index) => () =>
      call(connection, "add_mindmap_node", {
        workspaceId,
        docId,
        mindmapId: mindmap.mindmapId,
        parentId: mindmap.rootId,
        text: `Concurrent child ${index}`,
      }),
    ));
    const childIds = childResults.map(result => result?.nodeId);
    assert.equal(new Set(childIds).size, childIds.length, "mindmap child IDs are unique");
    const mindmapRead = await call(connections[1], "get_mindmap", {
      workspaceId, docId, mindmapId: mindmap.mindmapId,
    });
    assertMindmapTree(mindmapRead, childIds, mindmap.rootId);

    const reparentBase = await call(connections[2], "read_doc", { workspaceId, docId });
    const movedNodeId = childIds[0];
    const reparentCandidates = [
      { connection: connections[0], parentId: childIds[1] },
      { connection: connections[3], parentId: childIds[2] },
    ];
    const reparentOutcomes = await runParallel("competing mindmap reparent writes", reparentCandidates.map(candidate => () =>
      rawCall(candidate.connection, "reparent_mindmap_node", {
        workspaceId,
        docId,
        mindmapId: mindmap.mindmapId,
        nodeId: movedNodeId,
        parentId: candidate.parentId,
        expectedRevision: reparentBase.revision,
      }),
    ));
    const reparentSuccesses = reparentOutcomes.filter(outcome => !outcome.result?.isError);
    const reparentConflicts = reparentOutcomes.filter(outcome => outcome.payload?.code === "STALE_DOCUMENT_REVISION");
    assert.equal(reparentSuccesses.length, 1, "exactly one competing mindmap reparent succeeds");
    assert.equal(reparentConflicts.length, 1, "exactly one competing mindmap reparent conflicts");
    const successfulReparent = reparentCandidates[reparentOutcomes.findIndex(outcome => !outcome.result?.isError)];
    const mindmapAfterReparent = await call(connections[0], "get_mindmap", {
      workspaceId, docId, mindmapId: mindmap.mindmapId,
    });
    assertMindmapTree(mindmapAfterReparent, childIds, mindmap.rootId, childIds.slice(1));
    assert.equal(
      mindmapAfterReparent.nodes.find(node => node.nodeId === movedNodeId)?.parentId,
      successfulReparent.parentId,
      "the final mindmap parent is the successful reparent target",
    );

    const supportingDoc = await call(connections[1], "create_doc", {
      workspaceId,
      title: testResourceName("concurrent-writes-supporting-doc"),
      content: "Supporting document",
    });
    const collection = await call(connections[0], "create_collection", {
      workspaceId,
      name: testResourceName("concurrent-writes-collection"),
    });
    assert.ok(collection?.id, "create_collection returns collection id");
    await runParallel("same-collection allow-list writes", [
      () => call(connections[0], "add_doc_to_collection", { workspaceId, collectionId: collection.id, docId }),
      () => call(connections[1], "add_doc_to_collection", { workspaceId, collectionId: collection.id, docId }),
      () => call(connections[2], "add_doc_to_collection", { workspaceId, collectionId: collection.id, docId: supportingDoc.docId }),
    ]);
    const collectionRead = await call(connections[3], "get_collection", {
      workspaceId, collectionId: collection.id,
    });
    assert.deepEqual(new Set(collectionRead.allowList), new Set([docId, supportingDoc.docId]),
      "same-collection concurrent writes preserve both allow-list entries");
    assert.equal(collectionRead.allowList.length, 2, "same-collection allow-list has no duplicate entries");

    const tagA = testResourceName("concurrent-tag-a");
    const tagB = testResourceName("concurrent-tag-b");
    const tagC = testResourceName("concurrent-tag-c");
    const finalTitle = testResourceName("concurrent-final-title");
    await runParallel("shared workspace metadata writes", [
      () => call(connections[0], "create_tag", { workspaceId, tag: tagA }),
      () => call(connections[1], "add_tag_to_doc", { workspaceId, docId, tag: tagB }),
      () => call(connections[2], "update_doc_title", { workspaceId, docId, title: finalTitle }),
      () => call(connections[3], "create_tag", { workspaceId, tag: tagC }),
    ]);
    const metadataRead = await call(connections[0], "read_doc", { workspaceId, docId });
    assert.equal(metadataRead.title, finalTitle, "parallel title write is visible from another connection");
    assert.ok(metadataRead.tags.includes(tagB), "parallel tag attachment is visible from another connection");
    const tagsRead = await call(connections[2], "list_tags", { workspaceId });
    const tagNames = new Set((tagsRead.tags || []).map(tag => tag?.name ?? tag?.value ?? tag?.tag));
    for (const tag of [tagA, tagB, tagC]) assert.ok(tagNames.has(tag), `workspace metadata includes ${tag}`);

    const secondaryWorkspace = await call(connections[1], "create_workspace", {
      name: testResourceName("concurrent-writes-independent-workspace"),
    });
    secondaryWorkspaceId = secondaryWorkspace?.workspaceId || secondaryWorkspace?.id;
    assert.ok(secondaryWorkspaceId, "independent workspace returns workspaceId");
    const secondaryDoc = await call(connections[1], "create_doc", {
      workspaceId: secondaryWorkspaceId,
      title: testResourceName("concurrent-writes-independent-doc"),
      content: "Independent workspace fixture",
    });
    await runParallel("independent workspace writes", [
      () => call(connections[0], "append_block", {
        workspaceId, docId, type: "paragraph", text: "primary workspace concurrent marker",
      }),
      () => call(connections[2], "append_block", {
        workspaceId: secondaryWorkspaceId, docId: secondaryDoc.docId, type: "paragraph", text: "secondary workspace concurrent marker",
      }),
    ]);
    const primaryFinal = await call(connections[3], "read_doc", { workspaceId, docId });
    const secondaryFinal = await call(connections[0], "read_doc", {
      workspaceId: secondaryWorkspaceId, docId: secondaryDoc.docId,
    });
    assert.ok(primaryFinal.plainText.includes("primary workspace concurrent marker"));
    assert.ok(!primaryFinal.plainText.includes("secondary workspace concurrent marker"));
    assert.ok(secondaryFinal.plainText.includes("secondary workspace concurrent marker"));
    assert.ok(!secondaryFinal.plainText.includes("primary workspace concurrent marker"));

    console.log("=== Concurrent HTTP MCP write integration test passed ===");
  } finally {
    const cleanupConnection = connections.find(Boolean);
    if (cleanupConnection) {
      for (const id of [secondaryWorkspaceId, workspaceId]) {
        if (!id) continue;
        try {
          await call(cleanupConnection, "delete_workspace", { id, confirmWorkspaceId: id });
        } catch (error) {
          console.error(`Cleanup failed for workspace ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    await Promise.allSettled(connections.map(connection => connection.transport.close()));
    if (server) await stopProcess(server.child);
  }
}

main().catch(error => {
  console.error("FAILED:", error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
