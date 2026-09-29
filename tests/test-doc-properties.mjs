#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

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
import assert from "node:assert/strict";
import * as Y from "yjs";
import { acquireCredentials } from "./acquire-credentials.mjs";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from "../dist/ws.js";
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
      XDG_CONFIG_HOME: testTempPath('doc-properties-config'),
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
    const timestamp = testResourceName('run');
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

    // --- opt-in recovery of retained legacy data without native writes --------
    assert.equal(Object.hasOwn(listedDefs, "legacy"), false, "default listing must stay native-only");
    const emptyLegacy = await call("list_doc_properties", { workspaceId, docId, includeLegacy: true });
    assert.deepEqual(emptyLegacy.legacy, { definitions: [], properties: [], orphanValues: [] });
    const { cookie } = await acquireCredentials(BASE_URL, EMAIL, PASSWORD);
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${BASE_URL}/graphql`), cookie);
    try {
      await joinWorkspace(socket, workspaceId);
      const info = new Y.Doc();
      const props = new Y.Doc();
      const legacyValues = ["Retained text", "0", "false", "2025-01-02"];
      for (const [i, definition] of [textProp, numberProp, checkboxProp, dateProp].entries()) {
        const record = info.getMap(definition.propertyId);
        for (const key of ["name", "type", "index"]) record.set(key, definition[key]);
        record.set("id", definition.propertyId);
        props.getMap(docId).set(`custom:${definition.propertyId}`, legacyValues[i]);
      }
      const legacyOnlyId = "legacy-only-property";
      for (const [key, value] of Object.entries({ id: legacyOnlyId, name: "Legacy only", type: "text", index: "b00" })) {
        info.getMap(legacyOnlyId).set(key, value);
      }
      props.getMap(docId).set(`custom:${legacyOnlyId}`, "Recover me");
      props.getMap(docId).set("custom:orphan-property", "Retained orphan");
      props.getMap(docId).set("createdBy", "legacy-creator-must-not-win");
      for (const [guid, doc] of [["db$docCustomPropertyInfo", info], ["db$docProperties", props]]) {
        await pushDocUpdate(socket, workspaceId, guid, Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"));
        doc.destroy();
      }
      const guids = ["db$docCustomPropertyInfo", "db$docProperties", `db$${workspaceId}$docCustomPropertyInfo`, `db$${workspaceId}$docProperties`];
      async function storageState() {
        const result = {};
        for (const guid of guids) {
          const snapshot = await loadDoc(socket, workspaceId, guid);
          const doc = new Y.Doc();
          try {
            if (snapshot.missing) Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
            result[guid] = Object.fromEntries([...doc.share.keys()].map(key => [key, doc.getMap(key).toJSON()]));
          } finally { doc.destroy(); }
        }
        return result;
      }
      const before = await storageState();
      assert.deepEqual(await call("list_doc_properties", { workspaceId, docId }), listedDefs, "legacy data must remain opt-in");
      const recovered = await call("list_doc_properties", { workspaceId, docId, includeLegacy: true });
      const { legacy, ...native } = recovered;
      assert.deepEqual(native, listedDefs, "conflicting legacy values must never override native results");
      assert.deepEqual(legacy.properties.map(p => p.value), ["Retained text", 0, false, "2025-01-02", "Recover me"]);
      assert.deepEqual(legacy.orphanValues, [{ propertyId: "orphan-property", value: "Retained orphan" }]);
      assert.deepEqual(await storageState(), before, "recovery reads must not change either storage namespace");
      const restored = await call("create_custom_property", { workspaceId, name: "Recovered legacy only", type: "text" });
      await setWithRetry({ workspaceId, docId, property: restored.propertyId, value: legacy.properties.find(p => p.propertyId === legacyOnlyId).value });
      await readProperty(workspaceId, docId, restored.propertyId, p => p?.value === "Recover me", "explicit legacy recovery");
    } finally { socket.disconnect(); }

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
    const afterDelete = await call("list_doc_properties", { workspaceId, docId, includeLegacy: true });
    assert.equal(afterDelete.properties.find(p => p.propertyId === textProp.propertyId).set, false);
    assert.equal(afterDelete.definitions.some(d => d.id === numberProp.propertyId), false);
    assert.equal(afterDelete.legacy.properties.find(p => p.propertyId === textProp.propertyId).value, "Retained text");
    assert.equal(afterDelete.legacy.properties.find(p => p.propertyId === numberProp.propertyId).value, 0);
    console.log("=== Document custom-property integration test passed ===");
  } finally {
    if (workspaceId && docId) {
      await call("delete_doc", { workspaceId, docId, confirmDocId: docId }).catch(err => {
        console.warn(`  cleanup delete_doc failed: ${err?.message ?? err}`);
      });
    }
    if (workspaceId) {
      await call("delete_workspace", { id: workspaceId, confirmWorkspaceId: workspaceId }).catch(err => {
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
