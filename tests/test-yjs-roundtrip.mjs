#!/usr/bin/env node
/**
 * Unit tests for the full local Yjs formatting round-trip:
 *
 *   markdown → parseMarkdownToOperations (TextDelta[])
 *           → makeText (Y.Text with explicit mark clearing)
 *           → Y.Text.toDelta() (read back)
 *           → renderBlocksToMarkdown (markdown)
 *
 * No network required. Covers:
 *   - Mark bleeding fix: bold must not bleed into following plain runs
 *   - find_and_replace attr preservation: replacing inside a bold run keeps bold
 *   - Link text escaping: ] in link text is escaped on export
 *   - Full round-trip fidelity for bold, italic, strike, code, links, quotes, callouts
 */

import * as Y from "yjs";
import { parseMarkdownToOperations } from "../dist/markdown/parse.js";
import { renderBlocksToMarkdown, deltasToMarkdown } from "../dist/markdown/render.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

// ── Helpers replicating docs.ts internals ────────────────────────────────────

const CLEARED_MARKS = { bold: null, italic: null, strike: null, code: null, link: null };

function makeText(content) {
  // Y.Text must be attached to a Y.Doc before any read/write operations.
  const doc = new Y.Doc();
  const yText = doc.getText("t");
  if (typeof content === "string") {
    if (content.length > 0) yText.insert(0, content);
  } else {
    let offset = 0;
    for (const delta of content) {
      if (delta.insert.length > 0) {
        const attrs = delta.attributes
          ? { ...CLEARED_MARKS, ...delta.attributes }
          : { ...CLEARED_MARKS };
        yText.insert(offset, delta.insert, attrs);
        offset += delta.insert.length;
      }
    }
  }
  return yText;
}

function asDeltaArray(yText) {
  const raw = yText.toDelta();
  if (!raw.length) return undefined;
  const result = [];
  for (const d of raw) {
    if (typeof d.insert !== "string") continue;
    const td = { insert: d.insert };
    if (d.attributes) {
      const attrs = {};
      if (d.attributes.bold === true) attrs.bold = true;
      if (d.attributes.italic === true) attrs.italic = true;
      if (d.attributes.strike === true) attrs.strike = true;
      if (d.attributes.code === true) attrs.code = true;
      if (typeof d.attributes.link === "string") attrs.link = d.attributes.link;
      if (Object.keys(attrs).length > 0) td.attributes = attrs;
    }
    result.push(td);
  }
  return result.length ? result : undefined;
}

// Build a MarkdownRenderableBlock map from a markdown string for renderBlocksToMarkdown
function buildRenderInput(markdown) {
  const { operations } = parseMarkdownToOperations(markdown);
  const blocksById = new Map();
  const rootBlockIds = [];
  for (const op of operations) {
    if (!op.text && !op.deltas) continue;
    const id = Math.random().toString(36).slice(2);
    rootBlockIds.push(id);
    // Write deltas through Yjs and read back
    const yText = op.deltas ? makeText(op.deltas) : makeText(op.text ?? "");
    const deltas = asDeltaArray(yText);
    blocksById.set(id, {
      id,
      parentId: null,
      flavour: op.type === "heading" ? "affine:paragraph" : op.type === "quote" ? "affine:paragraph" : op.type === "callout" ? "affine:callout" : "affine:paragraph",
      type: op.type === "heading" ? `h${op.level}` : op.type === "quote" ? "quote" : "text",
      text: yText.toString(),
      deltas,
      checked: null,
      language: null,
      childIds: [],
      url: null,
      sourceId: null,
      caption: null,
      tableData: null,
    });
  }
  return { rootBlockIds, blocksById };
}

// ── Test 1: Mark bleeding ─────────────────────────────────────────────────────

console.log("\nTest 1: Mark bleeding — bold must not bleed into adjacent plain runs");
{
  const deltas = [
    { insert: "Hello " },
    { insert: "bold", attributes: { bold: true } },
    { insert: " and plain" },
  ];
  const yText = makeText(deltas);
  const stored = yText.toDelta();

  const boldRun = stored.find(d => d.attributes?.bold === true);
  const plainAfter = stored.find(d => d.insert === " and plain");

  assert(boldRun?.insert === "bold", "bold run contains only 'bold'");
  assert(!plainAfter?.attributes?.bold, "plain run after bold has no bold attr");
  assert(stored.length === 3, "stored as exactly 3 separate runs");
}

// ── Test 2: find_and_replace attr preservation ────────────────────────────────

console.log("\nTest 2: find_and_replace — replacing inside a bold run preserves bold");
{
  const deltas = [
    { insert: "Hello " },
    { insert: "bold", attributes: { bold: true } },
    { insert: " world" },
  ];
  const yText = makeText(deltas);

  const original = yText.toString();
  const search = "bold";
  const replace = "strong";

  // Replicate find_and_replace logic with attr preservation
  const deltaRuns = yText.toDelta();
  const pos = original.indexOf(search);
  let cur = 0;
  let matchAttrs;
  for (const run of deltaRuns) {
    if (pos < cur + run.insert.length) { matchAttrs = run.attributes; break; }
    cur += run.insert.length;
  }
  yText.delete(pos, search.length);
  if (matchAttrs && Object.keys(matchAttrs).length > 0) {
    yText.insert(pos, replace, matchAttrs);
  } else {
    yText.insert(pos, replace);
  }

  const result = yText.toDelta();
  const replacedRun = result.find(d => d.insert === "strong");
  assert(replacedRun !== undefined, "replacement text 'strong' exists");
  assert(replacedRun?.attributes?.bold === true, "replacement run is bold");
  assert(yText.toString() === "Hello strong world", "text content is correct");
}

