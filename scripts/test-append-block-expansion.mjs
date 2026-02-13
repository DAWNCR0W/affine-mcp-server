#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP_SERVER_PATH = './dist/index.js';
const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_EMAIL || 'dev@affine.pro';
const PASSWORD = process.env.AFFINE_PASSWORD || 'dev';
const LOGIN_MODE = process.env.AFFINE_LOGIN_AT_START || 'sync';
const PROFILE = process.env.APPEND_BLOCK_PROFILE || 'step1';
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');

const STEP1_CASES = [
  {
    name: 'paragraph canonical',
    args: { type: 'paragraph', text: 'step1 paragraph' },
    expect: { flavour: 'affine:paragraph', type: 'text' },
  },
  {
    name: 'heading canonical',
    args: { type: 'heading', level: 4, text: 'step1 heading4' },
    expect: { flavour: 'affine:paragraph', type: 'h4' },
  },
  {
    name: 'quote canonical',
    args: { type: 'quote', text: 'step1 quote' },
    expect: { flavour: 'affine:paragraph', type: 'quote' },
  },
  {
    name: 'list bulleted canonical',
    args: { type: 'list', style: 'bulleted', text: 'step1 bulleted' },
    expect: { flavour: 'affine:list', type: 'bulleted' },
  },
  {
    name: 'list numbered canonical',
    args: { type: 'list', style: 'numbered', text: 'step1 numbered' },
    expect: { flavour: 'affine:list', type: 'numbered' },
  },
  {
    name: 'list todo canonical',
    args: { type: 'list', style: 'todo', text: 'step1 todo', checked: true },
    expect: { flavour: 'affine:list', type: 'todo', checked: true },
  },
  {
    name: 'code canonical',
    args: { type: 'code', text: 'console.log("step1")', language: 'javascript', caption: 'sample' },
    expect: { flavour: 'affine:code', language: 'javascript' },
  },
  {
    name: 'divider canonical',
    args: { type: 'divider' },
    expect: { flavour: 'affine:divider' },
  },
  {
    name: 'legacy heading2',
    args: { type: 'heading2', text: 'legacy heading2' },
    expect: { flavour: 'affine:paragraph', type: 'h2' },
  },
  {
    name: 'legacy bulleted_list',
    args: { type: 'bulleted_list', text: 'legacy bulleted' },
    expect: { flavour: 'affine:list', type: 'bulleted' },
  },
];

const STEP2_CASES = [
  ...STEP1_CASES,
  {
    name: 'callout',
    args: { type: 'callout', text: 'step2 callout' },
    expect: { flavour: 'affine:callout' },
  },
  {
    name: 'latex',
    args: { type: 'latex', latex: '\\\\frac{a}{b}' },
    expect: { flavour: 'affine:latex' },
  },
  {
    name: 'table',
    args: { type: 'table', rows: 2, columns: 2 },
    expect: { flavour: 'affine:table' },
  },
];

