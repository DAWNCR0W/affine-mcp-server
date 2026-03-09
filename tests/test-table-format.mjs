/**
 * Unit tests for table creation and extraction (flat-key format).
 *
 * Exercises the real production code from dist/util/table.js.
 * Run `npm run build` first, then: node tests/test-table-format.mjs
 *
 * Covers:
 *   1. New flat-key format creation & extraction
 *   2. Flat-key format survives Y.js encode/decode
 *   3. Legacy nested format reading
 *   4. Mixed old/new format reading (merges both)
 *   5. Empty table returns null
 *   6. Flat-key takes precedence over legacy
 *   7. Non-string order values are coerced
 */
import * as Y from "yjs";
import { makeText, extractTableData } from "../dist/util/table.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ── Helper: build flat-key table block ─────────────────────────────

function buildFlatKeyBlock(tableData) {
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const block = new Y.Map();
  const blockId = "flat-test";

  block.set("sys:id", blockId);
  block.set("sys:flavour", "affine:table");
  block.set("sys:children", new Y.Array());

  const rowIds = [];
  const colIds = [];
  const numRows = tableData.length;
  const numCols = tableData[0].length;

  for (let i = 0; i < numRows; i++) {
    const rowId = `r_${i}`;
    block.set(`prop:rows.${rowId}.rowId`, rowId);
    block.set(`prop:rows.${rowId}.order`, `r${String(i).padStart(4, "0")}`);
    rowIds.push(rowId);
  }
  for (let j = 0; j < numCols; j++) {
    const colId = `c_${j}`;
    block.set(`prop:columns.${colId}.columnId`, colId);
    block.set(`prop:columns.${colId}.order`, `c${String(j).padStart(4, "0")}`);
    colIds.push(colId);
  }
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      block.set(`prop:cells.${rowIds[r]}:${colIds[c]}.text`, makeText(tableData[r][c]));
    }
  }

  blocks.set(blockId, block);
  return { doc, block: blocks.get(blockId) };
}

// ── Helper: build legacy nested table block ────────────────────────

function buildLegacyBlock(tableData) {
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const block = new Y.Map();
  const blockId = "legacy-test";

  block.set("sys:id", blockId);
  block.set("sys:flavour", "affine:table");

  const rows = {};
  const columns = {};
  const cells = {};
  const numRows = tableData.length;
  const numCols = tableData[0].length;
  const rowIds = [];
  const colIds = [];

  for (let i = 0; i < numRows; i++) {
    const rowId = `r_${i}`;
    rows[rowId] = { rowId, order: `r${String(i).padStart(4, "0")}` };
    rowIds.push(rowId);
  }
  for (let j = 0; j < numCols; j++) {
    const colId = `c_${j}`;
    columns[colId] = { columnId: colId, order: `c${String(j).padStart(4, "0")}` };
    colIds.push(colId);
  }
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      cells[`${rowIds[r]}:${colIds[c]}`] = { text: tableData[r][c] };
    }
  }

  block.set("prop:rows", rows);
  block.set("prop:columns", columns);
  block.set("prop:cells", cells);

  blocks.set(blockId, block);
  return { doc, block: blocks.get(blockId) };
}

// ════════════════════════════════════════════════════════════════════
// Test 1: New flat-key format creation & extraction
// ════════════════════════════════════════════════════════════════════
console.log("=== Test 1: Flat-key format creation & extraction ===");
{
  const data = [
    ["Header1", "Header2", "Header3"],
    ["A", "B", "C"],
    ["D", "E", "F"],
  ];
  const { block } = buildFlatKeyBlock(data);
  const result = extractTableData(block);

  assert(result !== null, "extractTableData should return non-null for flat-key block");
  assertEqual(result, data, "extractTableData should return correct table data");
}

// ════════════════════════════════════════════════════════════════════
// Test 2: Flat-key format survives Y.js encode/decode
// ════════════════════════════════════════════════════════════════════
console.log("=== Test 2: Flat-key format survives encode/decode ===");
{
  const data = [
    ["Name", "Score"],
    ["Alice", "100"],
    ["Bob", "95"],
  ];
  const { doc } = buildFlatKeyBlock(data);

  const update = Y.encodeStateAsUpdate(doc);
  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, update);
  const block2 = doc2.getMap("blocks").get("flat-test");

  let cellCount = 0;
  let allYText = true;
  for (const key of block2.keys()) {
    if (key.startsWith("prop:cells.") && key.endsWith(".text")) {
      cellCount++;
      if (!(block2.get(key) instanceof Y.Text)) allYText = false;
    }
  }
  assert(cellCount === 6, `Expected 6 cells, got ${cellCount}`);
  assert(allYText, "All cell values should be Y.Text after encode/decode");

  const result = extractTableData(block2);
  assertEqual(result, data, "extractTableData should work after encode/decode");
}

