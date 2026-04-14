#!/usr/bin/env node
/**
 * E2E test: inline formatting round-trip through live tool flows.
 *
 * Reproduces the scenarios called out in PR #97 review:
 *   create_doc_from_markdown → export_doc_markdown
 *   create_doc_from_markdown → duplicate_doc → export_doc_markdown
 *   create_doc_from_markdown → create_doc_from_template → export_doc_markdown
 *   create_doc_from_markdown → find_and_replace (verify attrs preserved)
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

const SOURCE_MARKDOWN = [
  "# Formatting Round-Trip",
  "",
  "Plain paragraph.",
  "",
  "This is **bold** text.",
  "",
  "This is *italic* text.",
  "",
  "This is ***bold italic*** text.",
  "",
  "Hello **bold** and plain after.",
  "",
  "This is ~~strikethrough~~ text.",
  "",
  "See [AFFiNE](https://affine.pro) for more.",
  "",
  "See [**bold link**](https://affine.pro) here.",
  "",
  "Has **bold**, *italic*, ~~strike~~ together.",
  "",
  "> A **bold** quote with *italic* inside.",
  "",
  "> [!NOTE]",
  "> Callout with **bold** and *italic* text.",
].join("\n");

// Patterns that must be present in a correctly round-tripped export
const EXPECTED_PATTERNS = [
  [/\*\*bold\*\* text/, "bold"],
  [/\*italic\* text/, "italic"],
  [/\*\*\*bold italic\*\*\*/, "bold italic"],
  [/\*\*bold\*\* and plain after/, "bold mid-sentence no bleed"],
  [/~~strikethrough~~/, "strikethrough"],
  [/\[AFFiNE\]\(https:\/\/affine\.pro\)/, "plain link"],
  [/\[\*\*bold link\*\*\]\(https:\/\/affine\.pro\)/, "bold link"],
  [/\*\*bold\*\*, \*italic\*, ~~strike~~/, "mixed formatting"],
  [/> .*\*\*bold\*\*.*\*italic\*/, "bold quote"],
  [/> \[!NOTE\]/, "callout"],
  [/> .*\*\*bold\*\*.*\*italic\*/, "bold callout"],
];

let passed = 0;
let failed = 0;
const createdDocs = [];

