#!/usr/bin/env node
/**
 * Focused integration test for document custom-property tools.
 *
 * Covers the full round-trip against a live AFFiNE instance:
 * - create_custom_property for text / number / checkbox / date
 * - set_doc_property by property id and by property name, with per-type encoding
 * - list_doc_properties reflects definitions and decoded values
 * - value validation rejects malformed input (bad date)
 * - clear_doc_property removes a value
 * - delete_custom_property removes a definition
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

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Document Custom-Property Integration Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const client = new Client({ name: "affine-mcp-doc-properties", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-e2e-doc-properties-noconfig",
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
    const parsed = parseContent(result);
    if (result?.isError) {
      const err = new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
      err.toolError = parsed ?? result?.content?.[0]?.text;
      throw err;
    }
    if (parsed && typeof parsed === "object" && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === "string" && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }
    console.log("    ✓ OK");
    return parsed;
  }

  // set_doc_property may transiently fail until the new doc lands in workspace
  // metadata; retry a few times before giving up.
  async function setWithRetry(args, attempts = 10, delayMs = 1000) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await call("set_doc_property", args);
      } catch (err) {
        lastErr = err;
        if (!/is not present in workspace/.test(err.message)) throw err;
        if (attempt < attempts) await delay(delayMs);
      }
    }
    throw lastErr;
  }

  async function readProperty(workspaceId, docId, propertyId, predicate, description, attempts = 15, delayMs = 1000) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const listed = await call("list_doc_properties", { workspaceId, docId });
      last = (listed?.properties || []).find(p => p.propertyId === propertyId) || null;
      if (predicate(last, listed)) return { entry: last, listed };
      if (attempt < attempts) await delay(delayMs);
    }
    throw new Error(`${description}: timed out. Last entry: ${JSON.stringify(last)}`);
  }

  await client.connect(transport);

  let workspaceId;
  let docId;

  try {
    const timestamp = Date.now();
    const workspace = await call("create_workspace", { name: `doc-properties-${timestamp}` });
    expectTruthy(workspace?.id, "create_workspace id");
    workspaceId = workspace.id;

    const doc = await call("create_doc", { workspaceId, title: `Props Doc ${timestamp}`, content: "body" });
    expectTruthy(doc?.docId, "create_doc docId");
    docId = doc.docId;

    // --- create definitions ---------------------------------------------------
    const textProp = await call("create_custom_property", { workspaceId, name: "Status Text", type: "text" });
    expectTruthy(textProp?.propertyId, "text propertyId");
    expectTruthy(textProp?.index, "text index (fractional)");
    const numberProp = await call("create_custom_property", { workspaceId, name: "Priority", type: "number" });
    const checkboxProp = await call("create_custom_property", { workspaceId, name: "Done", type: "checkbox" });
    const dateProp = await call("create_custom_property", { workspaceId, name: "Due Date", type: "date" });

    // --- text: set by id ------------------------------------------------------
    await setWithRetry({ workspaceId, docId, property: textProp.propertyId, value: "Hello world" });
    await readProperty(
      workspaceId, docId, textProp.propertyId,
      entry => entry && entry.value === "Hello world" && entry.type === "text" && entry.set === true,
      "text value by id",
    );

    // --- number: set by name, then update ------------------------------------
    await setWithRetry({ workspaceId, docId, property: "Priority", value: 5 });
    await readProperty(
      workspaceId, docId, numberProp.propertyId,
      entry => entry && entry.value === 5,
      "number value by name",
    );
    await setWithRetry({ workspaceId, docId, property: numberProp.propertyId, value: 7 });
    await readProperty(
      workspaceId, docId, numberProp.propertyId,
      entry => entry && entry.value === 7,
      "number value updated",
    );

    // --- checkbox: boolean encoding ------------------------------------------
    await setWithRetry({ workspaceId, docId, property: checkboxProp.propertyId, value: true });
    await readProperty(
      workspaceId, docId, checkboxProp.propertyId,
      entry => entry && entry.value === true,
      "checkbox true",
    );
    await setWithRetry({ workspaceId, docId, property: checkboxProp.propertyId, value: false });
    await readProperty(
      workspaceId, docId, checkboxProp.propertyId,
      entry => entry && entry.value === false,
      "checkbox false",
    );

    // --- date: YYYY-MM-DD encoding -------------------------------------------
    await setWithRetry({ workspaceId, docId, property: dateProp.propertyId, value: "2026-06-14" });
    await readProperty(
      workspaceId, docId, dateProp.propertyId,
      entry => entry && entry.value === "2026-06-14",
      "date value",
    );

    // --- validation: malformed date must be rejected -------------------------
    let dateRejected = false;
    try {
      await call("set_doc_property", { workspaceId, docId, property: dateProp.propertyId, value: "not-a-date" });
    } catch {
      dateRejected = true;
    }
    expectTruthy(dateRejected, "malformed date should be rejected");

    let semanticDateRejected = false;
    try {
      await call("set_doc_property", { workspaceId, docId, property: dateProp.propertyId, value: "2026-02-30" });
    } catch {
      semanticDateRejected = true;
    }
    expectTruthy(semanticDateRejected, "semantically invalid date should be rejected");

    // --- definitions present in listing --------------------------------------
    const listedDefs = await call("list_doc_properties", { workspaceId, docId });
    const defIds = (listedDefs?.definitions || []).map(d => d.id);
    for (const p of [textProp, numberProp, checkboxProp, dateProp]) {
      expectTruthy(defIds.includes(p.propertyId), `definition listed: ${p.propertyId}`);
    }

    // --- clear a value -------------------------------------------------------
    const cleared = await call("clear_doc_property", { workspaceId, docId, property: textProp.propertyId });
    expectEqual(cleared?.cleared, true, "clear_doc_property cleared flag");
    await readProperty(
      workspaceId, docId, textProp.propertyId,
      entry => entry && entry.set === false && (entry.value === null || entry.value === undefined),
      "text value cleared",
    );

    // --- delete a definition -------------------------------------------------
    const deleted = await call("delete_custom_property", { workspaceId, property: numberProp.propertyId });
    expectEqual(deleted?.deleted, true, "delete_custom_property deleted flag");
    await readProperty(
      workspaceId, docId, numberProp.propertyId,
      (_entry, listed) => !(listed?.definitions || []).some(d => d.id === numberProp.propertyId),
      "deleted definition removed from listing",
    );

    console.log();
    console.log("=== Document custom-property integration test passed ===");
  } finally {
    if (workspaceId && docId) {
      await call("delete_doc", { workspaceId, docId }).catch(err => {
        console.warn(`  cleanup delete_doc failed: ${err?.message ?? err}`);
      });
    }
    if (workspaceId) {
      await call("delete_workspace", { id: workspaceId }).catch(err => {
        console.warn(`  cleanup delete_workspace failed: ${err?.message ?? err}`);
      });
    }
    await transport.close();
  }
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
