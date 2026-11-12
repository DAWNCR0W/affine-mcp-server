#!/usr/bin/env node
import { testResourceName, testTempPath } from "./require-destructive-test-safety.mjs";

// This integration test requires the disposable AFFiNE stack used by test:e2e.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const email = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const password = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!password) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
const timeout = Number(process.env.MCP_TOOL_TIMEOUT_MS || "60000");

const client = new Client({ name: "affine-mcp-database-view-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(projectDir, "dist", "index.js")],
  cwd: projectDir,
  env: {
    AFFINE_BASE_URL: baseUrl,
    AFFINE_EMAIL: email,
    AFFINE_PASSWORD: password,
    AFFINE_LOGIN_AT_START: "sync",
    XDG_CONFIG_HOME: testTempPath("database-view-config"),
  },
  stderr: "pipe",
});
transport.stderr?.on("data", chunk => process.stderr.write(`[mcp-server] ${chunk}`));

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  await client.connect(transport);
  const workspace = await call("create_workspace", { name: testResourceName("database-view") });
  assert.ok(workspace.id, "workspace must be created in the disposable stack");
  const created = await call("create_doc", { workspaceId: workspace.id, title: "Database view integration" });
  const scope = { workspaceId: workspace.id, docId: created.docId };
  const database = await call("append_block", { ...scope, type: "database", text: "Views" });
  const target = { ...scope, databaseBlockId: database.blockId };
  const initial = await call("read_database_columns", target);
  assert.equal(initial.columnCount, 0, "append_block creates the native zero-column database case");
  assert.equal(initial.views.length, 1);

  const emptyTable = await call("add_database_view", { ...target, name: "Empty table", mode: "table" });
  assert.equal(emptyTable.totalViews, 2);
  const emptyReadback = await call("read_database_columns", target);
  const emptyView = emptyReadback.views.find(view => view.id === emptyTable.viewId);
  assert.ok(emptyView, "added empty table must survive a fresh server read");
  assert.equal(emptyReadback.views.length, emptyTable.totalViews);
  assert.equal(emptyView.mode, "table");
  assert.deepEqual(emptyView.columns, []);
  assert.deepEqual(emptyView.header, { titleColumn: null, iconColumn: null });
  assert.equal(emptyView.groupBy, null);

  const status = await call("add_database_column", {
    ...target, name: "Status", type: "select", options: ["Open", "Done"], width: 240,
  });
  const kanban = await call("add_database_view", { ...target, name: "By status", mode: "kanban", groupBy: "Status" });
  const boardReadback = await call("read_database_columns", target);
  assert.equal(boardReadback.columnCount, 1);
  assert.equal(boardReadback.views.length, 3);
  assert.equal(boardReadback.views.length, kanban.totalViews);
  assert.deepEqual(boardReadback.columns[0].options.map(option => option.value), ["Open", "Done"]);
  const boardView = boardReadback.views.find(view => view.id === kanban.viewId);
  assert.ok(boardView, "added kanban must survive a fresh server read");
  assert.equal(boardView.mode, "kanban");
  assert.deepEqual(boardView.groupBy, { columnId: status.columnId, name: "select", type: "groupBy" });
  assert.deepEqual(boardView.header, { titleColumn: null, iconColumn: null });
  assert.deepEqual(boardView.columns.map(column => ({ id: column.id, width: column.width, hidden: column.hidden })), [
    { id: status.columnId, width: 240, hidden: false },
  ]);
  assert.deepEqual(boardReadback.views.find(view => view.id === emptyTable.viewId).columnIds, [status.columnId],
    "adding a column also updates the table created while the database was empty");

  const title = await call("add_database_column", { ...target, name: "Title", type: "title", width: 320 });
  const titled = await call("add_database_view", { ...target, name: "With title", mode: "table" });
  const finalReadback = await call("read_database_columns", target);
  assert.equal(finalReadback.views.length, 4);
  assert.equal(finalReadback.views.length, titled.totalViews);
  assert.deepEqual(finalReadback.views.find(view => view.id === titled.viewId).header,
    { titleColumn: title.columnId, iconColumn: "type" });
  await assert.rejects(call("add_database_view", { ...target, name: "With title", mode: "table" }), /already exists/);
  assert.equal((await call("read_database_columns", target)).views.length, 4, "duplicate rejection must not persist a view");
  console.log("PASS: live database table/kanban views, zero columns, headers, grouping, widths and counts survive readback");
} finally {
  await client.close();
}
