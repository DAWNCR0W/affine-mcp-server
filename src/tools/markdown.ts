import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate } from "../ws.js";
import * as Y from "yjs";
import { Lexer, Token, Tokens } from "marked";

// ============================================================================
// Types
// ============================================================================

interface InlineFormat {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let id = '';
  for (let i = 0; i < 10; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

async function getCookieAndEndpoint(gql: GraphQLClient) {
  const endpoint = (gql as any).endpoint || process.env.AFFINE_BASE_URL + '/graphql';
  const headers = (gql as any).headers || {};
  const cookie = (gql as any).cookie || headers.Cookie || '';
  return { endpoint, cookie };
}

/**
 * Parse inline markdown tokens into formatted segments
 */
function parseInlineTokens(tokens: Token[]): InlineFormat[] {
  const segments: InlineFormat[] = [];
  
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        segments.push({ text: (token as Tokens.Text).text });
        break;
      case 'strong':
        const strongToken = token as Tokens.Strong;
        if (strongToken.tokens) {
          for (const inner of parseInlineTokens(strongToken.tokens)) {
            segments.push({ ...inner, bold: true });
          }
        } else {
          segments.push({ text: strongToken.text, bold: true });
        }
        break;
      case 'em':
        const emToken = token as Tokens.Em;
        if (emToken.tokens) {
          for (const inner of parseInlineTokens(emToken.tokens)) {
            segments.push({ ...inner, italic: true });
          }
        } else {
          segments.push({ text: emToken.text, italic: true });
        }
        break;
      case 'codespan':
        segments.push({ text: (token as Tokens.Codespan).text, code: true });
        break;
      case 'link':
        const linkToken = token as Tokens.Link;
        segments.push({ text: linkToken.text, link: linkToken.href });
        break;
      case 'br':
        segments.push({ text: '\n' });
        break;
      default:
        // For any other token type, try to extract raw text
        if ('text' in token) {
          segments.push({ text: (token as any).text });
        } else if ('raw' in token) {
          segments.push({ text: (token as any).raw });
        }
    }
  }
  
  return segments;
}

/**
 * Build delta array from inline segments for Y.Text
 */
function buildDelta(segments: InlineFormat[]): Array<{ insert: string; attributes?: Record<string, any> }> {
  const delta: Array<{ insert: string; attributes?: Record<string, any> }> = [];
  
  for (const seg of segments) {
    const op: { insert: string; attributes?: Record<string, any> } = { insert: seg.text };
    const attrs: Record<string, any> = {};
    if (seg.bold) attrs.bold = true;
    if (seg.italic) attrs.italic = true;
    if (seg.code) attrs.code = true;
    if (seg.link) attrs.link = seg.link;
    
    if (Object.keys(attrs).length > 0) {
      op.attributes = attrs;
    }
    delta.push(op);
  }
  
  return delta;
}

/**
 * Create a paragraph block
 */
function createParagraphBlock(
  blocks: Y.Map<any>,
  noteChildren: Y.Array<string>,
  noteId: string,
  segments: InlineFormat[],
  type: string = 'text',
  doc: Y.Doc
): string {
  const paraId = generateId();
  const para = new Y.Map();
  para.set('sys:id', paraId);
  para.set('sys:flavour', 'affine:paragraph');
  para.set('sys:parent', noteId);
  para.set('sys:children', new Y.Array());
  para.set('prop:type', type);
  
  // Create Y.Text and apply formatting delta
  const ytext = new Y.Text();
  para.set('prop:text', ytext);
  blocks.set(paraId, para);
  
  // Apply delta after text is attached to doc structure
  const delta = buildDelta(segments);
  ytext.applyDelta(delta);
  
  noteChildren.push([paraId]);
  return paraId;
}

/**
 * Create a list block
 */
