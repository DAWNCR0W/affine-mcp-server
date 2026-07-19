#!/usr/bin/env node
// Unit test for LinkedPage inline reference support in the Markdown
// import/export pipeline. Runs against dist/ and needs no AFFiNE server.
import { parseMarkdownToOperations } from "../dist/markdown/parse.js";
import { renderBlocksToMarkdown } from "../dist/markdown/render.js";

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function referenceDeltas(operation) {
  return (operation.deltas ?? []).filter(delta => delta.attributes?.reference);
}

// 1. Inline LinkedPage link becomes a native reference delta.
{
  const parsed = parseMarkdownToOperations("See [Moi](LinkedPage:abc123) for details.");
  expect(parsed.operations.length === 1, "expected a single operation");
  const [op] = parsed.operations;
  expect(op.type === "paragraph", `expected paragraph, got ${op.type}`);
  const refs = referenceDeltas(op);
  expect(refs.length === 1, `expected one reference delta, got ${refs.length}`);
  expect(refs[0].insert === "​", "reference delta must use a zero-width insert");
  const reference = refs[0].attributes.reference;
  expect(reference.type === "LinkedPage", `expected LinkedPage type, got ${reference.type}`);
  expect(reference.pageId === "abc123", `expected pageId abc123, got ${reference.pageId}`);
  expect(op.text.includes("See"), "surrounding text must be preserved");
}

// 2. A paragraph that is only a LinkedPage link stays a paragraph (no bookmark).
{
  const parsed = parseMarkdownToOperations("[Moi](LinkedPage:abc123)");
  expect(parsed.operations.length === 1, "expected a single operation");
  const [op] = parsed.operations;
  expect(op.type === "paragraph", `standalone LinkedPage link must not become a bookmark, got ${op.type}`);
  expect(referenceDeltas(op).length === 1, "expected one reference delta");
}

// 3. Regular links keep their existing behavior.
{
  const inline = parseMarkdownToOperations("See [docs](https://example.com) for details.");
  const linkDelta = (inline.operations[0].deltas ?? []).find(delta => delta.attributes?.link);
  expect(linkDelta !== undefined, "regular inline link must keep the link attribute");
  expect(linkDelta.attributes.link === "https://example.com", "regular link href must be preserved");
  expect(referenceDeltas(inline.operations[0]).length === 0, "regular link must not create a reference");

  const standalone = parseMarkdownToOperations("[docs](https://example.com)");
  expect(standalone.operations[0].type === "bookmark", "standalone regular link must stay a bookmark");
}

// 4. Empty page id falls back to regular link handling.
{
  const parsed = parseMarkdownToOperations("Broken [ref](LinkedPage:) link.");
  expect(referenceDeltas(parsed.operations[0]).length === 0, "empty page id must not create a reference");
}

// 5. Export serializes references back to the LinkedPage scheme.
{
  const blocks = new Map();
  blocks.set("note1", {
    id: "note1", parentId: null, flavour: "affine:note", type: null, text: null,
    checked: null, language: null, childIds: ["para1"], url: null, sourceId: null,
    caption: null, tableData: null,
  });
  blocks.set("para1", {
    id: "para1", parentId: "note1", flavour: "affine:paragraph", type: "text", text: "See ​ for details.",
    checked: null, language: null, childIds: [], url: null, sourceId: null,
    caption: null, tableData: null,
    textDeltas: [
      { insert: "See " },
      { insert: "​", attributes: { reference: { type: "LinkedPage", pageId: "abc123" } } },
      { insert: " for details." },
    ],
  });
  const rendered = renderBlocksToMarkdown({ rootBlockIds: ["note1"], blocksById: blocks });
  expect(
    rendered.markdown.includes("[abc123](LinkedPage:abc123)"),
    `export must serialize the reference, got: ${rendered.markdown}`,
  );
  expect(
    !rendered.warnings.some(warning => warning.includes("reference")),
    `export must not report a reference loss, got: ${rendered.warnings.join(" | ")}`,
  );

  // 6. Round-trip: exported markdown re-imports as the same reference.
  const reparsed = parseMarkdownToOperations(rendered.markdown);
  const refs = referenceDeltas(reparsed.operations[0]);
  expect(refs.length === 1, "round-trip must preserve the reference");
  expect(refs[0].attributes.reference.pageId === "abc123", "round-trip must preserve the page id");
}

console.log("test-markdown-linked-page: all assertions passed");
