#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) {
  throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
}

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

function expectArrayEqual(actual, expected, message) {
  const sameLength = Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length;
  const sameValues = sameLength && actual.every((value, index) => value === expected[index]);
  if (!sameValues) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function blockById(blocks, id) {
  return blocks.find(block => block?.id === id) || null;
}

function blockText(block) {
  return block?.text ?? null;
}

function blockType(block) {
  return block?.type ?? null;
}

function childIds(block) {
  return Array.isArray(block?.childIds) ? block.childIds : [];
}

async function main() {
  console.log("=== Semantic Page Composer Test ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);

  const client = new Client({ name: "affine-mcp-semantic-page-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-semantic-page",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
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
    const workspace = await call("create_workspace", { name: `semantic-page-${Date.now()}` });
    expectTruthy(workspace?.id, "create_workspace id");

    const parent = await call("create_doc", {
      workspaceId: workspace.id,
      title: "Semantic Parent",
      content: "",
    });
    expectTruthy(parent?.docId, "create_doc docId");

    const created = await call("create_semantic_page", {
      workspaceId: workspace.id,
      title: "Weekly Sync",
      pageType: "meeting_notes",
      parentDocId: parent.docId,
      sections: [
        {
          title: "Overview",
          paragraphs: ["Project is on schedule."],
        },
        {
          title: "Decisions",
          bullets: ["Ship the first pass."],
        },
        {
          title: "Risks",
          paragraphs: ["Need to confirm the editor intent."],
        },
      ],
    });

    expectTruthy(created?.docId, "create_semantic_page docId");
    expectTruthy(created?.pageId, "create_semantic_page pageId");
    expectTruthy(created?.noteId, "create_semantic_page noteId");
    expectEqual(created?.sectionCount, 3, "create_semantic_page sectionCount");
    expectEqual(created?.parentLinked, true, "create_semantic_page parentLinked");
    expectEqual(Array.isArray(created?.warnings) ? created.warnings.length : -1, 0, "create_semantic_page warnings");

    const parentChildren = await call("list_children", {
      workspaceId: workspace.id,
      docId: parent.docId,
    });
    const parentChildIds = Array.isArray(parentChildren?.children)
      ? parentChildren.children.map(child => child?.docId)
      : [];
    expectArrayEqual(parentChildIds, [created.docId], "parent doc sidebar children");

    const readCreated = await call("read_doc", {
      workspaceId: workspace.id,
      docId: created.docId,
    });
    const blocks = Array.isArray(readCreated?.blocks) ? readCreated.blocks : [];
    const note = blocks.find(block => block?.flavour === "affine:note");
    expectTruthy(note, "semantic page note block");

    const noteChildren = childIds(note);
    expectEqual(noteChildren.length, 6, "semantic page initial child count");
    expectEqual(created.blockIds.length, 6, "semantic page initial block id count");

    const overviewHeading = blockById(blocks, noteChildren[0]);
    const overviewParagraph = blockById(blocks, noteChildren[1]);
    const decisionsHeading = blockById(blocks, noteChildren[2]);
    const decisionsList = blockById(blocks, noteChildren[3]);
    const risksHeading = blockById(blocks, noteChildren[4]);
    const risksParagraph = blockById(blocks, noteChildren[5]);

    expectEqual(blockType(overviewHeading), "h2", "overview heading type");
    expectEqual(blockText(overviewHeading), "Overview", "overview heading text");
    expectEqual(blockType(overviewParagraph), "text", "overview paragraph type");
    expectEqual(blockText(overviewParagraph), "Project is on schedule.", "overview paragraph text");
    expectEqual(blockType(decisionsHeading), "h2", "decisions heading type");
    expectEqual(blockText(decisionsHeading), "Decisions", "decisions heading text");
    expectEqual(blockType(decisionsList), "bulleted", "decisions list type");
    expectEqual(blockText(decisionsList), "Ship the first pass.", "decisions list text");
    expectEqual(blockType(risksHeading), "h2", "risks heading type");
    expectEqual(blockText(risksHeading), "Risks", "risks heading text");
    expectEqual(blockType(risksParagraph), "text", "risks paragraph type");
    expectEqual(blockText(risksParagraph), "Need to confirm the editor intent.", "risks paragraph text");

    const appended = await call("append_semantic_section", {
      workspaceId: workspace.id,
      docId: created.docId,
      afterSectionTitle: "Overview",
      sectionTitle: "Follow Up",
      paragraphs: ["The API shape is confirmed."],
      bullets: ["Validate the receipts."],
    });
    expectTruthy(appended?.sectionHeadingId, "append_semantic_section sectionHeadingId");
    expectEqual(appended?.appendedCount, 3, "append_semantic_section appendedCount");

    const readAfterAppend = await call("read_doc", {
      workspaceId: workspace.id,
      docId: created.docId,
    });
    const appendedBlocks = Array.isArray(readAfterAppend?.blocks) ? readAfterAppend.blocks : [];
    const appendedNote = appendedBlocks.find(block => block?.flavour === "affine:note");
    expectTruthy(appendedNote, "semantic page note block after append");

    const appendedChildren = childIds(appendedNote);
    expectEqual(appendedChildren.length, 9, "semantic page child count after append");
    const appendedOverviewHeading = blockById(appendedBlocks, appendedChildren[0]);
    const appendedOverviewParagraph = blockById(appendedBlocks, appendedChildren[1]);
    const appendedFollowUpHeading = blockById(appendedBlocks, appendedChildren[2]);
    const appendedFollowUpParagraph = blockById(appendedBlocks, appendedChildren[3]);
    const appendedFollowUpList = blockById(appendedBlocks, appendedChildren[4]);
    const appendedDecisionsHeading = blockById(appendedBlocks, appendedChildren[5]);
    const appendedDecisionsList = blockById(appendedBlocks, appendedChildren[6]);
    const appendedRisksHeading = blockById(appendedBlocks, appendedChildren[7]);
    const appendedRisksParagraph = blockById(appendedBlocks, appendedChildren[8]);

    expectEqual(blockText(appendedOverviewHeading), "Overview", "overview heading text after append");
    expectEqual(blockText(appendedOverviewParagraph), "Project is on schedule.", "overview paragraph text after append");
    expectEqual(blockText(appendedFollowUpHeading), "Follow Up", "follow-up heading text");
    expectEqual(blockType(appendedFollowUpParagraph), "text", "follow-up paragraph type");
    expectEqual(blockText(appendedFollowUpParagraph), "The API shape is confirmed.", "follow-up paragraph text");
    expectEqual(blockType(appendedFollowUpList), "bulleted", "follow-up list type");
    expectEqual(blockText(appendedFollowUpList), "Validate the receipts.", "follow-up list text");
    expectEqual(blockText(appendedDecisionsHeading), "Decisions", "decisions heading text after append");
    expectEqual(blockText(appendedDecisionsList), "Ship the first pass.", "decisions list text after append");
    expectEqual(blockText(appendedRisksHeading), "Risks", "risks heading text after append");
    expectEqual(blockText(appendedRisksParagraph), "Need to confirm the editor intent.", "risks paragraph text after append");

    console.log("=== Semantic page composer test passed ===");
  } finally {
    await transport.close();
  }
}

main().catch(error => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