// ── Test 3: Link text ] escaping ──────────────────────────────────────────────

console.log("\nTest 3: Link text ] escaping on export");
{
  // Simulate a block where AFFiNE stored a link with ] in the text
  const deltas = [{ insert: "close]bracket", attributes: { link: "https://example.com" } }];
  const blocksById = new Map([["id1", {
    id: "id1", parentId: null, flavour: "affine:paragraph", type: "text",
    text: "close]bracket", deltas, checked: null, language: null,
    childIds: [], url: null, sourceId: null, caption: null, tableData: null,
  }]]);
  const { markdown } = renderBlocksToMarkdown({ rootBlockIds: ["id1"], blocksById });
  assert(markdown.includes("\\]"), "exported markdown escapes ] in link text");
  assert(!markdown.match(/\[close\]bracket\]\([^)]+\)\)/), "no double-close-bracket in output");
}

// ── Test 4: Full round-trip — all formatting types ───────────────────────────

console.log("\nTest 4: Full round-trip fidelity");
{
  const cases = [
    { label: "bold", md: "This is **bold** text", expect: /\*\*bold\*\*/ },
    { label: "italic", md: "This is *italic* text", expect: /\*italic\*/ },
    { label: "bold italic", md: "This is ***bold italic*** text", expect: /\*\*\*bold italic\*\*\*/ },
    { label: "strikethrough", md: "This is ~~strike~~ text", expect: /~~strike~~/ },
    { label: "plain link", md: "See [AFFiNE](https://affine.pro) here", expect: /\[AFFiNE\]\(https:\/\/affine\.pro\)/ },
    { label: "bold link", md: "See [**bold**](https://affine.pro) here", expect: /\[\*\*bold\*\*\]\(https:\/\/affine\.pro\)/ },
    { label: "bold mid-sentence no bleed", md: "Hello **bold** and plain", expect: /Hello \*\*bold\*\* and plain/ },
  ];

  for (const { label, md, expect } of cases) {
    const input = buildRenderInput(md);
    const { markdown } = renderBlocksToMarkdown(input);
    assert(expect.test(markdown), `${label}: "${md}" → "${markdown.trim()}"`);
  }
}

// ── Test 5: Quote and callout round-trip ──────────────────────────────────────

console.log("\nTest 5: Quote and callout formatting preserved through Yjs");
{
  // Parse a bold quote
  const { operations: quoteOps } = parseMarkdownToOperations("> This is a **bold** quote");
  const quoteOp = quoteOps.find(op => op.type === "quote");
  assert(quoteOp !== undefined, "quote operation parsed");
  assert(quoteOp?.deltas?.some(d => d.attributes?.bold), "quote deltas contain bold run");

  // Write through Yjs and read back
  const yText = makeText(quoteOp.deltas);
  const stored = asDeltaArray(yText);
  assert(stored?.some(d => d.attributes?.bold), "bold survives Yjs write/read for quote");

  // Parse a bold callout
  const { operations: calloutOps } = parseMarkdownToOperations("> [!NOTE]\n> **bold callout** text");
  const calloutOp = calloutOps.find(op => op.type === "callout");
  assert(calloutOp !== undefined, "callout operation parsed");
  assert(calloutOp?.deltas?.some(d => d.attributes?.bold), "callout deltas contain bold run");
}

// ── Test 6: Nested bold+italic — markers must not double up at run boundaries ─

console.log("\nTest 6: Nested bold+italic — markers must not double up at run boundaries");
{
  // [bold] [bold+italic] [bold] → "**text *inner* text**"
  const r1 = deltasToMarkdown([
    { insert: "Bold and " , attributes: { bold: true } },
    { insert: "italic"    , attributes: { bold: true, italic: true } },
    { insert: " combined" , attributes: { bold: true } },
  ]);
  assert(r1 === "**Bold and *italic* combined**", `bold-contains-italic: got "${r1}"`);
  assert(!r1.includes("*****"), "no ***** artifacts");

  // [italic] [bold+italic] [italic] → "*text **inner** text*"
  const r2 = deltasToMarkdown([
    { insert: "Italic with ", attributes: { italic: true } },
    { insert: "bold"        , attributes: { bold: true, italic: true } },
    { insert: " inside"     , attributes: { italic: true } },
  ]);
  assert(r2 === "*Italic with **bold** inside*", `italic-contains-bold: got "${r2}"`);
  assert(!r2.includes("*****"), "no ***** artifacts");

  // [bold] [plain] [bold] — two separate bold runs must not merge
  const r3 = deltasToMarkdown([
    { insert: "first" , attributes: { bold: true } },
    { insert: " plain " },
    { insert: "second", attributes: { bold: true } },
  ]);
  assert(r3 === "**first** plain **second**", `two separate bold runs: got "${r3}"`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
