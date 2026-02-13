import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, deleteDoc as wsDeleteDoc } from "../ws.js";
import * as Y from "yjs";

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");
const APPEND_BLOCK_TYPE_VALUES = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "quote",
  "bulleted_list",
  "numbered_list",
  "todo",
  "code",
  "divider",
] as const;
type AppendBlockType = typeof APPEND_BLOCK_TYPE_VALUES[number];
const AppendBlockType = z.enum(APPEND_BLOCK_TYPE_VALUES);

function blockVersion(flavour: string): number {
  switch (flavour) {
    case "affine:page":
      return 2;
    case "affine:surface":
      return 5;
    default:
      return 1;
  }
}

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

  function makeText(content: string): Y.Text {
    const yText = new Y.Text();
    if (content.length > 0) {
      yText.insert(0, content);
    }
    return yText;
  }

  function asText(value: unknown): string {
    if (value instanceof Y.Text) return value.toString();
    if (typeof value === "string") return value;
    return "";
  }

  function childIdsFrom(value: unknown): string[] {
    if (!(value instanceof Y.Array)) return [];
    const childIds: string[] = [];
    value.forEach((entry: unknown) => {
      if (typeof entry === "string") {
        childIds.push(entry);
        return;
      }
      if (Array.isArray(entry)) {
        for (const child of entry) {
          if (typeof child === "string") {
            childIds.push(child);
          }
        }
      }
    });
    return childIds;
  }

  function setSysFields(block: Y.Map<any>, blockId: string, flavour: string): void {
    block.set("sys:id", blockId);
    block.set("sys:flavour", flavour);
    block.set("sys:version", blockVersion(flavour));
  }

  function findBlockIdByFlavour(blocks: Y.Map<any>, flavour: string): string | null {
    for (const [, value] of blocks) {
      const block = value as Y.Map<any>;
      if (block?.get && block.get("sys:flavour") === flavour) {
        return String(block.get("sys:id"));
      }
    }
    return null;
  }

  function ensureNoteBlock(blocks: Y.Map<any>): string {
    const existingNoteId = findBlockIdByFlavour(blocks, "affine:note");
    if (existingNoteId) {
      return existingNoteId;
    }

    const pageId = findBlockIdByFlavour(blocks, "affine:page");
    if (!pageId) {
      throw new Error("Document has no page block; unable to insert content.");
    }

    const noteId = generateId();
    const note = new Y.Map<any>();
    setSysFields(note, noteId, "affine:note");
    note.set("sys:parent", pageId);
    note.set("sys:children", new Y.Array<string>());
    note.set("prop:xywh", "[0,0,800,95]");
    note.set("prop:index", "a0");
    note.set("prop:hidden", false);
    note.set("prop:displayMode", "both");
    const background = new Y.Map<any>();
    background.set("light", "#ffffff");
    background.set("dark", "#252525");
    note.set("prop:background", background);
    blocks.set(noteId, note);

    const page = blocks.get(pageId) as Y.Map<any>;
    let pageChildren = page.get("sys:children") as Y.Array<string> | undefined;
    if (!(pageChildren instanceof Y.Array)) {
      pageChildren = new Y.Array<string>();
      page.set("sys:children", pageChildren);
    }
    pageChildren.push([noteId]);
    return noteId;
  }

  function createBlock(
    noteId: string,
    parsed: { type: AppendBlockType; text?: string; checked?: boolean; language?: string; caption?: string }
  ): { blockId: string; block: Y.Map<any>; flavour: string; blockType?: string } {
    const blockId = generateId();
    const block = new Y.Map<any>();
    const content = parsed.text ?? "";

    switch (parsed.type) {
      case "paragraph":
      case "heading1":
      case "heading2":
      case "heading3":
      case "quote": {
        setSysFields(block, blockId, "affine:paragraph");
        block.set("sys:parent", noteId);
        block.set("sys:children", new Y.Array<string>());
        const blockType =
          parsed.type === "heading1"
            ? "h1"
            : parsed.type === "heading2"
              ? "h2"
              : parsed.type === "heading3"
                ? "h3"
                : parsed.type === "quote"
                  ? "quote"
                  : "text";
        block.set("prop:type", blockType);
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:paragraph", blockType };
      }
      case "bulleted_list":
      case "numbered_list":
      case "todo": {
        setSysFields(block, blockId, "affine:list");
        block.set("sys:parent", noteId);
        block.set("sys:children", new Y.Array<string>());
        const blockType =
          parsed.type === "bulleted_list"
            ? "bulleted"
            : parsed.type === "numbered_list"
              ? "numbered"
              : "todo";
        block.set("prop:type", blockType);
        if (blockType === "todo") {
          block.set("prop:checked", Boolean(parsed.checked));
        }
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:list", blockType };
      }
      case "code": {
        setSysFields(block, blockId, "affine:code");
        block.set("sys:parent", noteId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:language", (parsed.language || "txt").toLowerCase());
        if (parsed.caption) {
          block.set("prop:caption", parsed.caption);
        }
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:code" };
      }
      case "divider": {
        setSysFields(block, blockId, "affine:divider");
        block.set("sys:parent", noteId);
        block.set("sys:children", new Y.Array<string>());
        return { blockId, block, flavour: "affine:divider" };
      }
    }
  }

  async function appendBlockInternal(parsed: {
    workspaceId?: string;
    docId: string;
    type: AppendBlockType;
    text?: string;
    checked?: boolean;
    language?: string;
    caption?: string;
  }) {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);
    try {
      await joinWorkspace(socket, workspaceId);

      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }

      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const noteId = ensureNoteBlock(blocks);
      const { blockId, block, flavour, blockType } = createBlock(noteId, parsed);

      blocks.set(blockId, block);
      const note = blocks.get(noteId) as Y.Map<any>;
      let noteChildren = note.get("sys:children") as Y.Array<string> | undefined;
      if (!(noteChildren instanceof Y.Array)) {
        noteChildren = new Y.Array<string>();
        note.set("sys:children", noteChildren);
      }
      noteChildren.push([blockId]);

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return { appended: true, blockId, flavour, blockType };
    } finally {
      socket.disconnect();
    }
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

  const readDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, cookie } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);

      if (!snapshot.missing) {
        return text({
          docId: parsed.docId,
          title: null,
          exists: false,
          blockCount: 0,
          blocks: [],
          plainText: "",
        });
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const pageId = findBlockIdByFlavour(blocks, "affine:page");
      const noteId = findBlockIdByFlavour(blocks, "affine:note");
      const visited = new Set<string>();
      const blockRows: Array<{
        id: string;
        parentId: string | null;
        flavour: string | null;
        type: string | null;
        text: string | null;
        checked: boolean | null;
        language: string | null;
        childIds: string[];
      }> = [];
      const plainTextLines: string[] = [];
      let title = "";

      const visit = (blockId: string) => {
        if (visited.has(blockId)) return;
        visited.add(blockId);

        const raw = blocks.get(blockId);
        if (!(raw instanceof Y.Map)) return;

        const flavour = raw.get("sys:flavour");
        const parentId = raw.get("sys:parent");
        const type = raw.get("prop:type");
        const textValue = asText(raw.get("prop:text"));
        const language = raw.get("prop:language");
        const checked = raw.get("prop:checked");
        const childIds = childIdsFrom(raw.get("sys:children"));

        if (flavour === "affine:page") {
          title = asText(raw.get("prop:title")) || title;
        }
        if (textValue.length > 0) {
          plainTextLines.push(textValue);
        }

        blockRows.push({
          id: blockId,
          parentId: typeof parentId === "string" ? parentId : null,
          flavour: typeof flavour === "string" ? flavour : null,
          type: typeof type === "string" ? type : null,
          text: textValue.length > 0 ? textValue : null,
          checked: typeof checked === "boolean" ? checked : null,
          language: typeof language === "string" ? language : null,
          childIds,
        });

        for (const childId of childIds) {
          visit(childId);
        }
      };

      if (pageId) {
        visit(pageId);
      } else if (noteId) {
        visit(noteId);
      }
      for (const [id] of blocks) {
        const blockId = String(id);
        if (!visited.has(blockId)) {
          visit(blockId);
        }
      }

      return text({
        docId: parsed.docId,
        title: title || null,
        exists: true,
        blockCount: blockRows.length,
        blocks: blockRows,
        plainText: plainTextLines.join("\n"),
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "read_doc",
    {
      title: "Read Document Content",
      description: "Read document block content via WebSocket snapshot (blocks + plain text).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
      },
    },
    readDocHandler as any
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
      setSysFields(page, pageId, "affine:page");
      const titleText = new Y.Text();
      titleText.insert(0, parsed.title || 'Untitled');
      page.set('prop:title', titleText);
      const children = new Y.Array();
      page.set('sys:children', children);
      blocks.set(pageId, page);

      const surfaceId = generateId();
      const surface = new Y.Map();
      setSysFields(surface, surfaceId, "affine:surface");
      surface.set('sys:parent', pageId);
      surface.set('sys:children', new Y.Array());
      const elements = new Y.Map<any>();
      elements.set("type", "$blocksuite:internal:native$");
      elements.set("value", new Y.Map<any>());
      surface.set("prop:elements", elements);
      blocks.set(surfaceId, surface);
      children.push([surfaceId]);

      const noteId = generateId();
      const note = new Y.Map();
      setSysFields(note, noteId, "affine:note");
      note.set('sys:parent', pageId);
      note.set('prop:displayMode', 'both');
      note.set('prop:xywh', '[0,0,800,95]');
      note.set('prop:index', 'a0');
      note.set('prop:hidden', false);
      const background = new Y.Map<any>();
      background.set("light", "#ffffff");
      background.set("dark", "#252525");
      note.set("prop:background", background);
      const noteChildren = new Y.Array();
      note.set('sys:children', noteChildren);
      blocks.set(noteId, note);
      children.push([noteId]);

      if (parsed.content) {
        const paraId = generateId();
        const para = new Y.Map();
        setSysFields(para, paraId, "affine:paragraph");
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

  // APPEND PARAGRAPH
  const appendParagraphHandler = async (parsed: { workspaceId?: string; docId: string; text: string }) => {
    const result = await appendBlockInternal({
      workspaceId: parsed.workspaceId,
      docId: parsed.docId,
      type: "paragraph",
      text: parsed.text,
    });
    return text({ appended: result.appended, paragraphId: result.blockId });
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

  const appendBlockHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    type: AppendBlockType;
    text?: string;
    checked?: boolean;
    language?: string;
    caption?: string;
  }) => {
    const result = await appendBlockInternal(parsed);
    return text({
      appended: result.appended,
      blockId: result.blockId,
      flavour: result.flavour,
      type: result.blockType || null,
    });
  };
  server.registerTool(
    "append_block",
    {
      title: "Append Block",
      description: "Append a slash-command style block (heading/list/todo/code/divider/quote) to a document.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        type: AppendBlockType.describe("Block type to append"),
        text: z.string().optional().describe("Block content text"),
        checked: z.boolean().optional().describe("Todo state when type is todo"),
        language: z.string().optional().describe("Code language when type is code"),
        caption: z.string().optional().describe("Code caption when type is code"),
      },
    },
    appendBlockHandler as any
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
}
