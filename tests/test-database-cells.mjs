#!/usr/bin/env node
/**
 * Comprehensive live integration test for issue #50.
 *
 * Covers:
 * - `Title`-based row creation writing the built-in Kanban title
 * - `read_database_cells` for all supported column types
 * - row and column filtering by name / ID
 * - `update_database_cell` across all supported column types
 * - `update_database_row` batch updates
 * - `delete_database_row` removes rows cleanly from the database block
 * - select / multi-select option auto-create behavior and strict failure mode
 *
 * Outputs tests/test-database-cells-state.json for UI verification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const STATE_OUTPUT_PATH = path.resolve(__dirname, 'test-database-cells-state.json');

const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error('AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh');
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertResult(toolName, result) {
  if (result?.isError) {
    throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
  }
  const parsed = parseContent(result);
  if (parsed && typeof parsed === 'object' && parsed.error) {
    throw new Error(`${toolName} failed: ${parsed.error}`);
  }
  if (typeof parsed === 'string' && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
    throw new Error(`${toolName} failed: ${parsed}`);
  }
  return parsed;
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectArrayEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

async function main() {
  console.log('=== Database Cell Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-db-cells-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-noconfig',
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  const settle = (ms = 800) => new Promise(resolve => setTimeout(resolve, ms));

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const parsed = assertResult(toolName, result);
    console.log('    ✓ OK');
    return parsed;
  }

  async function expectToolFailure(toolName, args, expectedMessagePart) {
    console.log(`  → ${toolName}(${JSON.stringify(args)}) [expect failure]`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const text = result?.content?.[0]?.text || '';
    if (!result?.isError) {
      throw new Error(`${toolName} was expected to fail but succeeded`);
    }
    if (!text.includes(expectedMessagePart)) {
      throw new Error(`${toolName} failure mismatch: expected message containing ${JSON.stringify(expectedMessagePart)}, got ${JSON.stringify(text)}`);
    }
    console.log('    ✓ Failed as expected');
  }

  const state = {
    baseUrl: BASE_URL,
    email: EMAIL,
    workspaceId: null,
    workspaceName: null,
    docId: null,
    docTitle: null,
    databaseBlockId: null,
    rowBlockIds: [],
    columnIds: {},
    finalRows: [],
  };

  const initialDates = {
    row1: Date.UTC(2026, 2, 10, 9, 0, 0),
    row2: Date.UTC(2026, 2, 11, 15, 30, 0),
  };

  const updatedDates = {
    row1: Date.UTC(2026, 2, 12, 10, 15, 0),
    row2: Date.UTC(2026, 2, 13, 11, 45, 0),
  };

  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const requiredTools = ['add_database_row', 'delete_database_row', 'read_database_cells', 'update_database_cell', 'update_database_row'];
    for (const toolName of requiredTools) {
      if (!tools.tools.some(tool => tool.name === toolName)) {
        throw new Error(`Expected tool "${toolName}" to be registered`);
      }
    }

    const timestamp = Date.now();
    state.workspaceName = `db-cells-test-${timestamp}`;
    state.docTitle = 'Database Cell Test';

    const workspace = await call('create_workspace', { name: state.workspaceName });
    state.workspaceId = workspace?.id;
    if (!state.workspaceId) throw new Error('create_workspace did not return workspace id');

    const doc = await call('create_doc', {
      workspaceId: state.workspaceId,
      title: state.docTitle,
      content: '',
    });
    state.docId = doc?.docId;
    if (!state.docId) throw new Error('create_doc did not return docId');

    const dbBlock = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'database',
    });
    state.databaseBlockId = dbBlock?.blockId;
    if (!state.databaseBlockId) throw new Error('append_block(database) did not return blockId');
    await settle();

    const columns = [
      { key: 'Title', name: 'Title', type: 'rich-text' },
      { key: 'Owner', name: 'Owner', type: 'rich-text' },
      { key: 'Stage', name: 'Stage', type: 'select', options: ['Todo', 'In Progress', 'Done'] },
      { key: 'Labels', name: 'Labels', type: 'multi-select', options: ['Backend', 'Frontend', 'Urgent'] },
      { key: 'Estimate', name: 'Estimate', type: 'number' },
      { key: 'Done', name: 'Done', type: 'checkbox' },
      { key: 'Due', name: 'Due', type: 'date' },
      { key: 'Link', name: 'Link', type: 'link' },
    ];

    for (const column of columns) {
      const result = await call('add_database_column', {
        workspaceId: state.workspaceId,
        docId: state.docId,
        databaseBlockId: state.databaseBlockId,
        name: column.name,
        type: column.type,
        ...(column.options ? { options: column.options } : {}),
      });
      state.columnIds[column.key] = result?.columnId || null;
      await settle();
    }

    const rowInputs = [
      {
        Title: 'Card Alpha',
        Owner: 'Alice',
        Stage: 'In Progress',
        Labels: ['Backend'],
        Estimate: 5,
        Done: false,
        Due: initialDates.row1,
        Link: 'https://example.com/alpha',
      },
      {
        Title: 'Card Beta',
        Owner: 'Bob',
        Stage: 'Todo',
        Labels: ['Frontend', 'Urgent'],
        Estimate: 3,
        Done: true,
        Due: initialDates.row2,
        Link: 'https://example.com/beta',
      },
    ];

    for (const rowInput of rowInputs) {
      const row = await call('add_database_row', {
        workspaceId: state.workspaceId,
        docId: state.docId,
        databaseBlockId: state.databaseBlockId,
        cells: rowInput,
      });
      state.rowBlockIds.push(row?.rowBlockId || null);
      await settle(1200);
    }

    const readAfterAdd = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    for (let i = 0; i < state.rowBlockIds.length; i++) {
      const rowBlock = readAfterAdd?.blocks?.find(block => block.id === state.rowBlockIds[i]);
      expectEqual(rowBlock?.text, rowInputs[i].Title, `row title after add_database_row for row ${i + 1}`);
    }

    const readAllRows = await call('read_database_cells', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
    });
    expectEqual(readAllRows?.rows?.length, 2, 'read_database_cells row count');

    const [row1, row2] = readAllRows.rows;
    expectEqual(row1.title, 'Card Alpha', 'row1 title after create');
    expectEqual(row1.cells.Title.value, 'Card Alpha', 'row1 custom Title cell');
    expectEqual(row1.cells.Owner.value, 'Alice', 'row1 Owner');
    expectEqual(row1.cells.Stage.value, 'In Progress', 'row1 Stage');
    expectTruthy(row1.cells.Stage.optionId, 'row1 Stage optionId');
    expectArrayEqual(row1.cells.Labels.value, ['Backend'], 'row1 Labels');
    expectArrayEqual(row1.cells.Labels.optionIds.length, 1, 'row1 Labels optionIds length');
    expectEqual(row1.cells.Estimate.value, 5, 'row1 Estimate');
    expectEqual(row1.cells.Done.value, false, 'row1 Done');
    expectEqual(row1.cells.Due.value, initialDates.row1, 'row1 Due');
    expectEqual(row1.cells.Link.value, 'https://example.com/alpha', 'row1 Link');

    expectEqual(row2.title, 'Card Beta', 'row2 title after create');
    expectEqual(row2.cells.Title.value, 'Card Beta', 'row2 custom Title cell');
    expectEqual(row2.cells.Owner.value, 'Bob', 'row2 Owner');
    expectEqual(row2.cells.Stage.value, 'Todo', 'row2 Stage');
    expectArrayEqual(row2.cells.Labels.value, ['Frontend', 'Urgent'], 'row2 Labels');
    expectEqual(row2.cells.Estimate.value, 3, 'row2 Estimate');
    expectEqual(row2.cells.Done.value, true, 'row2 Done');
    expectEqual(row2.cells.Due.value, initialDates.row2, 'row2 Due');
    expectEqual(row2.cells.Link.value, 'https://example.com/beta', 'row2 Link');

    const filteredRead = await call('read_database_cells', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      columns: ['Stage', state.columnIds.Link],
    });
    expectEqual(filteredRead.rows.length, 2, 'filtered read row count');
    for (const row of filteredRead.rows) {
      expectArrayEqual(Object.keys(row.cells).sort(), ['Link', 'Stage'], 'filtered read column keys');
    }

    const rowFilteredRead = await call('read_database_cells', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockIds: [state.rowBlockIds[1]],
      columns: [state.columnIds.Owner, 'Done'],
    });
    expectEqual(rowFilteredRead.rows.length, 1, 'rowBlockIds filter count');
    expectEqual(rowFilteredRead.rows[0].rowBlockId, state.rowBlockIds[1], 'rowBlockIds filter target');
    expectArrayEqual(Object.keys(rowFilteredRead.rows[0].cells).sort(), ['Done', 'Owner'], 'row filter column keys');

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: 'Title',
      value: 'Card Alpha Prime',
    });
    await settle(1200);

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: state.columnIds.Owner,
      value: 'Carol',
    });
    await settle(1200);

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: 'Stage',
      value: 'Blocked',
    });
    await settle(1200);

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: state.columnIds.Labels,
      value: ['Backend', 'Urgent', 'Release'],
    });
    await settle(1200);

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: 'Estimate',
      value: 8,
    });
    await settle(1200);

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: state.columnIds.Done,
      value: true,
    });
    await settle(1200);

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: 'Due',
      value: updatedDates.row1,
    });
    await settle(1200);

    await call('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
      column: state.columnIds.Link,
      value: 'https://example.com/alpha-prime',
    });
    await settle(1200);

    const row1AfterSingleUpdates = await call('read_database_cells', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockIds: [state.rowBlockIds[0]],
    });
    const updatedRow1 = row1AfterSingleUpdates.rows[0];
    expectEqual(updatedRow1.title, 'Card Alpha Prime', 'row1 title after single-cell updates');
    expectEqual(updatedRow1.cells.Title.value, 'Card Alpha Prime', 'row1 custom Title after update_database_cell');
    expectEqual(updatedRow1.cells.Owner.value, 'Carol', 'row1 Owner after update_database_cell');
    expectEqual(updatedRow1.cells.Stage.value, 'Blocked', 'row1 Stage after auto-created option');
    expectArrayEqual(updatedRow1.cells.Labels.value, ['Backend', 'Urgent', 'Release'], 'row1 Labels after update_database_cell');
    expectEqual(updatedRow1.cells.Estimate.value, 8, 'row1 Estimate after update_database_cell');
    expectEqual(updatedRow1.cells.Done.value, true, 'row1 Done after update_database_cell');
    expectEqual(updatedRow1.cells.Due.value, updatedDates.row1, 'row1 Due after update_database_cell');
    expectEqual(updatedRow1.cells.Link.value, 'https://example.com/alpha-prime', 'row1 Link after update_database_cell');

    await expectToolFailure('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[1],
      column: 'Stage',
      value: 'Should Fail',
      createOption: false,
    }, 'option "Should Fail" not found');

    await expectToolFailure('update_database_cell', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[1],
      column: 'Labels',
      value: ['Frontend', 'Nonexistent'],
      createOption: false,
    }, 'option "Nonexistent" not found');

    await call('update_database_row', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[1],
      cells: {
        title: 'Card Beta Final',
        Owner: 'Dana',
        Stage: 'Done',
        [state.columnIds.Labels]: ['Frontend', 'QA'],
        Estimate: 13,
        Done: false,
        [state.columnIds.Due]: updatedDates.row2,
        Link: 'https://example.com/beta-final',
      },
    });
    await settle(1200);

    const finalRead = await call('read_database_cells', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
    });

    const finalRowsById = new Map(finalRead.rows.map(row => [row.rowBlockId, row]));
    const finalRow1 = finalRowsById.get(state.rowBlockIds[0]);
    const finalRow2 = finalRowsById.get(state.rowBlockIds[1]);
    if (!finalRow1 || !finalRow2) {
      throw new Error('Final row lookup failed');
    }

    expectEqual(finalRow1.title, 'Card Alpha Prime', 'final row1 title');
    expectEqual(finalRow2.title, 'Card Beta Final', 'final row2 title');
    expectEqual(finalRow2.cells.Title.value, 'Card Beta Final', 'final row2 custom Title cell');
    expectEqual(finalRow2.cells.Owner.value, 'Dana', 'final row2 Owner');
    expectEqual(finalRow2.cells.Stage.value, 'Done', 'final row2 Stage');
    expectArrayEqual(finalRow2.cells.Labels.value, ['Frontend', 'QA'], 'final row2 Labels');
    expectEqual(finalRow2.cells.Estimate.value, 13, 'final row2 Estimate');
    expectEqual(finalRow2.cells.Done.value, false, 'final row2 Done');
    expectEqual(finalRow2.cells.Due.value, updatedDates.row2, 'final row2 Due');
    expectEqual(finalRow2.cells.Link.value, 'https://example.com/beta-final', 'final row2 Link');

    await call('delete_database_row', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
    });
    await settle(1200);

    await expectToolFailure('delete_database_row', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
      rowBlockId: state.rowBlockIds[0],
    }, `Row block '${state.rowBlockIds[0]}' not found`);

    const afterDelete = await call('read_database_cells', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
    });
    expectEqual(afterDelete.rows.length, 1, 'row count after delete_database_row');
    expectEqual(afterDelete.rows[0].rowBlockId, state.rowBlockIds[1], 'remaining row after delete_database_row');

    const readAfterDelete = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    if (readAfterDelete?.blocks?.some(block => block.id === state.rowBlockIds[0])) {
      throw new Error('deleted database row block still exists in read_doc output');
    }

    state.finalRows = afterDelete.rows;

    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify(state, null, 2));
    console.log();
    console.log(`State written to: ${STATE_OUTPUT_PATH}`);
    console.log('=== Database cell integration test passed ===');
  } catch (err) {
    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify({ ...state, error: err.message }, null, 2));
    console.error();
    console.error(`FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
