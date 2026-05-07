#!/usr/bin/env node
/**
 * Focused integration test for document convenience tools.
 *
 * Covers wrappers and helpers that are intentionally excluded from the compact
 * core tool profile but still remain available in the full backward-compatible
 * surface.
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

function expectArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`${message}: expected array, got ${JSON.stringify(value)}`);
  }
}

async function main() {
  console.log("=== Document Convenience Tools Integration Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const client = new Client({ name: "affine-mcp-document-convenience-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-document-convenience-noconfig",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  -> ${toolName}(${JSON.stringify(args)})`);
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
    console.log("    OK");
    return parsed;
  }

  await client.connect(transport);

  try {
    const timestamp = Date.now();
    const workspace = await call("create_workspace", { name: `doc-convenience-${timestamp}` });
    const workspaceId = workspace?.id;
    const parentDocId = workspace?.firstDocId;
    expectTruthy(workspaceId, "create_workspace id");
    expectTruthy(parentDocId, "create_workspace firstDocId");

    await call("update_doc_title", {
      workspaceId,
      docId: parentDocId,
      title: "Convenience Home",
    });

    const batch = await call("batch_create_docs", {
      workspaceId,
      docs: [
        { title: "Batch Alpha", markdown: "# Batch Alpha\n\nAlpha token.", parentDocId },
        { title: "Batch Second", markdown: "# Batch Second\n\nSecond token.", parentDocId },
      ],
    });
    expectTruthy(batch?.created === 2, "batch_create_docs created two docs");
    expectArray(batch?.results, "batch_create_docs results");
    const alphaDocId = batch.results.find(result => result.title === "Batch Alpha")?.docId;
    expectTruthy(alphaDocId, "batch alpha docId");

    const duplicate = await call("duplicate_doc", {
      workspaceId,
      docId: alphaDocId,
      title: "Duplicated Batch Alpha",
      parentDocId,
    });
    const duplicateDocId = duplicate?.docId;
    expectTruthy(duplicateDocId, "duplicate_doc docId");

    const template = await call("create_doc_from_markdown", {
      workspaceId,
      title: "Convenience Template",
      markdown: "# Hello {{name}}\n\nTemplate body for {{team}}.",
      parentDocId,
    });
    expectTruthy(template?.docId, "template docId");

    const instance = await call("create_doc_from_template", {
      workspaceId,
      templateDocId: template.docId,
      title: "Template Instance",
      variables: { name: "Ada", team: "MCP" },
      parentDocId,
    });
    expectTruthy(instance?.docId, "create_doc_from_template docId");

    const byTitle = await call("get_doc_by_title", {
      workspaceId,
      query: "Template Instance",
    });
    expectTruthy(byTitle?.found, "get_doc_by_title found instance");
    const instanceMarkdown = byTitle.results?.[0]?.markdown || "";
    expectTruthy(instanceMarkdown.includes("Ada") && instanceMarkdown.includes("MCP"), "template variables materialized");

    const replacePreview = await call("find_and_replace", {
      workspaceId,
      docId: duplicateDocId,
      search: "Alpha",
      replace: "Beta",
      dryRun: true,
    });
    expectTruthy(replacePreview?.totalMatches > 0, "find_and_replace dryRun matches");

    const replaceApply = await call("find_and_replace", {
      workspaceId,
      docId: duplicateDocId,
      search: "Alpha",
      replace: "Beta",
    });
    expectTruthy(replaceApply?.totalMatches > 0, "find_and_replace applied matches");

    const replaced = await call("export_doc_markdown", {
      workspaceId,
      docId: duplicateDocId,
    });
    expectTruthy(replaced?.markdown?.includes("Beta"), "find_and_replace persisted replacement");

    await call("add_tag_to_doc", {
      workspaceId,
      docId: duplicateDocId,
      tag: "Convenience",
    });
    const docsByTag = await call("get_docs_by_tag", {
      workspaceId,
      tag: "venien",
    });
    expectTruthy(docsByTag?.count > 0, "get_docs_by_tag returns substring matches");
    expectTruthy(
      docsByTag.docs?.some(doc => doc.docId === duplicateDocId),
      "get_docs_by_tag includes duplicate doc",
    );

    const backlinks = await call("list_backlinks", {
      workspaceId,
      docId: duplicateDocId,
    });
    expectTruthy(backlinks?.count > 0, "list_backlinks finds parent embed");

    const doomed = await call("create_doc", {
      workspaceId,
      title: "Temporary Orphan Target",
      parentDocId,
    });
    expectTruthy(doomed?.docId, "temporary docId");
    await call("delete_doc", {
      workspaceId,
      docId: doomed.docId,
    });

    const cleanupPreview = await call("cleanup_orphan_embeds", {
      workspaceId,
      docId: parentDocId,
      dryRun: true,
    });
    expectTruthy(cleanupPreview?.orphansFound > 0, "cleanup_orphan_embeds dryRun finds orphan");

    const cleanupApply = await call("cleanup_orphan_embeds", {
      workspaceId,
      docId: parentDocId,
    });
    expectTruthy(cleanupApply?.orphansRemoved > 0, "cleanup_orphan_embeds removes orphan");

    await call("delete_workspace", { id: workspaceId });

    console.log();
    console.log("=== Document convenience tools integration test passed ===");
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error();
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
