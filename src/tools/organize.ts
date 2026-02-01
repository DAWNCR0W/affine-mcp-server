import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, WorkspaceSocket } from "../ws.js";
import * as Y from "yjs";

// ============================================================================
// Types
// ============================================================================

interface Tag {
  id: string;
  value: string;
  color: string;
  createDate?: number;
  updateDate?: number;
  parentId?: string;
}

interface Collection {
  id: string;
  name: string;
  rules: { filters: any[] };
  allowList: string[];
}

interface FolderNode {
  id: string;
  parentId: string | null;
  type: 'folder' | 'doc' | 'tag' | 'collection';
  data: string;
  index: string;
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

/**
 * Generate a fractional index for ordering.
 */
function generateIndex(beforeIndex?: string, afterIndex?: string): string {
  if (!beforeIndex && !afterIndex) return 'a0';
  
  if (!beforeIndex) {
    const firstChar = afterIndex!.charCodeAt(0);
    if (firstChar > 97) {
      return String.fromCharCode(firstChar - 1) + '0';
    }
    return 'a0' + afterIndex;
  }
  
  if (!afterIndex) {
    const lastChar = beforeIndex.charCodeAt(beforeIndex.length - 1);
    if (lastChar < 122) {
      return beforeIndex.slice(0, -1) + String.fromCharCode(lastChar + 1);
    }
    return beforeIndex + '0';
  }
  
  return beforeIndex + 'V';
}

async function getCookieAndEndpoint(gql: GraphQLClient) {
  const endpoint = (gql as any).endpoint || process.env.AFFINE_BASE_URL + '/graphql';
  const headers = (gql as any).headers || {};
  const cookie = (gql as any).cookie || headers.Cookie || '';
  return { endpoint, cookie };
}

async function loadWorkspaceRootDoc(socket: WorkspaceSocket, workspaceId: string): Promise<{ doc: Y.Doc; prevState: Uint8Array }> {
  const doc = new Y.Doc();
  const snapshot = await loadDoc(socket, workspaceId, workspaceId);
  if (snapshot.missing) {
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
  }
  const prevState = Y.encodeStateVector(doc);
  return { doc, prevState };
}

async function loadFoldersDoc(socket: WorkspaceSocket, workspaceId: string): Promise<{ doc: Y.Doc; prevState: Uint8Array }> {
  const doc = new Y.Doc();
  const snapshot = await loadDoc(socket, workspaceId, 'db$folders');
  if (snapshot.missing) {
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
  }
  const prevState = Y.encodeStateVector(doc);
  return { doc, prevState };
}

async function pushDelta(socket: WorkspaceSocket, workspaceId: string, docId: string, doc: Y.Doc, prevState: Uint8Array): Promise<void> {
  const delta = Y.encodeStateAsUpdate(doc, prevState);
  const deltaB64 = Buffer.from(delta).toString('base64');
  await pushDocUpdate(socket, workspaceId, docId, deltaB64);
}

// ============================================================================
// Register All Organize Tools
// ============================================================================

export function registerOrganizeTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {

  // =========================================================================
  // Tag Operations
  // =========================================================================

  // -------------------------------------------------------------------------
  // LIST TAGS
  // -------------------------------------------------------------------------
  const listTagsHandler = async (parsed: { workspaceId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, workspaceId);

      const meta = doc.getMap('meta');
      const properties = meta.get('properties') as Y.Map<any> | undefined;
      const tagsConfig = properties?.get('tags') as Y.Map<any> | undefined;
      const options = tagsConfig?.get('options') as Y.Array<any> | undefined;

      const tags: Tag[] = [];
      if (options) {
        options.forEach((item: any) => {
          if (item instanceof Y.Map) {
            tags.push({
              id: item.get('id'),
              value: item.get('value'),
              color: item.get('color'),
              createDate: item.get('createDate'),
              updateDate: item.get('updateDate'),
              parentId: item.get('parentId'),
            });
          }
        });
      }

      return text({ tags });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('list_tags', {
    title: 'List Tags',
    description: 'List all tags in a workspace',
    inputSchema: { workspaceId: z.string().optional() },
  }, listTagsHandler as any);

  server.registerTool('affine_list_tags', {
    title: 'List Tags',
    description: 'List all tags in a workspace',
    inputSchema: { workspaceId: z.string().optional() },
  }, listTagsHandler as any);

  // -------------------------------------------------------------------------
  // CREATE TAG
  // -------------------------------------------------------------------------
  const createTagHandler = async (parsed: { workspaceId?: string; name: string; color?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const meta = doc.getMap('meta');
      let properties = meta.get('properties') as Y.Map<any> | undefined;
      if (!properties) {
        properties = new Y.Map();
        meta.set('properties', properties);
      }

      let tagsConfig = properties.get('tags') as Y.Map<any> | undefined;
      if (!tagsConfig) {
        tagsConfig = new Y.Map();
        properties.set('tags', tagsConfig);
      }

      let options = tagsConfig.get('options') as Y.Array<any> | undefined;
      if (!options) {
        options = new Y.Array();
        tagsConfig.set('options', options);
      }

      const tagId = generateId();
      const now = Date.now();
      const tagMap = new Y.Map();
      tagMap.set('id', tagId);
      tagMap.set('value', parsed.name);
      tagMap.set('color', parsed.color || 'blue');
      tagMap.set('createDate', now);
      tagMap.set('updateDate', now);

      options.push([tagMap]);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ tagId, name: parsed.name, color: parsed.color || 'blue' });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('create_tag', {
    title: 'Create Tag',
    description: 'Create a new tag in a workspace',
    inputSchema: {
      workspaceId: z.string().optional(),
      name: z.string().min(1, "Tag name is required"),
      color: z.string().optional().describe("Tag color (e.g., 'blue', 'red', 'green')"),
    },
  }, createTagHandler as any);

  server.registerTool('affine_create_tag', {
    title: 'Create Tag',
    description: 'Create a new tag in a workspace',
    inputSchema: {
      workspaceId: z.string().optional(),
      name: z.string().min(1, "Tag name is required"),
      color: z.string().optional().describe("Tag color (e.g., 'blue', 'red', 'green')"),
    },
  }, createTagHandler as any);

  // -------------------------------------------------------------------------
  // UPDATE TAG
  // -------------------------------------------------------------------------
  const updateTagHandler = async (parsed: { workspaceId?: string; tagId: string; name?: string; color?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const meta = doc.getMap('meta');
      const properties = meta.get('properties') as Y.Map<any> | undefined;
      const tagsConfig = properties?.get('tags') as Y.Map<any> | undefined;
      const options = tagsConfig?.get('options') as Y.Array<any> | undefined;

      if (!options) throw new Error("No tags found in workspace");

      let found = false;
      options.forEach((item: any) => {
        if (found) return;
        const tagMap = item as Y.Map<any>;
        if (tagMap.get && tagMap.get('id') === parsed.tagId) {
          if (parsed.name !== undefined) tagMap.set('value', parsed.name);
          if (parsed.color !== undefined) tagMap.set('color', parsed.color);
          tagMap.set('updateDate', Date.now());
          found = true;
        }
      });

      if (!found) throw new Error(`Tag with id '${parsed.tagId}' not found`);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ updated: true, tagId: parsed.tagId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('update_tag', {
    title: 'Update Tag',
    description: 'Update a tag name and/or color',
    inputSchema: {
      workspaceId: z.string().optional(),
      tagId: z.string().min(1, "Tag ID is required"),
      name: z.string().optional(),
      color: z.string().optional(),
    },
  }, updateTagHandler as any);

  server.registerTool('affine_update_tag', {
    title: 'Update Tag',
    description: 'Update a tag name and/or color',
    inputSchema: {
      workspaceId: z.string().optional(),
      tagId: z.string().min(1, "Tag ID is required"),
      name: z.string().optional(),
      color: z.string().optional(),
    },
  }, updateTagHandler as any);

  // -------------------------------------------------------------------------
  // DELETE TAG
  // -------------------------------------------------------------------------
  const deleteTagHandler = async (parsed: { workspaceId?: string; tagId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const meta = doc.getMap('meta');
      const properties = meta.get('properties') as Y.Map<any> | undefined;
      const tagsConfig = properties?.get('tags') as Y.Map<any> | undefined;
      const options = tagsConfig?.get('options') as Y.Array<any> | undefined;

      if (!options) throw new Error("No tags found in workspace");

      let foundIndex = -1;
      options.forEach((item: any, index: number) => {
        if (foundIndex >= 0) return;
        const tagMap = item as Y.Map<any>;
        if (tagMap.get && tagMap.get('id') === parsed.tagId) {
          foundIndex = index;
        }
      });

      if (foundIndex < 0) throw new Error(`Tag with id '${parsed.tagId}' not found`);

      options.delete(foundIndex, 1);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ deleted: true, tagId: parsed.tagId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('delete_tag', {
    title: 'Delete Tag',
    description: 'Delete a tag from a workspace',
    inputSchema: {
      workspaceId: z.string().optional(),
      tagId: z.string().min(1, "Tag ID is required"),
    },
  }, deleteTagHandler as any);

  server.registerTool('affine_delete_tag', {
    title: 'Delete Tag',
    description: 'Delete a tag from a workspace',
    inputSchema: {
      workspaceId: z.string().optional(),
      tagId: z.string().min(1, "Tag ID is required"),
    },
  }, deleteTagHandler as any);

  // =========================================================================
  // Collection Operations
  // =========================================================================

  // -------------------------------------------------------------------------
  // LIST COLLECTIONS
  // -------------------------------------------------------------------------
  const listCollectionsHandler = async (parsed: { workspaceId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, workspaceId);

      const setting = doc.getMap('setting');
      const collections = setting.get('collections') as Y.Array<any> | undefined;

      const result: Collection[] = [];
      if (collections) {
        collections.forEach((item: any) => {
          if (item instanceof Y.Map) {
            const rules = item.get('rules');
            const allowList = item.get('allowList');
            result.push({
              id: item.get('id'),
              name: item.get('name'),
              rules: rules instanceof Y.Map ? rules.toJSON() : (rules || { filters: [] }),
              allowList: allowList instanceof Y.Array ? allowList.toArray() : (allowList || []),
            });
          } else if (typeof item === 'object') {
            result.push(item as Collection);
          }
        });
      }

      return text({ collections: result });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('list_collections', {
    title: 'List Collections',
    description: 'List all collections in a workspace',
    inputSchema: { workspaceId: z.string().optional() },
  }, listCollectionsHandler as any);

  server.registerTool('affine_list_collections', {
    title: 'List Collections',
    description: 'List all collections in a workspace',
    inputSchema: { workspaceId: z.string().optional() },
  }, listCollectionsHandler as any);

  // -------------------------------------------------------------------------
  // CREATE COLLECTION
  // -------------------------------------------------------------------------
  const createCollectionHandler = async (parsed: { workspaceId?: string; name: string; docIds?: string[] }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const setting = doc.getMap('setting');
      let collections = setting.get('collections') as Y.Array<any> | undefined;
      if (!collections) {
        collections = new Y.Array();
        setting.set('collections', collections);
      }

      const collectionId = generateId();
      const collection = new Y.Map();
      collection.set('id', collectionId);
      collection.set('name', parsed.name);

      const rules = new Y.Map();
      rules.set('filters', new Y.Array());
      collection.set('rules', rules);

      const allowList = new Y.Array();
      if (parsed.docIds && parsed.docIds.length > 0) {
        allowList.push(parsed.docIds);
      }
      collection.set('allowList', allowList);

      collections.push([collection as any]);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ collectionId, name: parsed.name, allowList: parsed.docIds || [] });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('create_collection', {
    title: 'Create Collection',
    description: 'Create a new collection with optional initial docs',
    inputSchema: {
      workspaceId: z.string().optional(),
      name: z.string().min(1, "Collection name is required"),
      docIds: z.array(z.string()).optional().describe("Initial doc IDs to add to collection"),
    },
  }, createCollectionHandler as any);

  server.registerTool('affine_create_collection', {
    title: 'Create Collection',
    description: 'Create a new collection with optional initial docs',
    inputSchema: {
      workspaceId: z.string().optional(),
      name: z.string().min(1, "Collection name is required"),
      docIds: z.array(z.string()).optional().describe("Initial doc IDs to add to collection"),
    },
  }, createCollectionHandler as any);

  // -------------------------------------------------------------------------
  // UPDATE COLLECTION
  // -------------------------------------------------------------------------
  const updateCollectionHandler = async (parsed: { workspaceId?: string; collectionId: string; name?: string; allowList?: string[] }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const setting = doc.getMap('setting');
      const collections = setting.get('collections') as Y.Array<any> | undefined;

      if (!collections) throw new Error("No collections found in workspace");

      let found = false;
      collections.forEach((item: any) => {
        if (found) return;
        const collMap = item as Y.Map<any>;
        if (collMap.get && collMap.get('id') === parsed.collectionId) {
          if (parsed.name !== undefined) collMap.set('name', parsed.name);
          if (parsed.allowList !== undefined) {
            const newAllowList = new Y.Array();
            newAllowList.push(parsed.allowList);
            collMap.set('allowList', newAllowList);
          }
          found = true;
        }
      });

      if (!found) throw new Error(`Collection with id '${parsed.collectionId}' not found`);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ updated: true, collectionId: parsed.collectionId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('update_collection', {
    title: 'Update Collection',
    description: 'Update a collection name and/or allowList',
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
      name: z.string().optional(),
      allowList: z.array(z.string()).optional().describe("Replace the allowList with these doc IDs"),
    },
  }, updateCollectionHandler as any);

  server.registerTool('affine_update_collection', {
    title: 'Update Collection',
    description: 'Update a collection name and/or allowList',
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
      name: z.string().optional(),
      allowList: z.array(z.string()).optional().describe("Replace the allowList with these doc IDs"),
    },
  }, updateCollectionHandler as any);

  // -------------------------------------------------------------------------
  // DELETE COLLECTION
  // -------------------------------------------------------------------------
  const deleteCollectionHandler = async (parsed: { workspaceId?: string; collectionId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const setting = doc.getMap('setting');
      const collections = setting.get('collections') as Y.Array<any> | undefined;

      if (!collections) throw new Error("No collections found in workspace");

      let foundIndex = -1;
      collections.forEach((item: any, index: number) => {
        if (foundIndex >= 0) return;
        const collMap = item as Y.Map<any>;
        if (collMap.get && collMap.get('id') === parsed.collectionId) {
          foundIndex = index;
        }
      });

      if (foundIndex < 0) throw new Error(`Collection with id '${parsed.collectionId}' not found`);

      collections.delete(foundIndex, 1);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ deleted: true, collectionId: parsed.collectionId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('delete_collection', {
    title: 'Delete Collection',
    description: 'Delete a collection from a workspace',
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
    },
  }, deleteCollectionHandler as any);

  server.registerTool('affine_delete_collection', {
    title: 'Delete Collection',
    description: 'Delete a collection from a workspace',
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
    },
  }, deleteCollectionHandler as any);

  // -------------------------------------------------------------------------
  // ADD DOC TO COLLECTION
  // -------------------------------------------------------------------------
  const addDocToCollectionHandler = async (parsed: { workspaceId?: string; collectionId: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const setting = doc.getMap('setting');
      const collections = setting.get('collections') as Y.Array<any> | undefined;

      if (!collections) throw new Error("No collections found in workspace");

      let found = false;
      collections.forEach((item: any) => {
        if (found) return;
        const collMap = item as Y.Map<any>;
        if (collMap.get && collMap.get('id') === parsed.collectionId) {
          let allowList = collMap.get('allowList') as Y.Array<string> | undefined;
          if (!allowList) {
            allowList = new Y.Array();
            collMap.set('allowList', allowList);
          }
          const existing = allowList.toArray();
          if (!existing.includes(parsed.docId)) {
            allowList.push([parsed.docId]);
          }
          found = true;
        }
      });

      if (!found) throw new Error(`Collection with id '${parsed.collectionId}' not found`);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ added: true, collectionId: parsed.collectionId, docId: parsed.docId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('add_doc_to_collection', {
    title: 'Add Doc to Collection',
    description: "Add a document to a collection's allowList",
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
      docId: z.string().min(1, "Doc ID is required"),
    },
  }, addDocToCollectionHandler as any);

  server.registerTool('affine_add_doc_to_collection', {
    title: 'Add Doc to Collection',
    description: "Add a document to a collection's allowList",
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
      docId: z.string().min(1, "Doc ID is required"),
    },
  }, addDocToCollectionHandler as any);

  // -------------------------------------------------------------------------
  // REMOVE DOC FROM COLLECTION
  // -------------------------------------------------------------------------
  const removeDocFromCollectionHandler = async (parsed: { workspaceId?: string; collectionId: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadWorkspaceRootDoc(socket, workspaceId);

      const setting = doc.getMap('setting');
      const collections = setting.get('collections') as Y.Array<any> | undefined;

      if (!collections) throw new Error("No collections found in workspace");

      let found = false;
      let removed = false;
      collections.forEach((item: any) => {
        if (found) return;
        const collMap = item as Y.Map<any>;
        if (collMap.get && collMap.get('id') === parsed.collectionId) {
          const allowList = collMap.get('allowList') as Y.Array<string> | undefined;
          if (allowList) {
            const arr = allowList.toArray();
            const idx = arr.indexOf(parsed.docId);
            if (idx >= 0) {
              allowList.delete(idx, 1);
              removed = true;
            }
          }
          found = true;
        }
      });

      if (!found) throw new Error(`Collection with id '${parsed.collectionId}' not found`);

      await pushDelta(socket, workspaceId, workspaceId, doc, prevState);

      return text({ removed, collectionId: parsed.collectionId, docId: parsed.docId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('remove_doc_from_collection', {
    title: 'Remove Doc from Collection',
    description: "Remove a document from a collection's allowList",
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
      docId: z.string().min(1, "Doc ID is required"),
    },
  }, removeDocFromCollectionHandler as any);

  server.registerTool('affine_remove_doc_from_collection', {
    title: 'Remove Doc from Collection',
    description: "Remove a document from a collection's allowList",
    inputSchema: {
      workspaceId: z.string().optional(),
      collectionId: z.string().min(1, "Collection ID is required"),
      docId: z.string().min(1, "Doc ID is required"),
    },
  }, removeDocFromCollectionHandler as any);

  // =========================================================================
  // Folder Operations
  // =========================================================================

  // -------------------------------------------------------------------------
  // LIST FOLDERS
  // -------------------------------------------------------------------------
  const listFoldersHandler = async (parsed: { workspaceId?: string; parentId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc } = await loadFoldersDoc(socket, workspaceId);

      const nodes: FolderNode[] = [];
      const targetParentId = parsed.parentId || null;

      doc.share.forEach((value, key) => {
        if (value instanceof Y.Map) {
          const parentId = value.get('parentId') as string | null;
          if (parentId === targetParentId) {
            nodes.push({
              id: value.get('id') as string,
              parentId: parentId,
              type: value.get('type') as 'folder' | 'doc' | 'tag' | 'collection',
              data: value.get('data') as string,
              index: value.get('index') as string,
            });
          }
        }
      });

      nodes.sort((a, b) => a.index.localeCompare(b.index));

      return text({ nodes });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('list_folders', {
    title: 'List Folders',
    description: 'List all folders and links at root or under a parent folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      parentId: z.string().optional().describe("Parent folder ID (null/omit for root)"),
    },
  }, listFoldersHandler as any);

  server.registerTool('affine_list_folders', {
    title: 'List Folders',
    description: 'List all folders and links at root or under a parent folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      parentId: z.string().optional().describe("Parent folder ID (null/omit for root)"),
    },
  }, listFoldersHandler as any);

  // -------------------------------------------------------------------------
  // CREATE FOLDER
  // -------------------------------------------------------------------------
  const createFolderHandler = async (parsed: { workspaceId?: string; name: string; parentId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadFoldersDoc(socket, workspaceId);

      const folderId = generateId();
      const folderMap = doc.getMap(folderId);
      folderMap.set('id', folderId);
      folderMap.set('parentId', parsed.parentId || null);
      folderMap.set('type', 'folder');
      folderMap.set('data', parsed.name);
      folderMap.set('index', generateIndex());

      await pushDelta(socket, workspaceId, 'db$folders', doc, prevState);

      return text({ folderId, name: parsed.name, parentId: parsed.parentId || null });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('create_folder', {
    title: 'Create Folder',
    description: 'Create a new folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      name: z.string().min(1, "Folder name is required"),
      parentId: z.string().optional().describe("Parent folder ID (omit for root)"),
    },
  }, createFolderHandler as any);

  server.registerTool('affine_create_folder', {
    title: 'Create Folder',
    description: 'Create a new folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      name: z.string().min(1, "Folder name is required"),
      parentId: z.string().optional().describe("Parent folder ID (omit for root)"),
    },
  }, createFolderHandler as any);

  // -------------------------------------------------------------------------
  // RENAME FOLDER
  // -------------------------------------------------------------------------
  const renameFolderHandler = async (parsed: { workspaceId?: string; folderId: string; name: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadFoldersDoc(socket, workspaceId);

      const folderMap = doc.getMap(parsed.folderId);
      if (!folderMap.get('id')) throw new Error(`Folder with id '${parsed.folderId}' not found`);
      if (folderMap.get('type') !== 'folder') throw new Error(`Node '${parsed.folderId}' is not a folder`);

      folderMap.set('data', parsed.name);

      await pushDelta(socket, workspaceId, 'db$folders', doc, prevState);

      return text({ renamed: true, folderId: parsed.folderId, name: parsed.name });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('rename_folder', {
    title: 'Rename Folder',
    description: 'Rename a folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().min(1, "Folder ID is required"),
      name: z.string().min(1, "New name is required"),
    },
  }, renameFolderHandler as any);

  server.registerTool('affine_rename_folder', {
    title: 'Rename Folder',
    description: 'Rename a folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().min(1, "Folder ID is required"),
      name: z.string().min(1, "New name is required"),
    },
  }, renameFolderHandler as any);

  // -------------------------------------------------------------------------
  // DELETE FOLDER
  // -------------------------------------------------------------------------
  const deleteFolderHandler = async (parsed: { workspaceId?: string; folderId: string; recursive?: boolean }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadFoldersDoc(socket, workspaceId);

      const toDelete: string[] = [parsed.folderId];

      if (parsed.recursive !== false) {
        const findChildren = (parentId: string) => {
          doc.share.forEach((value, key) => {
            if (value instanceof Y.Map && value.get('parentId') === parentId) {
              const childId = value.get('id') as string;
              toDelete.push(childId);
              if (value.get('type') === 'folder') {
                findChildren(childId);
              }
            }
          });
        };
        findChildren(parsed.folderId);
      }

      for (const id of toDelete) {
        const map = doc.getMap(id);
        map.forEach((_, key) => {
          map.delete(key);
        });
      }

      await pushDelta(socket, workspaceId, 'db$folders', doc, prevState);

      return text({ deleted: true, folderId: parsed.folderId, deletedCount: toDelete.length });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('delete_folder', {
    title: 'Delete Folder',
    description: 'Delete a folder and optionally its children',
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().min(1, "Folder ID is required"),
      recursive: z.boolean().optional().describe("Delete children recursively (default: true)"),
    },
  }, deleteFolderHandler as any);

  server.registerTool('affine_delete_folder', {
    title: 'Delete Folder',
    description: 'Delete a folder and optionally its children',
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().min(1, "Folder ID is required"),
      recursive: z.boolean().optional().describe("Delete children recursively (default: true)"),
    },
  }, deleteFolderHandler as any);

  // -------------------------------------------------------------------------
  // ADD DOC TO FOLDER
  // -------------------------------------------------------------------------
  const addDocToFolderHandler = async (parsed: { workspaceId?: string; folderId: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevState } = await loadFoldersDoc(socket, workspaceId);

      const nodeId = generateId();
      const nodeMap = doc.getMap(nodeId);
      nodeMap.set('id', nodeId);
      nodeMap.set('parentId', parsed.folderId);
      nodeMap.set('type', 'doc');
      nodeMap.set('data', parsed.docId);
      nodeMap.set('index', generateIndex());

      await pushDelta(socket, workspaceId, 'db$folders', doc, prevState);

      return text({ added: true, folderId: parsed.folderId, docId: parsed.docId, nodeId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('add_doc_to_folder', {
    title: 'Add Doc to Folder',
    description: 'Add a document link to a folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().min(1, "Folder ID is required"),
      docId: z.string().min(1, "Doc ID is required"),
    },
  }, addDocToFolderHandler as any);

  server.registerTool('affine_add_doc_to_folder', {
    title: 'Add Doc to Folder',
    description: 'Add a document link to a folder',
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().min(1, "Folder ID is required"),
      docId: z.string().min(1, "Doc ID is required"),
    },
  }, addDocToFolderHandler as any);

  // -------------------------------------------------------------------------
  // ASSIGN TAG TO DOC
  // -------------------------------------------------------------------------
  const assignTagToDocHandler = async (parsed: { workspaceId?: string; docId: string; tagId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      
      const docYdoc = new Y.Doc();
      const docSnapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (docSnapshot.missing) {
        Y.applyUpdate(docYdoc, Buffer.from(docSnapshot.missing, 'base64'));
      }
      const docPrevState = Y.encodeStateVector(docYdoc);

      const meta = docYdoc.getMap('meta');
      let tags = meta.get('tags') as Y.Array<any> | undefined;
      if (!tags) {
        tags = new Y.Array();
        meta.set('tags', tags);
      }

      let alreadyAssigned = false;
      tags.forEach((t: any) => {
        if (t === parsed.tagId) alreadyAssigned = true;
      });

      if (!alreadyAssigned) {
        tags.push([parsed.tagId]);
      }

      await pushDelta(socket, workspaceId, parsed.docId, docYdoc, docPrevState);

      return text({ assigned: true, docId: parsed.docId, tagId: parsed.tagId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('assign_tag_to_doc', {
    title: 'Assign Tag to Doc',
    description: 'Assign a tag to a document',
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().min(1, "Doc ID is required"),
      tagId: z.string().min(1, "Tag ID is required"),
    },
  }, assignTagToDocHandler as any);

  server.registerTool('affine_assign_tag_to_doc', {
    title: 'Assign Tag to Doc',
    description: 'Assign a tag to a document',
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().min(1, "Doc ID is required"),
      tagId: z.string().min(1, "Tag ID is required"),
    },
  }, assignTagToDocHandler as any);

  // -------------------------------------------------------------------------
  // REMOVE TAG FROM DOC
  // -------------------------------------------------------------------------
  const removeTagFromDocHandler = async (parsed: { workspaceId?: string; docId: string; tagId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie } = await getCookieAndEndpoint(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie);

    try {
      await joinWorkspace(socket, workspaceId);
      
      const docYdoc = new Y.Doc();
      const docSnapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (docSnapshot.missing) {
        Y.applyUpdate(docYdoc, Buffer.from(docSnapshot.missing, 'base64'));
      }
      const docPrevState = Y.encodeStateVector(docYdoc);

      const meta = docYdoc.getMap('meta');
      const tags = meta.get('tags') as Y.Array<any> | undefined;

      if (tags) {
        let foundIndex = -1;
        tags.forEach((t: any, index: number) => {
          if (foundIndex >= 0) return;
          if (t === parsed.tagId) foundIndex = index;
        });

        if (foundIndex >= 0) {
          tags.delete(foundIndex, 1);
        }
      }

      await pushDelta(socket, workspaceId, parsed.docId, docYdoc, docPrevState);

      return text({ removed: true, docId: parsed.docId, tagId: parsed.tagId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool('remove_tag_from_doc', {
    title: 'Remove Tag from Doc',
    description: 'Remove a tag from a document',
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().min(1, "Doc ID is required"),
      tagId: z.string().min(1, "Tag ID is required"),
    },
  }, removeTagFromDocHandler as any);

  server.registerTool('affine_remove_tag_from_doc', {
    title: 'Remove Tag from Doc',
    description: 'Remove a tag from a document',
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().min(1, "Doc ID is required"),
      tagId: z.string().min(1, "Tag ID is required"),
    },
  }, removeTagFromDocHandler as any);
}