function createListBlock(
  blocks: Y.Map<any>,
  noteChildren: Y.Array<string>,
  noteId: string,
  segments: InlineFormat[],
  type: 'bulleted' | 'numbered' | 'todo',
  checked: boolean = false,
  doc: Y.Doc
): string {
  const listId = generateId();
  const list = new Y.Map();
  list.set('sys:id', listId);
  list.set('sys:flavour', 'affine:list');
  list.set('sys:parent', noteId);
  list.set('sys:children', new Y.Array());
  list.set('prop:type', type);
  
  // Create Y.Text and apply formatting delta
  const ytext = new Y.Text();
  list.set('prop:text', ytext);
  if (type === 'todo') {
    list.set('prop:checked', checked);
  }
  blocks.set(listId, list);
  
  // Apply delta after text is attached to doc structure
  const delta = buildDelta(segments);
  ytext.applyDelta(delta);
  
  noteChildren.push([listId]);
  return listId;
}

/**
 * Create a divider block
 */
function createDividerBlock(
  blocks: Y.Map<any>,
  noteChildren: Y.Array<string>,
  noteId: string
): string {
  const divId = generateId();
  const divider = new Y.Map();
  divider.set('sys:id', divId);
  divider.set('sys:flavour', 'affine:divider');
  divider.set('sys:parent', noteId);
  divider.set('sys:children', new Y.Array());
  blocks.set(divId, divider);
  noteChildren.push([divId]);
  return divId;
}

/**
 * Create a code block
 */
function createCodeBlock(
  blocks: Y.Map<any>,
  noteChildren: Y.Array<string>,
  noteId: string,
  code: string,
  language: string = ''
): string {
  const codeId = generateId();
  const codeBlock = new Y.Map();
  codeBlock.set('sys:id', codeId);
  codeBlock.set('sys:flavour', 'affine:code');
  codeBlock.set('sys:parent', noteId);
  codeBlock.set('sys:children', new Y.Array());
  codeBlock.set('prop:language', language || 'plain text');
  const codeText = new Y.Text();
  codeText.insert(0, code);
  codeBlock.set('prop:text', codeText);
  blocks.set(codeId, codeBlock);
  noteChildren.push([codeId]);
  return codeId;
}

// ============================================================================
// Main Handler
// ============================================================================

