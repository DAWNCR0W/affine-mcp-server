import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import * as Y from "yjs";
import FormData from "form-data";
import fetch from "node-fetch";
import { text } from "../util/mcp.js";
import { connectWorkspaceSocket, joinWorkspace, pushDocUpdate, wsUrlFromGraphQLEndpoint } from "../ws.js";

// Generate AFFiNE-style document ID
function generateDocId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let id = '';
  for (let i = 0; i < 10; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// Create initial workspace data with a document
function createInitialWorkspaceData(workspaceName: string = 'New Workspace') {
  // Create workspace root YDoc
  const rootDoc = new Y.Doc();
  
  // Set workspace metadata
  const meta = rootDoc.getMap('meta');
  meta.set('name', workspaceName);
  meta.set('avatar', '');
  
  // Create pages array with initial document
  const pages = new Y.Array();
  const firstDocId = generateDocId();
  
  // Add first document metadata
  const pageMetadata = new Y.Map();
  pageMetadata.set('id', firstDocId);
  pageMetadata.set('title', 'Welcome to ' + workspaceName);
  pageMetadata.set('createDate', Date.now());
  pageMetadata.set('tags', new Y.Array());
  
  pages.push([pageMetadata]);
  meta.set('pages', pages);
  
  // Create settings
  const setting = rootDoc.getMap('setting');
  setting.set('collections', new Y.Array());
  
  // Encode workspace update
  const workspaceUpdate = Y.encodeStateAsUpdate(rootDoc);
  
  // Create the actual document
  const docYDoc = new Y.Doc();
  const blocks = docYDoc.getMap('blocks');
  
  // Create page block with proper structure
  const pageId = generateDocId();
  const pageBlock = new Y.Map();
  pageBlock.set('sys:id', pageId);
  pageBlock.set('sys:flavour', 'affine:page');
  
  // Title as Y.Text
  const titleText = new Y.Text();
  titleText.insert(0, 'Welcome to ' + workspaceName);
  pageBlock.set('prop:title', titleText);
  
  // Children
  const pageChildren = new Y.Array();
  pageBlock.set('sys:children', pageChildren);
  
  blocks.set(pageId, pageBlock);
  
  // Add surface block (required)
  const surfaceId = generateDocId();
  const surfaceBlock = new Y.Map();
  surfaceBlock.set('sys:id', surfaceId);
  surfaceBlock.set('sys:flavour', 'affine:surface');
  surfaceBlock.set('sys:parent', pageId);
  surfaceBlock.set('sys:children', new Y.Array());
  
  blocks.set(surfaceId, surfaceBlock);
  pageChildren.push([surfaceId]);
  
  // Add note block with xywh
  const noteId = generateDocId();
  const noteBlock = new Y.Map();
  noteBlock.set('sys:id', noteId);
  noteBlock.set('sys:flavour', 'affine:note');
  noteBlock.set('sys:parent', pageId);
  noteBlock.set('prop:displayMode', 'DocAndEdgeless');
  noteBlock.set('prop:xywh', '[0,0,800,600]');
  noteBlock.set('prop:index', 'a0');
  noteBlock.set('prop:lockedBySelf', false);
  
  const noteChildren = new Y.Array();
  noteBlock.set('sys:children', noteChildren);
  
  blocks.set(noteId, noteBlock);
  pageChildren.push([noteId]);
  
  // Add initial paragraph
  const paragraphId = generateDocId();
  const paragraphBlock = new Y.Map();
  paragraphBlock.set('sys:id', paragraphId);
  paragraphBlock.set('sys:flavour', 'affine:paragraph');
  paragraphBlock.set('sys:parent', noteId);
  paragraphBlock.set('sys:children', new Y.Array());
  paragraphBlock.set('prop:type', 'text');
  
  const paragraphText = new Y.Text();
  paragraphText.insert(0, 'This workspace was created by AFFiNE MCP Server');
  paragraphBlock.set('prop:text', paragraphText);
  
  blocks.set(paragraphId, paragraphBlock);
  noteChildren.push([paragraphId]);
  
  // Set document metadata
  const docMeta = docYDoc.getMap('meta');
  docMeta.set('id', firstDocId);
  docMeta.set('title', 'Welcome to ' + workspaceName);
  docMeta.set('createDate', Date.now());
  docMeta.set('tags', new Y.Array());
  docMeta.set('version', 1);
  
  // Encode document update
  const docUpdate = Y.encodeStateAsUpdate(docYDoc);
  
  return {
    workspaceUpdate,
    firstDocId,
    docUpdate
  };
}

export function registerWorkspaceTools(server: McpServer, gql: GraphQLClient) {
  // LIST WORKSPACES
  const listWorkspacesHandler = async () => {
    try {
      const query = `query { workspaces { id public enableAi createdAt } }`;
      const data = await gql.request<{ workspaces: any[] }>(query);
      return text(data.workspaces || []);
    } catch (error: any) {
      return text({ error: error.message });
    }
  };

  server.registerTool(
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List all available AFFiNE workspaces"
    },
    listWorkspacesHandler as any
  );

  // GET WORKSPACE
  const getWorkspaceHandler = async ({ id }: { id: string }) => {
    try {
      const query = `query GetWorkspace($id: String!) { 
        workspace(id: $id) { 
          id 
          public 
          enableAi 
          createdAt
          permissions { 
            Workspace_Read 
            Workspace_CreateDoc 
          } 
        } 
      }`;
      const data = await gql.request<{ workspace: any }>(query, { id });
      return text(data.workspace);
    } catch (error: any) {
      return text({ error: error.message });
    }
  };

  server.registerTool(
    "get_workspace",
    {
      title: "Get Workspace",
      description: "Get details of a specific workspace",
      inputSchema: { 
        id: z.string().describe("Workspace ID") 
      }
    },
    getWorkspaceHandler as any
  );

  // CREATE WORKSPACE
  const createWorkspaceHandler = async ({ name, avatar }: { name: string; avatar?: string }) => {
      try {
        // Get endpoint and headers from GraphQL client
        const endpoint = gql.endpoint;
        const headers = gql.headers;
        const cookie = gql.cookie;
        const bearer = gql.bearer;
        
        // Create initial workspace data
        const { workspaceUpdate, firstDocId, docUpdate } = createInitialWorkspaceData(name);
        
        // Only send workspace update - document will be created separately
        const initData = Buffer.from(workspaceUpdate);
        
        // Create multipart form
        const form = new FormData();
        
        // Add GraphQL operation
        form.append('operations', JSON.stringify({
          name: 'createWorkspace',
          query: `mutation createWorkspace($init: Upload!) {
            createWorkspace(init: $init) {
              id
              public
              createdAt
              enableAi
            }
          }`,
          variables: { init: null }
        }));
        
        // Map file to variable
        form.append('map', JSON.stringify({ '0': ['variables.init'] }));
        
        // Add workspace init data
        form.append('0', initData, {
          filename: 'init.yjs',
          contentType: 'application/octet-stream'
        });
        
        // Send request
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            ...headers,
            'Cookie': cookie,
            ...form.getHeaders()
          },
          body: form as any
        });
        
        const result = await response.json() as any;
        
        if (result.errors) {
          throw new Error(result.errors[0].message);
        }
        
        const workspace = result.data.createWorkspace;
        const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
        const baseUrl = process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, '');

        try {
          const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
          try {
            await joinWorkspace(socket, workspace.id);
            const docUpdateBase64 = Buffer.from(docUpdate).toString('base64');
            await pushDocUpdate(socket, workspace.id, firstDocId, docUpdateBase64);
          } finally {
            socket.disconnect();
          }
        } catch (_wsError) {
          // Keep workspace creation successful even if initial websocket sync fails.
          return text({
            ...workspace,
            name,
            avatar,
            firstDocId,
            status: "partial",
            message: "Workspace created (document sync may be pending)",
            url: `${baseUrl}/workspace/${workspace.id}`
          });
        }

        return text({
          ...workspace,
          name,
          avatar,
          firstDocId,
          status: "success",
          message: "Workspace created successfully",
          url: `${baseUrl}/workspace/${workspace.id}`
        });
        
      } catch (error: any) {
        return text({ error: error.message, status: "failed" });
      }
    };

  server.registerTool(
    "create_workspace",
    {
      title: "Create Workspace",
      description: "Create a new workspace with initial document (accessible in UI)",
      inputSchema: {
        name: z.string().describe("Workspace name"),
        avatar: z.string().optional().describe("Avatar emoji or URL")
      }
    },
    createWorkspaceHandler as any
  );

  // UPDATE WORKSPACE
  const updateWorkspaceHandler = async ({ id, public: isPublic, enableAi }: { id: string; public?: boolean; enableAi?: boolean }) => {
      try {
        const mutation = `
          mutation UpdateWorkspace($input: UpdateWorkspaceInput!) {
            updateWorkspace(input: $input) {
              id
              public
              enableAi
            }
          }
        `;
        
        const input: any = { id };
        if (isPublic !== undefined) input.public = isPublic;
        if (enableAi !== undefined) input.enableAi = enableAi;
        
        const data = await gql.request<{ updateWorkspace: any }>(mutation, { input });
        
        return text(data.updateWorkspace);
      } catch (error: any) {
        return text({ error: error.message });
      }
    };
  server.registerTool(
    "update_workspace",
    {
      title: "Update Workspace",
      description: "Update workspace settings",
      inputSchema: {
        id: z.string().describe("Workspace ID"),
        public: z.boolean().optional().describe("Make workspace public"),
        enableAi: z.boolean().optional().describe("Enable AI features")
      }
    },
    updateWorkspaceHandler as any
  );

  // DELETE WORKSPACE
  const deleteWorkspaceHandler = async ({ id }: { id: string }) => {
      try {
        const mutation = `
          mutation DeleteWorkspace($id: String!) {
            deleteWorkspace(id: $id)
          }
        `;
        
        const data = await gql.request<{ deleteWorkspace: boolean }>(mutation, { id });
        
        return text({ success: data.deleteWorkspace, message: "Workspace deleted successfully" });
      } catch (error: any) {
        return text({ error: error.message });
      }
    };
  server.registerTool(
    "delete_workspace",
    {
      title: "Delete Workspace",
      description: "Delete a workspace permanently",
      inputSchema: {
        id: z.string().describe("Workspace ID")
      }
    },
    deleteWorkspaceHandler as any
  );
}
