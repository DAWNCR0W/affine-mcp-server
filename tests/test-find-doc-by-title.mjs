#!/usr/bin/env node
/**
 * Focused integration test for find_doc_by_title.
 *
 * Covers:
 * - single exact-title match returns the right doc
 * - multiple exact-title matches return all docs
 * - default is case-sensitive; caseInsensitive=true folds case
 * - non-matching title returns empty matches
 * - limit caps the returned matches and reports truncated
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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
  try { return JSON.parse(text); } catch { return text; }
}
function expectTruthy(value, message) {
  if (!value) throw new Error(`${message}: expected truthy, got ${JSON.stringify(value)}`);
}
function expectEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectIncludes(haystack, needle, message) {
  if (!Array.isArray(haystack) || !haystack.includes(needle)) {
    throw new Error(`${message}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  }
}

async function main() {
  console.log("=== find_doc_by_title Integration Test ===");
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    env: {
      ...process.env,
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-e2e-find-doc-by-title-noconfig",
    },
  });
  const client = new Client({ name: "find-doc-by-title-test", version: "0.0.1" }, { capabilities: {} });

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

  const createdAt = Date.now();
  const baseSuffix = `pr5-${createdAt}-${randomUUID().slice(0, 8)}`;

  let workspace;
  try {
    const timestamp = Date.now();
    workspace = await call("create_workspace", { name: `find-doc-by-title-${timestamp}` });
    if (!workspace?.id) throw new Error("create_workspace did not return an id");
    console.log(`  workspace created: ${workspace.id}`);

    // Scenario 1: single exact match
    console.log("\n--- Scenario 1: single exact match ---");
    const singleTitle = `Single-${baseSuffix}`;
    const created1 = await call("create_doc", {
      workspaceId: workspace.id,
      title: singleTitle,
      content: "single-match seed",
    });
    expectTruthy(created1?.docId, "create_doc returned docId");

    const r1 = await call("find_doc_by_title", {
      workspaceId: workspace.id,
      title: singleTitle,
    });
    expectEqual(Array.isArray(r1?.matches) ? r1.matches.length : -1, 1, "single match count");
    expectEqual(r1.matches[0].id, created1.docId, "single match id");
    expectEqual(r1.matches[0].title, singleTitle, "single match title");
    expectEqual(r1.caseInsensitive, false, "default caseInsensitive=false");
    expectEqual(r1.query, singleTitle, "response echoes query");
    expectTruthy(
      typeof r1.workspaceDocCount === "number" && r1.workspaceDocCount >= 1,
      "workspaceDocCount is a positive number",
    );
    expectTruthy(r1.matches[0].createdAt, "match object has createdAt");
    expectTruthy(r1.matches[0].updatedAt, "match object has updatedAt");
    console.log("✓ single exact match");

    // Scenario 2: multiple exact matches
    console.log("\n--- Scenario 2: multiple exact matches ---");
    const dupTitle = `Dup-${baseSuffix}`;
    const a = await call("create_doc", { workspaceId: workspace.id, title: dupTitle, content: "dup-a" });
    const b = await call("create_doc", { workspaceId: workspace.id, title: dupTitle, content: "dup-b" });

    const r2 = await call("find_doc_by_title", {
      workspaceId: workspace.id,
      title: dupTitle,
    });
    expectEqual(r2.matches.length, 2, "dup match count");
    const ids2 = r2.matches.map(m => m.id);
    expectIncludes(ids2, a.docId, "dup match contains a");
    expectIncludes(ids2, b.docId, "dup match contains b");
    console.log("✓ multiple exact matches");

    // Scenario 3: case-sensitivity
    console.log("\n--- Scenario 3: case-sensitivity ---");
    const upperTitle = `Case-${baseSuffix}`;
    const lowerTitle = `case-${baseSuffix}`;
    const upper = await call("create_doc", { workspaceId: workspace.id, title: upperTitle, content: "case-upper" });
    const lower = await call("create_doc", { workspaceId: workspace.id, title: lowerTitle, content: "case-lower" });

    const rCaseSensitive = await call("find_doc_by_title", {
      workspaceId: workspace.id,
      title: upperTitle,
    });
    expectEqual(rCaseSensitive.matches.length, 1, "case-sensitive: only Upper matches");
    expectEqual(rCaseSensitive.matches[0].id, upper.docId, "case-sensitive picked upper");

    const rCaseFold = await call("find_doc_by_title", {
      workspaceId: workspace.id,
      title: upperTitle,
      caseInsensitive: true,
    });
    expectEqual(rCaseFold.matches.length, 2, "case-insensitive: both match");
    expectEqual(rCaseFold.caseInsensitive, true, "echoes caseInsensitive flag");
    console.log("✓ case-sensitivity");

    // Scenario 4: no match
    console.log("\n--- Scenario 4: no match ---");
    const rNone = await call("find_doc_by_title", {
      workspaceId: workspace.id,
      title: `Missing-${randomUUID()}`,
    });
    expectEqual(rNone.matches.length, 0, "no match returns empty");
    console.log("✓ no match");

    // Scenario 5: limit + truncated flag (limit < actual matches)
    console.log("\n--- Scenario 5: limit < matches ---");
    const rLimited = await call("find_doc_by_title", {
      workspaceId: workspace.id,
      title: dupTitle,
      limit: 1,
    });
    expectEqual(rLimited.matches.length, 1, "limit=1 returns only 1");
    expectEqual(rLimited.truncated, true, "truncated=true when capped");
    console.log("✓ limit < matches → truncated true");

    // Scenario 6: limit equals exact match count → truncated must stay false
    // Guard against the "truncated set on equality" UX trap where callers
    // would chase non-existent additional matches.
    console.log("\n--- Scenario 6: limit === matches ---");
    const rExact = await call("find_doc_by_title", {
      workspaceId: workspace.id,
      title: dupTitle,
      limit: 2,
    });
    expectEqual(rExact.matches.length, 2, "limit=2 returns both matches");
    expectEqual(rExact.truncated, false, "truncated=false when limit equals exact match count");
    console.log("✓ limit === matches → truncated false");

    console.log("\n=== ALL find_doc_by_title scenarios PASSED ===");
  } finally {
    try {
      if (workspace?.id) {
        await client.callTool(
          { name: "delete_workspace", arguments: { id: workspace.id } },
          undefined,
          { timeout: TOOL_TIMEOUT_MS },
        );
        console.log(`  workspace deleted: ${workspace.id}`);
      }
    } catch (err) {
      console.warn(`Workspace cleanup failed: ${err?.message ?? err}`);
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error("FAIL:", err?.message ?? err);
  process.exit(1);
});
