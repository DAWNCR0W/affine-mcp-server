import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, deleteDoc as wsDeleteDoc } from "../ws.js";
import * as Y from "yjs";

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");

export function registerDocTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  // helpers
  function generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let id = '';
    for (let i = 0; i < 10; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
  }

  async function getCookieAndEndpoint() {
    const endpoint = (gql as any).endpoint || process.env.AFFINE_BASE_URL + '/graphql';
    const headers = (gql as any).headers || {};
    const cookie = (gql as any).cookie || headers.Cookie || '';
    return { endpoint, cookie };
  }
  const listDocsHandler = async (parsed: { workspaceId?: string; first?: number; offset?: number; after?: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const query = `query ListDocs($workspaceId: String!, $first: Int, $offset: Int, $after: String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return text(data.workspace.docs);
    };
  server.registerTool(
    "list_docs",
    {
      title: "List Documents",
      description: "List documents in a workspace (GraphQL).",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    listDocsHandler as any
  );
  server.registerTool(
    "affine_list_docs",
    {
      title: "List Documents",
      description: "List documents in a workspace (GraphQL).",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    listDocsHandler as any
  );

  const getDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const query = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id workspaceId title summary public defaultRole createdAt updatedAt } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId });
      return text(data.workspace.doc);
    };
  server.registerTool(
    "get_doc",
    {
      title: "Get Document",
      description: "Get a document by ID (GraphQL metadata).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: DocId
      }
    },
    getDocHandler as any
  );
  server.registerTool(
    "affine_get_doc",
    {
      title: "Get Document",
      description: "Get a document by ID (GraphQL metadata).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: DocId
      }
    },
    getDocHandler as any
  );

  const searchDocsHandler = async (parsed: { workspaceId?: string; keyword: string; limit?: number }) => {
      try {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
        const query = `query SearchDocs($workspaceId:String!, $keyword:String!, $limit:Int){ workspace(id:$workspaceId){ searchDocs(input:{ keyword:$keyword, limit:$limit }){ docId title highlight createdAt updatedAt } } }`;
        const data = await gql.request<{ workspace: any }>(query, { workspaceId, keyword: parsed.keyword, limit: parsed.limit });
        return text(data.workspace?.searchDocs || []);
      } catch (error: any) {
        // Return empty array on error (search might not be available)
        console.error("Search docs error:", error.message);
        return text([]);
      }
    };
  server.registerTool(
    "search_docs",
    {
      title: "Search Documents",
      description: "Search documents in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        keyword: z.string().min(1),
        limit: z.number().optional()
      }
    },
    searchDocsHandler as any
  );
  server.registerTool(
    "affine_search_docs",
    {
      title: "Search Documents",
      description: "Search documents in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        keyword: z.string().min(1),
        limit: z.number().optional()
      }
    },
    searchDocsHandler as any
  );

  const recentDocsHandler = async (parsed: { workspaceId?: string; first?: number; offset?: number; after?: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      // Note: AFFiNE doesn't have a separate 'recentlyUpdatedDocs' field, just use docs
      const query = `query RecentDocs($workspaceId:String!, $first:Int, $offset:Int, $after:String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return text(data.workspace.docs);
    };
  server.registerTool(
    "recent_docs",
    {
      title: "Recent Documents",
      description: "List recently updated docs in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    recentDocsHandler as any
  );
  server.registerTool(
    "affine_recent_docs",
    {
      title: "Recent Documents",
      description: "List recently updated docs in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    recentDocsHandler as any
  );

  const publishDocHandler = async (parsed: { workspaceId?: string; docId: string; mode?: "Page" | "Edgeless" }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const mutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
      const data = await gql.request<{ publishDoc: any }>(mutation, { workspaceId, docId: parsed.docId, mode: parsed.mode });
      return text(data.publishDoc);
    };
  server.registerTool(
    "publish_doc",
    {
      title: "Publish Document",
      description: "Publish a doc (make public).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        mode: z.enum(["Page","Edgeless"]).optional()
      }
    },
    publishDocHandler as any
  );
  server.registerTool(
    "affine_publish_doc",
    {
      title: "Publish Document",
      description: "Publish a doc (make public).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        mode: z.enum(["Page","Edgeless"]).optional()
      }
    },
    publishDocHandler as any
  );

  const revokeDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const mutation = `mutation RevokeDoc($workspaceId:String!,$docId:String!){ revokePublicDoc(workspaceId:$workspaceId, docId:$docId){ id workspaceId public } }`;
      const data = await gql.request<{ revokePublicDoc: any }>(mutation, { workspaceId, docId: parsed.docId });
      return text(data.revokePublicDoc);
    };
  server.registerTool(
    "revoke_doc",
    {
      title: "Revoke Document",
      description: "Revoke a doc's public access.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string()
      }
    },
    revokeDocHandler as any
  );
  server.registerTool(
    "affine_revoke_doc",
    {
      title: "Revoke Document",
      description: "Revoke a doc's public access.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string()
      }
    },
    revokeDocHandler as any
  );

  // CREATE DOC (high-level)
  const createDocHandler = async (parsed: { workspaceId?: string; title?: string; content?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it or set AFFINE_WORKSPACE_ID.");
    const { endpoint, cookie } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);
    try {
      await joinWorkspace(socket, workspaceId);

      // 1) Create doc content
      const docId = generateId();
      const ydoc = new Y.Doc();
      const blocks = ydoc.getMap('blocks');
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

      const surfaceId = generateId();
      const surface = new Y.Map();
      surface.set('sys:id', surfaceId);
      surface.set('sys:flavour', 'affine:surface');
      surface.set('sys:parent', pageId);
      surface.set('sys:children', new Y.Array());
      blocks.set(surfaceId, surface);
      children.push([surfaceId]);

      const noteId = generateId();
      const note = new Y.Map();
      note.set('sys:id', noteId);
      note.set('sys:flavour', 'affine:note');
      note.set('sys:parent', pageId);
      note.set('prop:displayMode', 'DocAndEdgeless');
      note.set('prop:xywh', '[0,0,800,600]');
      note.set('prop:index', 'a0');
      note.set('prop:lockedBySelf', false);
      const noteChildren = new Y.Array();
      note.set('sys:children', noteChildren);
      blocks.set(noteId, note);
      children.push([noteId]);

      if (parsed.content) {
        const paraId = generateId();
        const para = new Y.Map();
        para.set('sys:id', paraId);
        para.set('sys:flavour', 'affine:paragraph');
        para.set('sys:parent', noteId);
        para.set('sys:children', new Y.Array());
        para.set('prop:type', 'text');
        const ptext = new Y.Text();
        ptext.insert(0, parsed.content);
        para.set('prop:text', ptext);
        blocks.set(paraId, para);
        noteChildren.push([paraId]);
      }

      const meta = ydoc.getMap('meta');
      meta.set('id', docId);
      meta.set('title', parsed.title || 'Untitled');
      meta.set('createDate', Date.now());
      meta.set('tags', new Y.Array());

      const updateFull = Y.encodeStateAsUpdate(ydoc);
      const updateBase64 = Buffer.from(updateFull).toString('base64');
      await pushDocUpdate(socket, workspaceId, docId, updateBase64);

      // 2) Update workspace root pages list
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

      return text({ docId, title: parsed.title || 'Untitled' });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    'create_doc',
    {
      title: 'Create Document',
      description: 'Create a new AFFiNE document with optional content',
      inputSchema: {
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
      },
    },
    createDocHandler as any
  );
  server.registerTool(
    'affine_create_doc',
    {
      title: 'Create Document',
      description: 'Create a new AFFiNE document with optional content',
      inputSchema: {
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
      },
    },
    createDocHandler as any
  );

  // APPEND PARAGRAPH
  const appendParagraphHandler = async (parsed: { workspaceId?: string; docId: string; text: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error('workspaceId is required');
    const { endpoint, cookie } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
      }
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap('blocks') as Y.Map<any>;
      // find a note block
      let noteId: string | null = null;
      for (const [key, val] of blocks) {
        const m = val as any;
        if (m?.get && m.get('sys:flavour') === 'affine:note') {
          noteId = m.get('sys:id');
          break;
        }
      }
      if (!noteId) {
        // fallback: create a note under existing page
        let pageId: string | null = null;
        for (const [key, val] of blocks) {
          const m = val as any;
          if (m?.get && m.get('sys:flavour') === 'affine:page') {
            pageId = m.get('sys:id');
            break;
          }
        }
        if (!pageId) throw new Error('Doc has no page block');
        const note = new Y.Map();
        noteId = generateId();
        note.set('sys:id', noteId);
        note.set('sys:flavour', 'affine:note');
        note.set('sys:parent', pageId);
        note.set('prop:displayMode', 'DocAndEdgeless');
        note.set('prop:xywh', '[0,0,800,600]');
        note.set('prop:index', 'a0');
        note.set('prop:lockedBySelf', false);
        note.set('sys:children', new Y.Array());
        blocks.set(noteId, note);
        const page = blocks.get(pageId) as any;
        const children = page.get('sys:children') as Y.Array<string>;
        children.push([noteId]);
      }
      const paragraphId = generateId();
      const para = new Y.Map();
      para.set('sys:id', paragraphId);
      para.set('sys:flavour', 'affine:paragraph');
      para.set('sys:parent', noteId);
      para.set('sys:children', new Y.Array());
      para.set('prop:type', 'text');
      const ptext = new Y.Text();
      ptext.insert(0, parsed.text);
      para.set('prop:text', ptext);
      blocks.set(paragraphId, para);
      const note = blocks.get(noteId) as any;
      const noteChildren = note.get('sys:children') as Y.Array<string>;
      noteChildren.push([paragraphId]);
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      const deltaB64 = Buffer.from(delta).toString('base64');
      await pushDocUpdate(socket, workspaceId, parsed.docId, deltaB64);
      return text({ appended: true, paragraphId });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    'append_paragraph',
    {
      title: 'Append Paragraph',
      description: 'Append a text paragraph block to a document',
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        text: z.string(),
      },
    },
    appendParagraphHandler as any
  );
  server.registerTool(
    'affine_append_paragraph',
    {
      title: 'Append Paragraph',
      description: 'Append a text paragraph block to a document',
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        text: z.string(),
      },
    },
    appendParagraphHandler as any
  );

  // DELETE DOC
  const deleteDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error('workspaceId is required');
    const { endpoint, cookie } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);
    try {
      await joinWorkspace(socket, workspaceId);
      // remove from workspace pages
      const wsDoc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (snapshot.missing) Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, 'base64'));
      const prevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap('meta');
      const pages = wsMeta.get('pages') as Y.Array<Y.Map<any>> | undefined;
      if (pages) {
        // find by id
        let idx = -1;
        pages.forEach((m: any, i: number) => {
          if (idx >= 0) return;
          if (m.get && m.get('id') === parsed.docId) idx = i;
        });
        if (idx >= 0) pages.delete(idx, 1);
      }
      const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString('base64'));
      // delete doc content
      wsDeleteDoc(socket, workspaceId, parsed.docId);
      return text({ deleted: true });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    'delete_doc',
    {
      title: 'Delete Document',
      description: 'Delete a document and remove from workspace list',
      inputSchema: { workspaceId: z.string().optional(), docId: z.string() },
    },
    deleteDocHandler as any
  );
  server.registerTool(
    'affine_delete_doc',
    {
      title: 'Delete Document',
      description: 'Delete a document and remove from workspace list',
      inputSchema: { workspaceId: z.string().optional(), docId: z.string() },
    },
    deleteDocHandler as any
  );
}
