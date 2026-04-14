#!/usr/bin/env node
/**
 * Regression test: create_doc_from_markdown must preserve inline formatting.
 *
 * Exposes the bug where formatting was silently stripped on write because
 * operationToAppendInput did not pass deltas through for paragraph/heading/
 * quote/callout blocks, so makeText() always received a plain string.
 *
 * Requires: AFFINE_BASE_URL, AFFINE_EMAIL, AFFINE_PASSWORD, AFFINE_WORKSPACE_ID
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL;
const EMAIL = process.env.AFFINE_EMAIL;
const PASSWORD = process.env.AFFINE_PASSWORD;
const WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;

if (!BASE_URL || !EMAIL || !PASSWORD || !WORKSPACE_ID) {
  console.error("Required: AFFINE_BASE_URL, AFFINE_EMAIL, AFFINE_PASSWORD, AFFINE_WORKSPACE_ID");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(condition, label, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  const client = new Client({ name: "create-doc-formatting-test", version: "1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    env: {
      ...process.env,
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
    },
  });

  await client.connect(transport);

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text;
    if (!text) throw new Error(`No response from ${name}`);
    try { return JSON.parse(text); } catch { throw new Error(`Bad JSON from ${name}: ${text}`); }
  };

  const createdDocs = [];

  try {
    console.log("=== create_doc_from_markdown formatting regression test ===\n");

    // ── Test cases: one per block type ──────────────────────────────────────
    const cases = [
      {
        label: "paragraph bold",
        markdown: "This is **bold** text.",
        checks: [
          [/\*\*bold\*\*/, "**bold** preserved"],
          [/^(?!.*\*\*bold\*\*.*\*\*bold\*\*)/, "not doubled"],
        ],
      },
      {
        label: "paragraph italic",
        markdown: "This is *italic* text.",
        checks: [[/\*italic\*/, "*italic* preserved"]],
      },
      {
        label: "paragraph bold italic",
        markdown: "This is ***bold italic*** combined.",
        checks: [[/\*\*\*bold italic\*\*\*/, "***bold italic*** preserved"]],
      },
      {
        label: "paragraph strikethrough",
        markdown: "This is ~~strike~~ text.",
        checks: [[/~~strike~~/, "~~strike~~ preserved"]],
      },
      {
        label: "paragraph plain link",
        markdown: "See [AFFiNE](https://affine.pro) here.",
        checks: [[/\[AFFiNE\]\(https:\/\/affine\.pro\)/, "plain link preserved"]],
      },
      {
        label: "paragraph bold link",
        markdown: "See [**bold**](https://affine.pro) here.",
        checks: [[/\[\*\*bold\*\*\]\(https:\/\/affine\.pro\)/, "bold link preserved"]],
      },
      {
        label: "paragraph no mark bleeding",
        markdown: "Hello **bold** and plain after.",
        checks: [
          [/\*\*bold\*\*/, "bold present"],
          [/\*\*bold\*\* and plain after/, "plain text after bold not bolded"],
        ],
      },
      {
        label: "heading bold",
        markdown: "## Section with **bold** heading",
        checks: [[/\*\*bold\*\*/, "bold in heading preserved"]],
      },
      {
        label: "blockquote bold",
        markdown: "> A **bold** quote.",
        checks: [[/> .*\*\*bold\*\*/, "bold in quote preserved"]],
      },
      {
        label: "callout bold",
        markdown: "> [!NOTE]\n> Callout with **bold** text.",
        checks: [
          [/> \[!NOTE\]/, "callout marker preserved"],
          [/> .*\*\*bold\*\*/, "bold in callout preserved"],
        ],
      },
      {
        label: "mixed formatting",
        markdown: "Has **bold**, *italic*, and ~~strike~~ together.",
        checks: [
          [/\*\*bold\*\*/, "bold preserved in mixed"],
          [/\*italic\*/, "italic preserved in mixed"],
          [/~~strike~~/, "strike preserved in mixed"],
        ],
      },
    ];

    for (const { label, markdown, checks } of cases) {
      console.log(`\n${label}:`);
      const doc = await call("create_doc_from_markdown", {
        workspaceId: WORKSPACE_ID,
        title: `regression-${label}`,
        markdown,
      });
      createdDocs.push(doc.docId);

      const exported = await call("export_doc_markdown", {
        workspaceId: WORKSPACE_ID,
        docId: doc.docId,
      });

      for (const [pattern, checkLabel] of checks) {
        check(pattern.test(exported.markdown), checkLabel, `got: ${JSON.stringify(exported.markdown)}`);
      }
    }

  } finally {
    console.log("\nCleaning up...");
    for (const docId of createdDocs) {
      try { await call("delete_doc", { workspaceId: WORKSPACE_ID, docId }); }
      catch { /* ignore */ }
    }
    await client.close();
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log("\n=== All checks passed ===");
}

main().catch(err => { console.error(err); process.exit(1); });
