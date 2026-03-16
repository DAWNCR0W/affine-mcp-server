#!/usr/bin/env node
/**
 * Focused integration test for document discovery helpers.
 *
 * Covers:
 * - list_docs should return titles from workspace metadata when GraphQL omits them
 * - search_docs should support exact/prefix matching, tag filtering, and updatedAt sorting
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

function expectIncludes(haystack, needle, message) {
  if (!Array.isArray(haystack) || !haystack.includes(needle)) {
    throw new Error(`${message}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  }
}

async function main() {
  console.log("=== Document Discovery Integration Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const client = new Client({ name: "affine-mcp-doc-discovery", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-e2e-doc-discovery-noconfig",
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

  await client.connect(transport);

  try {
    const timestamp = Date.now();
    const workspace = await call("create_workspace", { name: `doc-discovery-${timestamp}` });
    expectTruthy(workspace?.id, "create_workspace id");

    await call("update_doc_title", {
      workspaceId: workspace.id,
      docId: workspace.firstDocId,
      title: "Workspace Home",
    });

    const listed = await call("list_docs", { workspaceId: workspace.id, first: 50 });
    const listedTitles = listed?.edges?.map(edge => edge?.node?.title) || [];
    expectIncludes(listedTitles, "Workspace Home", "list_docs titles");

    const createdDocs = [];
    for (const title of ["Tasky", "Operations Notes", "Task Tracker"]) {
      const created = await call("create_doc", {
        workspaceId: workspace.id,
        title,
        content: `${title} body`,
      });
      expectTruthy(created?.docId, `create_doc docId for ${title}`);
      createdDocs.push(created);
    }

    await call("create_tag", { workspaceId: workspace.id, tag: "urgent" });
    await call("add_tag_to_doc", {
      workspaceId: workspace.id,
      docId: createdDocs[2].docId,
      tag: "urgent",
    });

    const search = await call("search_docs", { workspaceId: workspace.id, query: "Task", limit: 10 });
    expectEqual(search?.totalCount, 2, "search_docs totalCount");
    const searchTitles = search?.results?.map(result => result?.title) || [];
    expectIncludes(searchTitles, "Tasky", "search_docs result titles");
    expectIncludes(searchTitles, "Task Tracker", "search_docs result titles");

    const exactMatch = await call("search_docs", {
      workspaceId: workspace.id,
      query: "Tasky",
      matchMode: "exact",
      limit: 10,
    });
    expectEqual(exactMatch?.totalCount, 1, "search_docs exact totalCount");
    expectEqual(exactMatch?.results?.[0]?.title, "Tasky", "search_docs exact first result");

    const prefixMatch = await call("search_docs", {
      workspaceId: workspace.id,
      query: "Task",
      matchMode: "prefix",
      limit: 10,
    });
    expectEqual(prefixMatch?.totalCount, 2, "search_docs prefix totalCount");

    const tagFiltered = await call("search_docs", {
      workspaceId: workspace.id,
      query: "Task",
      tag: "urgent",
      limit: 10,
    });
    expectEqual(tagFiltered?.totalCount, 1, "search_docs tag-filter totalCount");
    expectEqual(tagFiltered?.results?.[0]?.title, "Task Tracker", "search_docs tag-filter result");
    expectIncludes(tagFiltered?.results?.[0]?.tags || [], "urgent", "search_docs tag-filter tags");

    const sortedByUpdatedAt = await call("search_docs", {
      workspaceId: workspace.id,
      query: "Task",
      sortBy: "updatedAt",
      sortDirection: "desc",
      limit: 10,
    });
    expectEqual(sortedByUpdatedAt?.results?.[0]?.title, "Task Tracker", "search_docs updatedAt sort");

    console.log();
    console.log("=== Document discovery integration test passed ===");
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