function check(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function checkMarkdown(markdown, label) {
  console.log(`\n  Checking ${label}:`);
  for (const [pattern, name] of EXPECTED_PATTERNS) {
    check(pattern.test(markdown), name);
  }
}

async function main() {
  const client = new Client({ name: "formatting-e2e", version: "1.0" });
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

  try {
    console.log("=== Formatting E2E Round-Trip Test ===\n");

    // ── 1. create_doc_from_markdown → export_doc_markdown ──────────────────
    console.log("1. create_doc_from_markdown → export_doc_markdown");
    const created = await call("create_doc_from_markdown", {
      workspaceId: WORKSPACE_ID,
      title: "e2e-formatting-source",
      markdown: SOURCE_MARKDOWN,
    });
    check(!!created.docId, `source doc created (${created.docId})`);
    createdDocs.push(created.docId);

    const exported = await call("export_doc_markdown", {
      workspaceId: WORKSPACE_ID,
      docId: created.docId,
    });
    checkMarkdown(exported.markdown, "export_doc_markdown round-trip");

    // ── 2. duplicate_doc → export_doc_markdown ─────────────────────────────
    console.log("\n2. duplicate_doc → export_doc_markdown");
    const duped = await call("duplicate_doc", {
      workspaceId: WORKSPACE_ID,
      docId: created.docId,
    });
    const dupedDocId = duped.newDocId ?? duped.docId;
    check(!!dupedDocId, `duplicate created (${dupedDocId})`);
    createdDocs.push(dupedDocId);

    const dupedExport = await call("export_doc_markdown", {
      workspaceId: WORKSPACE_ID,
      docId: dupedDocId,
    });
    checkMarkdown(dupedExport.markdown, "duplicate_doc round-trip");

    // ── 3. create_doc_from_template → export_doc_markdown ──────────────────
    console.log("\n3. create_doc_from_template → export_doc_markdown");
    const fromTemplate = await call("create_doc_from_template", {
      workspaceId: WORKSPACE_ID,
      templateDocId: created.docId,
      title: "e2e-formatting-from-template",
    });
    const templateDocId = fromTemplate.docId;
    check(!!templateDocId, `template doc created (${templateDocId})`);
    createdDocs.push(templateDocId);

    const templateExport = await call("export_doc_markdown", {
      workspaceId: WORKSPACE_ID,
      docId: templateDocId,
    });
    checkMarkdown(templateExport.markdown, "create_doc_from_template round-trip");

    // ── 4. append_markdown preserves inline formatting ─────────────────────
    console.log("\n4. append_markdown → export_doc_markdown");
    const appendDoc = await call("create_doc", {
      workspaceId: WORKSPACE_ID,
      title: "e2e-append-markdown-test",
    });
    check(!!appendDoc.docId, `append test doc created (${appendDoc.docId})`);
    createdDocs.push(appendDoc.docId);

    const APPEND_MARKDOWN = [
      "## Appended Section",
      "",
      "This is **bold** appended text.",
      "",
      "This is *italic* appended text.",
      "",
      "This is ***bold italic*** appended.",
      "",
      "This is ~~strikethrough~~ appended.",
      "",
      "See [appended link](https://affine.pro) here.",
      "",
      "See [**bold appended link**](https://affine.pro) here.",
      "",
      "> A **bold** appended quote.",
    ].join("\n");

    await call("append_markdown", {
      workspaceId: WORKSPACE_ID,
      docId: appendDoc.docId,
      markdown: APPEND_MARKDOWN,
    });

    const appendExport = await call("export_doc_markdown", {
      workspaceId: WORKSPACE_ID,
      docId: appendDoc.docId,
    });
    console.log(`\n  Checking append_markdown round-trip:`);
    check(/\*\*bold\*\* appended text/.test(appendExport.markdown), "bold preserved after append");
    check(/\*italic\* appended text/.test(appendExport.markdown), "italic preserved after append");
    check(/\*\*\*bold italic\*\*\* appended/.test(appendExport.markdown), "bold italic preserved after append");
    check(/~~strikethrough~~ appended/.test(appendExport.markdown), "strikethrough preserved after append");
    check(/\[appended link\]\(https:\/\/affine\.pro\)/.test(appendExport.markdown), "plain link preserved after append");
    check(/\[\*\*bold appended link\*\*\]\(https:\/\/affine\.pro\)/.test(appendExport.markdown), "bold link preserved after append");
    check(/> .*\*\*bold\*\*.*appended quote/.test(appendExport.markdown), "bold quote preserved after append");

    // ── 5. find_and_replace preserves inline attrs ──────────────────────────
    console.log("\n5. find_and_replace preserves inline formatting attrs");
    await call("find_and_replace", {
      workspaceId: WORKSPACE_ID,
      docId: created.docId,
      search: "bold",
      replace: "strong",
      matchAll: true,
    });

    const afterReplace = await call("export_doc_markdown", {
      workspaceId: WORKSPACE_ID,
      docId: created.docId,
    });
    check(!afterReplace.markdown.includes("**bold**"), "original 'bold' replaced");
    check(afterReplace.markdown.includes("**strong**"), "replacement 'strong' is bold");
    check(afterReplace.markdown.includes("*italic*"), "italic attrs unaffected by replace");
    check(afterReplace.markdown.includes("~~strikethrough~~"), "strikethrough unaffected by replace");

    // ── Cleanup ─────────────────────────────────────────────────────────────
    console.log("\nCleaning up test docs...");
    for (const docId of createdDocs) {
      try {
        await call("delete_doc", { workspaceId: WORKSPACE_ID, docId });
        console.log(`  deleted ${docId}`);
      } catch {
        console.log(`  could not delete ${docId} (may be fine)`);
      }
    }

  } finally {
    await client.close();
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log("\n=== All formatting E2E checks passed ===");
}

main().catch(err => { console.error(err); process.exit(1); });
