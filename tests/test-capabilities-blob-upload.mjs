#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerDocTools } from '../dist/tools/docs.js';

const tools = new Map();
registerDocTools({ registerTool: (name, definition, handler) => tools.set(name, { definition, handler }) }, {}, {});

test('get_capabilities reports whether disk-path blob uploads are enabled', async () => {
  const read = async () => {
    const result = await tools.get('get_capabilities').handler({});
    return (result.structuredContent ?? JSON.parse(result.content[0].text)).blobUpload;
  };
  const previous = process.env.AFFINE_BLOB_UPLOAD_FILE_ROOTS;
  try {
    delete process.env.AFFINE_BLOB_UPLOAD_FILE_ROOTS;
    assert.deepEqual(await read(), { filePath: false, inline: true });
    process.env.AFFINE_BLOB_UPLOAD_FILE_ROOTS = '/tmp';
    assert.deepEqual(await read(), { filePath: true, inline: true });
  } finally {
    if (previous === undefined) delete process.env.AFFINE_BLOB_UPLOAD_FILE_ROOTS;
    else process.env.AFFINE_BLOB_UPLOAD_FILE_ROOTS = previous;
  }
});
