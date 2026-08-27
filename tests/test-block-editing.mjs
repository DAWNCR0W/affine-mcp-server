#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const STATE_OUTPUT_PATH = path.resolve(__dirname, 'test-block-editing-state.json');

const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error('AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh');
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');

function parseContent(result) {
  const value = result?.content?.[0]?.text;
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

function assertDerivedParentIds(readDocPayload) {
  const blocks = Array.isArray(readDocPayload?.blocks) ? readDocPayload.blocks : [];
  const expectedParents = new Map();
  for (const parent of blocks) {
    for (const childId of parent?.childIds || []) {
      expectedParents.set(childId, parent.id);
    }
  }
  for (const block of blocks) {
    const expectedParentId = expectedParents.get(block.id) ?? null;
    expectEqual(block.parentId, expectedParentId, `read_doc parentId for ${block.id}`);
  }
}

async function main() {
  console.log('=== Block Editing Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  const state = {
    baseUrl: BASE_URL,
    email: EMAIL,
    workspaceId: null,
    docId: null,
    inboxHeadingBlockId: null,
    taskBlockId: null,
    quoteBlockId: null,
    codeBlockId: null,
    taskText: 'Ship the verified release',
    oldTaskText: 'Ship the draft release',
    inboxHeadingText: 'Inbox priority',
    quoteText: 'Review the highlighted contract',
    codeText: 'const status = "highlighted";',
    coloredSegment: 'priority',
    highlightedSegment: 'verified',
    doneHeadingText: 'Done',
    deletedText: 'Remove this temporary note',
    inboxHeadingDeltas: [
      { insert: 'Inbox ' },
      { insert: 'priority', attributes: { color: 'var(--affine-text-highlight-foreground-blue)' } },
    ],
    oldTaskDeltas: [
      { insert: 'Ship the ' },
      { insert: 'draft', attributes: { background: 'var(--affine-text-highlight-yellow)' } },
      { insert: ' release' },
    ],
    taskDeltas: [
      { insert: 'Ship the ' },
      {
        insert: 'verified',
        attributes: {
          color: 'var(--affine-text-highlight-foreground-blue)',
          background: 'var(--affine-text-highlight-purple)',
        },
      },
      { insert: ' release' },
    ],
    quoteDeltas: [
      { insert: 'Review the ' },
      { insert: 'highlighted', attributes: { background: 'var(--affine-text-highlight-yellow)' } },
      { insert: ' contract' },
    ],
    codeDeltas: [
      { insert: 'const status = ' },
      { insert: '"highlighted"', attributes: { futureInlineAttribute: { version: 1 } } },
      { insert: ';' },
    ],
    deletedDeltas: [
      { insert: 'Remove this ' },
      { insert: 'temporary', attributes: { color: 'var(--affine-text-highlight-foreground-red)' } },
      { insert: ' note' },
    ],
  };
  const client = new Client({ name: 'affine-mcp-block-editing-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: testTempPath('block-editing-config'),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(`[mcp-server] ${chunk}`));

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
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
    console.log('    ✓ OK');
    return parsed;
  }

  async function expectCallError(toolName, args, expectedMessage) {
    try {
      await call(toolName, args);
    } catch (error) {
      if (!expectedMessage.test(error.message)) {
        throw error;
      }
      console.log('    ✓ Rejected as expected');
      return;
    }
    throw new Error(`${toolName} unexpectedly succeeded`);
  }

  try {
    await client.connect(transport);

    const workspace = await call('create_workspace', { name: testResourceName('block-editing') });
    state.workspaceId = workspace?.id || workspace?.workspaceId;
    expectTruthy(state.workspaceId, 'create_workspace id');

    const document = await call('create_doc', {
      workspaceId: state.workspaceId,
      title: 'Block Editing E2E',
      content: '',
    });
    state.docId = document?.docId;
    expectTruthy(state.docId, 'create_doc docId');

    const inboxHeading = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'heading',
      level: 2,
      text: state.inboxHeadingDeltas,
    });
    state.inboxHeadingBlockId = inboxHeading?.blockId;
    expectTruthy(state.inboxHeadingBlockId, 'append_block rich-text heading id');
    const task = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'list',
      style: 'bulleted',
      text: state.oldTaskDeltas,
    });
    state.taskBlockId = task?.blockId;
    expectTruthy(state.taskBlockId, 'append_block task id');

    const quote = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'quote',
      text: state.quoteDeltas,
    });
    state.quoteBlockId = quote?.blockId;
    expectTruthy(state.quoteBlockId, 'append_block rich-text quote id');

    const code = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'code',
      text: state.codeDeltas,
    });
    state.codeBlockId = code?.blockId;
    expectTruthy(state.codeBlockId, 'append_block rich-text code id');

    const emptyDivider = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'divider',
      text: [{ insert: '' }],
    });
    expectTruthy(emptyDivider?.blockId, 'append_block empty rich-text divider id');
    await expectCallError('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'divider',
      text: [{ insert: 'not empty' }],
    }, /do not accept text/);

    const doneHeading = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'heading',
      level: 2,
      text: state.doneHeadingText,
    });
    expectTruthy(doneHeading?.blockId, 'append_block done heading id');

    const temporary = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'paragraph',
      text: state.deletedDeltas,
    });
    expectTruthy(temporary?.blockId, 'append_block temporary id');

    const destinationNote = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'note',
    });
    expectTruthy(destinationNote?.blockId, 'append_block destination note id');
    const destinationAnchor = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'paragraph',
      text: 'Destination anchor',
      placement: { parentId: destinationNote.blockId },
    });
    expectTruthy(destinationAnchor?.blockId, 'append_block destination anchor id');

    const checked = await call('update_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: state.taskBlockId,
      style: 'todo',
      checked: true,
    });
    expectEqual(checked?.blockId, state.taskBlockId, 'update_block checked id');
    expectEqual(checked?.block?.text, state.oldTaskText, 'update_block preserves omitted text');
    assert.deepEqual(checked?.block?.deltas, state.oldTaskDeltas, 'update_block preserves omitted text deltas');
    expectEqual(checked?.block?.type, 'todo', 'update_block list style');
    expectEqual(checked?.block?.checked, true, 'update_block checked state');

    const renamed = await call('update_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: state.taskBlockId,
      text: state.taskDeltas,
    });
    expectEqual(renamed?.blockId, state.taskBlockId, 'update_block text id');
    expectEqual(renamed?.block?.text, state.taskText, 'update_block text');
    assert.deepEqual(renamed?.previous?.deltas, state.oldTaskDeltas, 'update_block previous text deltas');
    assert.deepEqual(renamed?.block?.deltas, state.taskDeltas, 'update_block replacement text deltas');
    expectEqual(renamed?.block?.checked, true, 'update_block preserves omitted checked state');

    const unchangedDeltas = await call('update_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: state.taskBlockId,
      text: state.taskDeltas,
    });
    expectEqual(unchangedDeltas?.updated, false, 'update_block identical deltas no-op');
    assert.deepEqual(unchangedDeltas?.changed, [], 'update_block identical deltas changed fields');

    const unchangedPlainText = await call('update_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: state.taskBlockId,
      text: state.taskText,
    });
    expectEqual(unchangedPlainText?.updated, false, 'update_block identical plain text no-op');
    assert.deepEqual(unchangedPlainText?.block?.deltas, state.taskDeltas, 'plain-text no-op preserves existing attributes');

    await expectCallError('update_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: state.taskBlockId,
      type: 'paragraph',
    }, /while preserving its id/);
    const afterRejectedUpdate = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    const unchangedTask = afterRejectedUpdate?.blocks?.find(block => block.id === state.taskBlockId);
    expectTruthy(unchangedTask, 'rejected update preserves block id');
    expectEqual(unchangedTask.text, state.taskText, 'rejected update preserves text');
    assert.deepEqual(unchangedTask.deltas, state.taskDeltas, 'rejected update preserves text deltas');
    expectEqual(unchangedTask.type, 'todo', 'rejected update preserves type');
    expectEqual(unchangedTask.checked, true, 'rejected update preserves checked state');

    const movedToParent = await call('move_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: temporary.blockId,
      placement: { parentId: destinationNote.blockId },
    });
    expectEqual(movedToParent?.toParentId, destinationNote.blockId, 'move_block explicit parent');
    const afterParentMove = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    const parentAfterMove = afterParentMove?.blocks?.find(block => block.id === destinationNote.blockId);
    expectTruthy(parentAfterMove, 'move_block destination parent');
    expectEqual(parentAfterMove.childIds.at(-1), temporary.blockId, 'move_block appends to explicit parent');

    const reordered = await call('move_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: temporary.blockId,
      placement: { index: 0 },
    });
    expectEqual(reordered?.toParentId, destinationNote.blockId, 'move_block index keeps current parent');
    expectEqual(reordered?.toIndex, 0, 'move_block index receipt');
    const afterIndexMove = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    const parentAfterReorder = afterIndexMove?.blocks?.find(block => block.id === destinationNote.blockId);
    expectTruthy(parentAfterReorder, 'move_block index parent');
    expectEqual(parentAfterReorder.childIds[0], temporary.blockId, 'move_block index order');
    expectEqual(parentAfterReorder.childIds[1], destinationAnchor.blockId, 'move_block retained sibling order');

    const converted = await call('update_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: temporary.blockId,
      type: 'heading',
      level: 3,
    });
    expectEqual(converted?.blockId, temporary.blockId, 'update_block type id');
    expectEqual(converted?.block?.type, 'h3', 'update_block heading level');
    expectEqual(converted?.block?.text, state.deletedText, 'update_block preserves text during type change');
    assert.deepEqual(converted?.block?.deltas, state.deletedDeltas, 'update_block preserves deltas during type change');

    const moved = await call('move_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: state.taskBlockId,
      placement: { afterBlockId: doneHeading.blockId },
    });
    expectEqual(moved?.blockId, state.taskBlockId, 'move_block id');
    expectEqual(moved?.moved, true, 'move_block moved');
    expectEqual(moved?.block?.parentId, moved?.toParentId, 'move_block parent receipt');
    assert.deepEqual(moved?.block?.deltas, state.taskDeltas, 'move_block snapshot preserves text deltas');

    const deleted = await call('delete_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      blockId: temporary.blockId,
    });
    expectEqual(deleted?.deleted, true, 'delete_block deleted');
    expectEqual(deleted?.deletedBlock?.id, temporary.blockId, 'delete_block snapshot id');
    expectEqual(deleted?.deletedBlock?.type, 'h3', 'delete_block snapshot type');
    expectEqual(deleted?.deletedBlock?.text, state.deletedText, 'delete_block snapshot text');
    assert.deepEqual(deleted?.deletedBlock?.deltas, state.deletedDeltas, 'delete_block snapshot deltas');
    expectEqual(deleted?.deletedBlocks?.length, 1, 'delete_block snapshot count');

    const read = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    assertDerivedParentIds(read);
    const blocks = Array.isArray(read?.blocks) ? read.blocks : [];
    const taskBlock = blocks.find(block => block.id === state.taskBlockId);
    expectTruthy(taskBlock, 'read_doc task block');
    expectEqual(taskBlock.text, state.taskText, 'read_doc updated text');
    assert.deepEqual(taskBlock.deltas, state.taskDeltas, 'read_doc updated text deltas');
    expectEqual(taskBlock.checked, true, 'read_doc updated checked state');
    expectEqual(taskBlock.type, 'todo', 'read_doc todo type');
    expectEqual(blocks.some(block => block.id === temporary.blockId), false, 'read_doc deleted block absence');

    const doneBlock = blocks.find(block => block.id === doneHeading.blockId);
    expectTruthy(doneBlock, 'read_doc done heading');
    assert.deepEqual(
      blocks.find(block => block.id === state.inboxHeadingBlockId)?.deltas,
      state.inboxHeadingDeltas,
      'read_doc heading deltas',
    );
    assert.deepEqual(
      blocks.find(block => block.id === state.quoteBlockId)?.deltas,
      state.quoteDeltas,
      'read_doc quote deltas',
    );
    assert.deepEqual(
      blocks.find(block => block.id === state.codeBlockId)?.deltas,
      state.codeDeltas,
      'read_doc code deltas with arbitrary future attributes',
    );
    expectEqual(taskBlock.parentId, doneBlock.parentId, 'moved task and heading parent');
    const parent = blocks.find(block => block.id === taskBlock.parentId);
    expectTruthy(parent, 'read_doc moved task parent');
    const doneIndex = parent.childIds.indexOf(doneHeading.blockId);
    const taskIndex = parent.childIds.indexOf(state.taskBlockId);
    if (doneIndex < 0 || taskIndex !== doneIndex + 1) {
      throw new Error(`move_block order mismatch: doneIndex=${doneIndex}, taskIndex=${taskIndex}`);
    }

    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify(state, null, 2));
    console.log();
    console.log(`State written to: ${STATE_OUTPUT_PATH}`);
    console.log('=== Block editing integration test passed ===');
  } catch (error) {
    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify({ ...state, error: error.message }, null, 2));
    throw error;
  } finally {
    await client.close().catch(() => {});
    await transport.close?.().catch(() => {});
  }
}

main().catch(error => {
  console.error(`[block-editing] ERROR: ${error.message}`);
  process.exit(1);
});
