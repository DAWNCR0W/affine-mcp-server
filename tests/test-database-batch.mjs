#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * Integration test for compose_database_from_intent "table" and add_database_rows.
 * add_database_rows is atomic, so the rejection case also checks that no row was added.
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

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  console.log("=== Database Batch Integration Test ===");
  const client = new Client({ name: "affine-mcp-database-batch", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: testTempPath("database-batch-config"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", chunk => process.stderr.write(`[mcp-server] ${chunk}`));

  async function call(toolName, args = {}) {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    const parsed = parseContent(result);
    if (result?.isError) throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
    console.log(`  ✓ ${toolName}`);
    return parsed;
  }

  async function rejects(toolName, args, message) {
    try {
      await call(toolName, args);
    } catch {
      return;
    }
    throw new Error(`${message}: expected ${toolName} to fail`);
  }

  await client.connect(transport);
  try {
    const run = testResourceName("run");
    const { id: workspaceId } = await call("create_workspace", { name: `database-batch-${run}` });
    expect(workspaceId, "create_workspace id");

    const dbDoc = await call("create_doc", { workspaceId, title: `DB ${run}` });
    await rejects("compose_database_from_intent", { workspaceId, docId: dbDoc.docId, intent: "table" }, 'intent "table" without columns rejected');
    const db = await call("compose_database_from_intent", {
      workspaceId, docId: dbDoc.docId, intent: "table", title: "Tasks",
      columns: [{ name: "Status", type: "select", options: ["Todo", "Done"] }, { name: "Count", type: "number" }],
      seedRows: [{ title: "first", Status: "Todo" }],
    });
    expectEqual(db.stats.rowCount, 1, "table intent seeded one row");
    expectEqual(db.columns.map(column => column.name).slice(0, 3), ["Title", "Status", "Count"], "Title column plus the requested columns");

    const rows = await call("add_database_rows", {
      workspaceId, docId: dbDoc.docId, databaseBlockId: db.databaseBlockId,
      rows: [{ cells: { title: "second", Status: "Done", Count: 2 } }, { cells: { title: "third", Status: "Todo" } }],
    });
    expectEqual(rows.added, 2, "two rows added");
    expectEqual(rows.rowBlockIds.length, 2, "row ids returned in input order");

    await rejects("add_database_rows", {
      workspaceId, docId: dbDoc.docId, databaseBlockId: db.databaseBlockId,
      rows: [{ cells: { title: "ok" } }, { cells: { Count: "not-a-number" } }],
    }, "invalid row rejects the batch");
    const columns = await call("read_database_columns", { workspaceId, docId: dbDoc.docId, databaseBlockId: db.databaseBlockId });
    expectEqual(columns.rowCount, 3, "rejected batch added no rows")

    console.log("\nDatabase Batch Integration Test passed");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
