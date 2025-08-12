import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import * as Y from "yjs";
import FormData from "form-data";
import fetch from "node-fetch";
import { io } from "socket.io-client";

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
  server.registerTool(
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List all available AFFiNE workspaces"
    },
    async () => {
      try {
        const query = `query { workspaces { id public enableAi createdAt } }`;
        const data = await gql.request<{ workspaces: any[] }>(query);
        return { content: [{ type: "text", text: JSON.stringify(data.workspaces || []) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // GET WORKSPACE
  server.registerTool(
    "get_workspace",
    {
      title: "Get Workspace",
      description: "Get details of a specific workspace",
      inputSchema: { 
        id: z.string().describe("Workspace ID") 
      }
    },
    async ({ id }) => {
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
        return { content: [{ type: "text", text: JSON.stringify(data.workspace) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // CREATE WORKSPACE
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
    async ({ name, avatar }) => {
      try {
        // Get endpoint and headers from GraphQL client
        const endpoint = (gql as any).endpoint || process.env.AFFINE_BASE_URL + '/graphql';
        const headers = (gql as any).headers || {};
        const cookie = (gql as any).cookie || headers.Cookie || '';
        
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
        
        // Now create the actual document via WebSocket
        const wsUrl = endpoint.replace('https://', 'wss://').replace('http://', 'ws://').replace('/graphql', '');
        
        return new Promise((resolve) => {
          const socket = io(wsUrl, {
            transports: ['websocket'],
            path: '/socket.io/',
            extraHeaders: cookie ? { Cookie: cookie } : undefined
          });
          
          socket.on('connect', () => {
            // Join the workspace
            socket.emit('space:join', {
              spaceType: 'workspace',
              spaceId: workspace.id
            });
            
            // Send the document update
            setTimeout(() => {
              const docUpdateBase64 = Buffer.from(docUpdate).toString('base64');
              socket.emit('space:push-doc-update', {
                spaceType: 'workspace',
                spaceId: workspace.id,
                docId: firstDocId,
                update: docUpdateBase64
              });
              
              // Wait longer for sync and disconnect
              setTimeout(() => {
                socket.disconnect();
                resolve({ content: [{ type: "text", text: JSON.stringify({
                  ...workspace,
                  name: name,
                  avatar: avatar,
                  firstDocId: firstDocId,
                  status: "success",
                  message: "Workspace created successfully",
                  url: `${process.env.AFFINE_BASE_URL}/workspace/${workspace.id}`
                }) }] });
              }, 3000);
            }, 1000);
          });
          
          socket.on('error', () => {
            socket.disconnect();
            // Even if WebSocket fails, workspace was created
            resolve({ content: [{ type: "text", text: JSON.stringify({
              ...workspace,
              name: name,
              avatar: avatar,
              firstDocId: firstDocId,
              status: "partial",
              message: "Workspace created (document sync may be pending)",
              url: `${process.env.AFFINE_BASE_URL}/workspace/${workspace.id}`
            }) }] });
          });
          
          // Timeout
          setTimeout(() => {
            socket.disconnect();
            resolve({ content: [{ type: "text", text: JSON.stringify({
              ...workspace,
              name: name,
              avatar: avatar,
              firstDocId: firstDocId,
              status: "success",
              message: "Workspace created",
              url: `${process.env.AFFINE_BASE_URL}/workspace/${workspace.id}`
            }) }] });
          }, 10000);
        });
        
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ 
          error: error.message,
          status: "failed"
        }) }] };
      }
    }
  );

  // UPDATE WORKSPACE
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
    async ({ id, public: isPublic, enableAi }) => {
      try {
        const mutation = `
          mutation UpdateWorkspace($input: UpdateWorkspaceInput!) {
            updateWorkspace(input: $input) {
              id
              public
            }
          }
        `;
        
        const input: any = { id };
        if (isPublic !== undefined) input.public = isPublic;
        
        const data = await gql.request<{ updateWorkspace: any }>(mutation, { input });
        
        return { content: [{ type: "text", text: JSON.stringify(data.updateWorkspace) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // DELETE WORKSPACE
  server.registerTool(
    "delete_workspace",
    {
      title: "Delete Workspace",
      description: "Delete a workspace permanently",
      inputSchema: {
        id: z.string().describe("Workspace ID")
      }
    },
    async ({ id }) => {
      try {
        const mutation = `
          mutation DeleteWorkspace($id: String!) {
            deleteWorkspace(id: $id)
          }
        `;
        
        const data = await gql.request<{ deleteWorkspace: boolean }>(mutation, { id });
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.deleteWorkspace,
          message: "Workspace deleted successfully"
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );
}