// ════════════════════════════════════════════════════════════════════
// Test 3: Legacy nested format reading
// ════════════════════════════════════════════════════════════════════
console.log("=== Test 3: Legacy nested format reading ===");
{
  const data = [
    ["Old1", "Old2"],
    ["X", "Y"],
  ];
  const { block } = buildLegacyBlock(data);
  const result = extractTableData(block);

  assert(result !== null, "extractTableData should return non-null for legacy block");
  assertEqual(result, data, "extractTableData should correctly read legacy format");
}

// ════════════════════════════════════════════════════════════════════
// Test 4: Mixed old/new format reading (merges both)
// ════════════════════════════════════════════════════════════════════
console.log("=== Test 4: Mixed old/new format (merges both) ===");
{
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const block = new Y.Map();
  const blockId = "mixed-test";

  block.set("sys:id", blockId);
  block.set("sys:flavour", "affine:table");

  block.set("prop:rows.r_0.rowId", "r_0");
  block.set("prop:rows.r_0.order", "r0000");
  block.set("prop:rows", { r_1: { rowId: "r_1", order: "r0001" } });

  block.set("prop:columns.c_0.columnId", "c_0");
  block.set("prop:columns.c_0.order", "c0000");
  block.set("prop:columns", { c_1: { columnId: "c_1", order: "c0001" } });

  block.set("prop:cells.r_0:c_0.text", makeText("flat"));
  block.set("prop:cells", {
    "r_1:c_0": { text: "legacy-r1c0" },
    "r_0:c_1": { text: "legacy-r0c1" },
    "r_1:c_1": { text: "legacy-r1c1" },
  });

  blocks.set(blockId, block);
  const b = blocks.get(blockId);
  const result = extractTableData(b);

  assert(result !== null, "extractTableData should return non-null for mixed block");
  assert(result.length === 2, `Expected 2 rows, got ${result?.length}`);
  assert(result[0].length === 2, `Expected 2 cols, got ${result?.[0]?.length}`);
  assertEqual(result[0][0], "flat", "flat-key cell should be 'flat'");
  assertEqual(result[0][1], "legacy-r0c1", "legacy cell (r0,c1) should be 'legacy-r0c1'");
  assertEqual(result[1][0], "legacy-r1c0", "legacy cell (r1,c0) should be 'legacy-r1c0'");
  assertEqual(result[1][1], "legacy-r1c1", "legacy cell (r1,c1) should be 'legacy-r1c1'");
}

// ════════════════════════════════════════════════════════════════════
// Test 5: Empty table returns null
// ════════════════════════════════════════════════════════════════════
console.log("=== Test 5: Empty table returns null ===");
{
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const block = new Y.Map();
  block.set("sys:flavour", "affine:table");
  blocks.set("empty", block);
  const result = extractTableData(blocks.get("empty"));
  assert(result === null, "extractTableData should return null for empty table");
}

// ════════════════════════════════════════════════════════════════════
// Test 6: Flat-key takes precedence over legacy
// ════════════════════════════════════════════════════════════════════
console.log("=== Test 6: Flat-key takes precedence over legacy ===");
{
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const block = new Y.Map();

  block.set("sys:flavour", "affine:table");

  block.set("prop:rows.r_0.rowId", "r_0");
  block.set("prop:rows.r_0.order", "r0000");
  block.set("prop:rows", { r_0: { rowId: "r_0", order: "r9999" } });

  block.set("prop:columns.c_0.columnId", "c_0");
  block.set("prop:columns.c_0.order", "c0000");
  block.set("prop:columns", { c_0: { columnId: "c_0", order: "c9999" } });

  block.set("prop:cells.r_0:c_0.text", makeText("flat-wins"));
  block.set("prop:cells", { "r_0:c_0": { text: "legacy-loses" } });

  blocks.set("precedence", block);
  const result = extractTableData(blocks.get("precedence"));

  assert(result !== null, "result should not be null");
  assertEqual(result[0][0], "flat-wins", "flat-key cell value should take precedence");
}

// ════════════════════════════════════════════════════════════════════
// Test 7: Non-string order values are coerced instead of dropped
// ════════════════════════════════════════════════════════════════════
console.log("=== Test 7: Non-string order values coerced ===");
{
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const block = new Y.Map();

  block.set("sys:flavour", "affine:table");

  block.set("prop:rows.r_0.rowId", "r_0");
  block.set("prop:rows.r_0.order", 0);

  block.set("prop:columns.c_0.columnId", "c_0");
  block.set("prop:columns.c_0.order", 0);

  block.set("prop:cells.r_0:c_0.text", makeText("coerced"));

  blocks.set("coerce-test", block);
  const result = extractTableData(blocks.get("coerce-test"));

  assert(result !== null, "result should not be null when order is numeric");
  assertEqual(result[0][0], "coerced", "cell value should be readable despite numeric order");
}

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("✅ All tests passed!");
  process.exit(0);
} else {
  console.log("❌ Some tests failed.");
  process.exit(1);
}