const STEP3_CASES = [
  ...STEP2_CASES,
  {
    name: 'embed youtube',
    args: { type: 'embed_youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    expect: { flavour: 'affine:embed-youtube' },
  },
  {
    name: 'embed github',
    args: { type: 'embed_github', url: 'https://github.com/microsoft/typescript/issues/1' },
    expect: { flavour: 'affine:embed-github' },
  },
];

const STEP4_CASES = [
  ...STEP3_CASES,
  {
    name: 'database',
    args: { type: 'database' },
    expect: { flavour: 'affine:database' },
  },
  {
    name: 'data_view',
    args: { type: 'data_view' },
    expect: { flavour: 'affine:data-view' },
  },
];

const PROFILE_CASES = {
  step1: STEP1_CASES,
  step2: STEP2_CASES,
  step3: STEP3_CASES,
  step4: STEP4_CASES,
};

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  if (!PROFILE_CASES[PROFILE]) {
    throw new Error(`Unknown APPEND_BLOCK_PROFILE='${PROFILE}'. Use one of: ${Object.keys(PROFILE_CASES).join(', ')}`);
  }

  const client = new Client({ name: 'append-block-expansion-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: process.cwd(),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: LOGIN_MODE,
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[server] ${chunk}`);
  });

  const appended = [];
  let workspaceId = '';
  let docId = '';

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    for (const required of ['append_block', 'read_doc', 'create_workspace', 'create_doc', 'delete_doc', 'delete_workspace']) {
      if (!names.includes(required)) {
        throw new Error(`Required tool '${required}' is not registered.`);
      }
    }

    async function callTool(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
      const parsed = parseContent(result);
      if (parsed && typeof parsed === 'object' && parsed.error) {
        throw new Error(`${name} failed: ${parsed.error}`);
      }
      if (typeof parsed === 'string' && /^GraphQL error:/i.test(parsed)) {
        throw new Error(`${name} failed: ${parsed}`);
      }
      return parsed;
    }

    await callTool('sign_in', { email: EMAIL, password: PASSWORD });
    const ws = await callTool('create_workspace', { name: `append-expansion-${Date.now()}` });
    workspaceId = ws?.id;
    if (!workspaceId) throw new Error('create_workspace did not return workspace id');

    const doc = await callTool('create_doc', { workspaceId, title: `append-${PROFILE}` });
    docId = doc?.docId;
    if (!docId) throw new Error('create_doc did not return docId');

    for (const testCase of PROFILE_CASES[PROFILE]) {
      const payload = { workspaceId, docId, ...testCase.args };
      const result = await callTool('append_block', payload);
      if (!result?.appended || !result?.blockId) {
        throw new Error(`append_block did not return blockId for case '${testCase.name}'`);
      }
      appended.push({
        caseName: testCase.name,
        blockId: result.blockId,
        expect: testCase.expect,
      });
    }

    const readResult = await callTool('read_doc', { workspaceId, docId });
    const rows = Array.isArray(readResult?.blocks) ? readResult.blocks : [];
    const byId = new Map(rows.map(row => [row.id, row]));

    for (const item of appended) {
      const row = byId.get(item.blockId);
      if (!row) throw new Error(`Appended block '${item.blockId}' (${item.caseName}) was not found in read_doc output`);
      if (item.expect.flavour && row.flavour !== item.expect.flavour) {
        throw new Error(`Case '${item.caseName}' expected flavour='${item.expect.flavour}' but got '${row.flavour}'`);
      }
      if (item.expect.type && row.type !== item.expect.type) {
        throw new Error(`Case '${item.caseName}' expected type='${item.expect.type}' but got '${row.type}'`);
      }
      if (item.expect.checked !== undefined && row.checked !== item.expect.checked) {
        throw new Error(`Case '${item.caseName}' expected checked='${item.expect.checked}' but got '${row.checked}'`);
      }
      if (item.expect.language && row.language !== item.expect.language) {
        throw new Error(`Case '${item.caseName}' expected language='${item.expect.language}' but got '${row.language}'`);
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          profile: PROFILE,
          totalCases: PROFILE_CASES[PROFILE].length,
          verified: appended.length,
          workspaceId,
          docId,
        },
        null,
        2
      )
    );
  } finally {
    try {
      if (workspaceId && docId) {
        await client.callTool({ name: 'delete_doc', arguments: { workspaceId, docId } }, undefined, { timeout: TOOL_TIMEOUT_MS });
      }
    } catch {
      // noop
    }
    try {
      if (workspaceId) {
        await client.callTool({ name: 'delete_workspace', arguments: { id: workspaceId } }, undefined, { timeout: TOOL_TIMEOUT_MS });
      }
    } catch {
      // noop
    }
    await transport.close();
  }
}

main().catch(error => {
  console.error(error?.message || String(error));
  process.exit(1);
});