export function registerMarkdownTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  
  const importMarkdownHandler = async (parsed: { workspaceId?: string; title?: string; markdown: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);

      // Parse markdown
      const lexer = new Lexer();
      const tokens = lexer.lex(parsed.markdown);

      // Create doc structure
      const docId = generateId();
      const ydoc = new Y.Doc();
      const blocks = ydoc.getMap('blocks');

      // Create page block
      const pageId = generateId();
      const page = new Y.Map();
      page.set('sys:id', pageId);
      page.set('sys:flavour', 'affine:page');
      const titleText = new Y.Text();
      titleText.insert(0, parsed.title || 'Untitled');
      page.set('prop:title', titleText);
      const children = new Y.Array();
      page.set('sys:children', children);
      blocks.set(pageId, page);

      // Create surface block
      const surfaceId = generateId();
      const surface = new Y.Map();
      surface.set('sys:id', surfaceId);
      surface.set('sys:flavour', 'affine:surface');
      surface.set('sys:parent', pageId);
      surface.set('sys:children', new Y.Array());
      blocks.set(surfaceId, surface);
      children.push([surfaceId]);

      // Create note block (container for content)
      const noteId = generateId();
      const note = new Y.Map();
      note.set('sys:id', noteId);
      note.set('sys:flavour', 'affine:note');
      note.set('sys:parent', pageId);
      note.set('prop:displayMode', 'DocAndEdgeless');
      note.set('prop:xywh', '[0,0,800,600]');
      note.set('prop:index', 'a0');
      note.set('prop:lockedBySelf', false);
      const noteChildren = new Y.Array<string>();
      note.set('sys:children', noteChildren);
      blocks.set(noteId, note);
      children.push([noteId]);

      // Process tokens
      for (const token of tokens) {
        switch (token.type) {
          case 'heading': {
            const heading = token as Tokens.Heading;
            const segments = heading.tokens ? parseInlineTokens(heading.tokens) : [{ text: heading.text }];
            const hType = `h${heading.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
            createParagraphBlock(blocks, noteChildren, noteId, segments, hType, ydoc);
            break;
          }
          
          case 'paragraph': {
            const para = token as Tokens.Paragraph;
            const segments = para.tokens ? parseInlineTokens(para.tokens) : [{ text: para.text }];
            createParagraphBlock(blocks, noteChildren, noteId, segments, 'text', ydoc);
            break;
          }
          
          case 'list': {
            const list = token as Tokens.List;
            const listType = list.ordered ? 'numbered' : 'bulleted';
            for (const item of list.items) {
              const listItem = item as Tokens.ListItem;
              // List items have nested structure: listItem.tokens[0] is usually a 'text' token with its own tokens
              let segments: InlineFormat[] = [{ text: listItem.text }];
              if (listItem.tokens && listItem.tokens.length > 0) {
                const firstToken = listItem.tokens[0] as any;
                if (firstToken.tokens) {
                  // Nested tokens inside text token
                  segments = parseInlineTokens(firstToken.tokens);
                } else if (firstToken.type === 'text') {
                  segments = [{ text: firstToken.text }];
                } else {
                  segments = parseInlineTokens(listItem.tokens);
                }
              }
              // Check if it's a task list item
              if (listItem.task) {
                createListBlock(blocks, noteChildren, noteId, segments, 'todo', listItem.checked || false, ydoc);
              } else {
                createListBlock(blocks, noteChildren, noteId, segments, listType, false, ydoc);
              }
            }
            break;
          }
          
          case 'hr': {
            createDividerBlock(blocks, noteChildren, noteId);
            break;
          }
          
          case 'code': {
            const code = token as Tokens.Code;
            createCodeBlock(blocks, noteChildren, noteId, code.text, code.lang || '');
            break;
          }
          
          case 'blockquote': {
            const quote = token as Tokens.Blockquote;
            const segments = quote.tokens ? parseInlineTokens(quote.tokens) : [{ text: quote.text }];
            createParagraphBlock(blocks, noteChildren, noteId, segments, 'quote', ydoc);
            break;
          }
          
          case 'space': {
            // Skip empty lines
            break;
          }
          
          default: {
            // For unknown types, try to render as paragraph
            if ('text' in token) {
              createParagraphBlock(blocks, noteChildren, noteId, [{ text: (token as any).text }], 'text', ydoc);
            }
          }
        }
      }

      // Set doc metadata
      const meta = ydoc.getMap('meta');
      meta.set('id', docId);
      meta.set('title', parsed.title || 'Untitled');
      meta.set('createDate', Date.now());
      meta.set('tags', new Y.Array());

      // Push doc update
      const updateFull = Y.encodeStateAsUpdate(ydoc);
      const updateBase64 = Buffer.from(updateFull).toString('base64');
      await pushDocUpdate(socket, workspaceId, docId, updateBase64);

      // Update workspace root pages list
      const wsDoc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (snapshot.missing) {
        Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, 'base64'));
      }
      const prevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap('meta');
      let pages = wsMeta.get('pages') as Y.Array<Y.Map<any>> | undefined;
      if (!pages) {
        pages = new Y.Array();
        wsMeta.set('pages', pages);
      }
      const entry = new Y.Map();
      entry.set('id', docId);
      entry.set('title', parsed.title || 'Untitled');
      entry.set('createDate', Date.now());
      entry.set('tags', new Y.Array());
      pages.push([entry as any]);
      const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      const wsDeltaB64 = Buffer.from(wsDelta).toString('base64');
      await pushDocUpdate(socket, workspaceId, workspaceId, wsDeltaB64);

      return text({ docId, title: parsed.title || 'Untitled', blocksCreated: noteChildren.length });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('import_markdown', {
    title: 'Import Markdown',
    description: 'Create a new document from markdown with proper formatting (headers, bold, italic, lists, code blocks, etc.)',
    inputSchema: {
      workspaceId: z.string().optional(),
      title: z.string().optional().describe("Document title"),
      markdown: z.string().min(1, "Markdown content is required"),
    },
  }, importMarkdownHandler as any);

  server.registerTool('affine_import_markdown', {
    title: 'Import Markdown',
    description: 'Create a new document from markdown with proper formatting (headers, bold, italic, lists, code blocks, etc.)',
    inputSchema: {
      workspaceId: z.string().optional(),
      title: z.string().optional().describe("Document title"),
      markdown: z.string().min(1, "Markdown content is required"),
    },
  }, importMarkdownHandler as any);
}
