#!/usr/bin/env node
/**
 * Focused integration test for placement-first document creation.
 *
 * Covers:
 * - create_doc with and without parentDocId
 * - visibility in list_docs, list_children, list_workspace_tree, get_orphan_docs
 * - guardrails when a parentDocId does not exist
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
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

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`${message}: expected array, got ${JSON.stringify(value)}`);
  }
}

function expectIncludes(haystack, needle, message) {
  if (!Array.isArray(haystack) || !haystack.includes(needle)) {
    throw new Error(`${message}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  }
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function findTreeNode(nodes, docId) {
  if (!Array.isArray(nodes)) {
    return null;
  }
  for (const node of nodes) {
    if (node?.docId === docId) {
      return node;
    }
    const nested = findTreeNode(node?.children, docId);
    if (nested) {
      return nested;
    }
  }
  return null;
}

async function main() {
  console.log("=== Create With Placement Integration Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const client = new Client({ name: "affine-mcp-create-placement", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-e2e-create-placement-noconfig",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    if (result?.isError) {
      throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
    }
    const parsed = parseContent(result);
    if (parsed && typeof parsed === "object" && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === "string" && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }
    console.log("    ✓ OK");
    return parsed;
  }

  async function waitFor(label, fetchResult, predicate, attempts = 20, delayMs = 500) {
    let lastResult = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      lastResult = await fetchResult();
      if (predicate(lastResult)) {
        return lastResult;
      }
      if (attempt < attempts) {
        await delay(delayMs);
      }
    }
    throw new Error(`${label}: timed out waiting for expected state. Last result: ${JSON.stringify(lastResult)}`);
  }

  await client.connect(transport);

  try {
    const timestamp = Date.now();
    const workspace = await call("create_workspace", { name: `create-placement-${timestamp}` });
    expectTruthy(workspace?.id, "create_workspace id");
    expectTruthy(workspace?.firstDocId, "create_workspace firstDocId");

    await call("update_doc_title", {
      workspaceId: workspace.id,
      docId: workspace.firstDocId,
      title: "Workspace Home",
    });

    const orphanTitle = "Placement Orphan";
    const parentTitle = "Placement Parent";
    const childTitle = "Placement Child";
    const bogusParentId = `missing-parent-${timestamp}`;

    const orphanDoc = await call("create_doc", {
      workspaceId: workspace.id,
      title: orphanTitle,
      content: "orphan body",
      parentDocId: bogusParentId,
    });
    expectTruthy(orphanDoc?.docId, "create_doc orphan docId");
    expectEqual(orphanDoc?.parentDocId, bogusParentId, "create_doc orphan parentDocId echo");
    expectEqual(orphanDoc?.linkedToParent, false, "create_doc orphan linkedToParent");
    expectArray(orphanDoc?.warnings, "create_doc orphan warnings");
    expectIncludes(orphanDoc.warnings, `create_doc: parent doc "${bogusParentId}" was not found in workspace "${workspace.id}". Doc was left at the workspace root.`, "create_doc orphan warning");

    const bogusParentRead = await call("read_doc", {
      workspaceId: workspace.id,
      docId: bogusParentId,
    });
    expectEqual(bogusParentRead?.exists, false, "read_doc on missing parent should stay absent");

    const parentDoc = await call("create_doc", {
      workspaceId: workspace.id,
      title: parentTitle,
      content: "parent body",
    });
    expectTruthy(parentDoc?.docId, "create_doc parent docId");
    expectEqual(parentDoc?.parentDocId, null, "create_doc parent parentDocId");
    expectEqual(parentDoc?.linkedToParent, false, "create_doc parent linkedToParent");

    const childDoc = await call("create_doc", {
      workspaceId: workspace.id,
      title: childTitle,
      content: "child body",
      parentDocId: parentDoc.docId,
    });
    expectTruthy(childDoc?.docId, "create_doc child docId");
    expectEqual(childDoc?.parentDocId, parentDoc.docId, "create_doc child parentDocId");
    expectEqual(childDoc?.linkedToParent, true, "create_doc child linkedToParent");
    expectArray(childDoc?.warnings, "create_doc child warnings");
    expectEqual(childDoc.warnings.length, 0, "create_doc child warning count");

    const listedDocs = await waitFor(
      "list_docs child visibility",
      () => call("list_docs", { workspaceId: workspace.id, first: 50 }),
      result => {
        const titles = (result?.edges || []).map(edge => edge?.node?.title).filter(Boolean);
        return titles.includes(parentTitle) && titles.includes(childTitle) && titles.includes(orphanTitle);
      },
    );
    const listedTitles = listedDocs?.edges?.map(edge => edge?.node?.title) || [];
    expectIncludes(listedTitles, parentTitle, "list_docs parent title");
    expectIncludes(listedTitles, childTitle, "list_docs child title");
    expectIncludes(listedTitles, orphanTitle, "list_docs orphan title");

    const children = await waitFor(
      "list_children child visibility",
      () => call("list_children", { workspaceId: workspace.id, docId: parentDoc.docId }),
      result => Array.isArray(result?.children) && result.children.some(entry => entry?.docId === childDoc.docId),
    );
    expectEqual(children?.docId, parentDoc.docId, "list_children parent docId");
    expectEqual(children?.count, 1, "list_children count");
    expectTruthy(children?.children?.[0]?.title, "list_children child title");
    expectEqual(children?.children?.[0]?.docId, childDoc.docId, "list_children child docId");

    const tree = await waitFor(
      "list_workspace_tree child visibility",
      () => call("list_workspace_tree", { workspaceId: workspace.id, depth: 3 }),
      result => {
        const parentNode = findTreeNode(result?.tree, parentDoc.docId);
        return Boolean(parentNode && Array.isArray(parentNode.children) && parentNode.children.some(entry => entry?.docId === childDoc.docId));
      },
    );
    const parentNode = findTreeNode(tree?.tree, parentDoc.docId);
    expectTruthy(parentNode, "list_workspace_tree parent node");
    expectEqual(parentNode?.title, parentTitle, "list_workspace_tree parent title");
    expectTruthy(Array.isArray(parentNode?.children), "list_workspace_tree parent children");
    expectEqual(parentNode.children[0]?.docId, childDoc.docId, "list_workspace_tree child docId");

    const orphanDocs = await waitFor(
      "get_orphan_docs child exclusion",
      () => call("get_orphan_docs", { workspaceId: workspace.id }),
      result => Array.isArray(result?.orphans)
        && result.orphans.some(entry => entry?.docId === orphanDoc.docId)
        && result.orphans.some(entry => entry?.docId === parentDoc.docId)
        && !result.orphans.some(entry => entry?.docId === childDoc.docId),
    );
    expectEqual(orphanDocs?.count, 3, "get_orphan_docs count");
    const orphanIds = orphanDocs?.orphans?.map(entry => entry?.docId) || [];
    expectIncludes(orphanIds, workspace.firstDocId, "get_orphan_docs workspace home");
    expectIncludes(orphanIds, parentDoc.docId, "get_orphan_docs parent doc");
    expectIncludes(orphanIds, orphanDoc.docId, "get_orphan_docs orphan doc");
    if (orphanIds.includes(childDoc.docId)) {
      throw new Error("get_orphan_docs still included the placed child doc");
    }

    console.log();
    console.log("=== Create with placement integration test passed ===");
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
