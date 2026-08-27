import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import * as Y from "yjs";
import FormData from "form-data";
import fetch from "node-fetch";
import { receipt, text, toolError } from "../util/mcp.js";
import { secureAffineId } from "../util/random.js";
import {
  connectWorkspaceSocket,
  joinWorkspace,
  loadDoc,
  pushDocUpdate,
  wsUrlFromGraphQLEndpoint,
  type WorkspaceSocket,
} from "../ws.js";
import { requireMatchingConfirmation } from "../util/inputSchemas.js";

type WorkspaceRecord = Record<string, unknown> & { id: string };
type WorkspaceProfileStatus = "available" | "unavailable" | "skipped";

type WorkspaceSummary = WorkspaceRecord & {
  name: string | null;
  avatar: string | null;
  url: string;
  profileStatus: WorkspaceProfileStatus;
};

type WorkspaceToolDependencies = {
  connectWorkspaceSocket: typeof connectWorkspaceSocket;
  joinWorkspace: typeof joinWorkspace;
  loadDoc: typeof loadDoc;
};

const DEFAULT_WORKSPACE_TOOL_DEPENDENCIES: WorkspaceToolDependencies = {
  connectWorkspaceSocket,
  joinWorkspace,
  loadDoc,
};

function affineBaseUrl(endpoint: string): string {
  const configuredBaseUrl = process.env.AFFINE_BASE_URL?.trim();
  return (configuredBaseUrl || new URL(endpoint).origin).replace(/\/+$/, "");
}

function summarizeWorkspace(
  workspace: WorkspaceRecord,
  endpoint: string,
  profileStatus: WorkspaceProfileStatus,
  profile?: { name: string | null; avatar: string | null },
): WorkspaceSummary {
  const existingName = typeof workspace.name === "string" ? workspace.name : null;
  const existingAvatar = typeof workspace.avatar === "string" ? workspace.avatar : null;
  return {
    ...workspace,
    name: profile?.name ?? existingName,
    avatar: profile?.avatar ?? existingAvatar,
    url: `${affineBaseUrl(endpoint)}/workspace/${encodeURIComponent(workspace.id)}`,
    profileStatus,
  };
}

async function readWorkspaceProfile(
  socket: WorkspaceSocket,
  workspaceId: string,
  dependencies: WorkspaceToolDependencies,
): Promise<{ name: string | null; avatar: string | null }> {
  await dependencies.joinWorkspace(socket, workspaceId);
  const snapshot = await dependencies.loadDoc(socket, workspaceId, workspaceId);
  if (!snapshot.missing) {
    throw new Error(`Workspace profile metadata is unavailable for ${workspaceId}.`);
  }

  const workspaceDoc = new Y.Doc();
  Y.applyUpdate(workspaceDoc, Buffer.from(snapshot.missing, "base64"));
  const meta = workspaceDoc.getMap("meta");
  const name = meta.get("name");
  const avatar = meta.get("avatar");
  return {
    name: typeof name === "string" ? name : null,
    avatar: typeof avatar === "string" ? avatar : null,
  };
}

async function enrichWorkspaceProfiles(
  gql: GraphQLClient,
  workspaces: WorkspaceRecord[],
  includeProfile: boolean,
  dependencies: WorkspaceToolDependencies,
): Promise<WorkspaceSummary[]> {
  const endpoint = gql.endpoint;
  if (!includeProfile) {
    return workspaces.map(workspace => summarizeWorkspace(workspace, endpoint, "skipped"));
  }
  if (workspaces.length === 0) {
    return [];
  }

  let socket: WorkspaceSocket;
  try {
    const { endpoint: connectionEndpoint, cookie, bearer } = await gql.getConnectionAuth();
    socket = await dependencies.connectWorkspaceSocket(
      wsUrlFromGraphQLEndpoint(connectionEndpoint),
      cookie,
      bearer,
    );
  } catch {
    return workspaces.map(workspace => summarizeWorkspace(workspace, endpoint, "unavailable"));
  }

  try {
    const enriched: WorkspaceSummary[] = [];
    for (const workspace of workspaces) {
      try {
        const profile = await readWorkspaceProfile(socket, workspace.id, dependencies);
        enriched.push(summarizeWorkspace(workspace, endpoint, "available", profile));
      } catch {
        enriched.push(summarizeWorkspace(workspace, endpoint, "unavailable"));
      }
    }
    return enriched;
  } finally {
    socket.disconnect();
  }
}

const generateDocId = secureAffineId;

// Create initial workspace data with a document
function createInitialWorkspaceData(workspaceName: string = 'New Workspace', avatar: string = '') {
  // Create workspace root YDoc
  const rootDoc = new Y.Doc();
  
  // Set workspace metadata
  const meta = rootDoc.getMap('meta');
  meta.set('name', workspaceName);
  meta.set('avatar', avatar);
  
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
  surfaceBlock.set('sys:parent', null);
  surfaceBlock.set('sys:children', new Y.Array());
  
  blocks.set(surfaceId, surfaceBlock);
  pageChildren.push([surfaceId]);
  
  // Add note block with xywh
  const noteId = generateDocId();
  const noteBlock = new Y.Map();
  noteBlock.set('sys:id', noteId);
  noteBlock.set('sys:flavour', 'affine:note');
  noteBlock.set('sys:parent', null);
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
  paragraphBlock.set('sys:parent', null);
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

export function registerWorkspaceTools(
  server: McpServer,
  gql: GraphQLClient,
  dependencyOverrides: Partial<WorkspaceToolDependencies> = {},
) {
  const dependencies = {
    ...DEFAULT_WORKSPACE_TOOL_DEPENDENCIES,
    ...dependencyOverrides,
  };

  // LIST WORKSPACES
  const listWorkspacesHandler = async ({ includeProfile = true }: { includeProfile?: boolean } = {}) => {
    try {
      const query = `query { workspaces { id public enableAi createdAt } }`;
      const data = await gql.request<{ workspaces: WorkspaceRecord[] }>(query);
      const workspaces = await enrichWorkspaceProfiles(
        gql,
        data.workspaces || [],
        includeProfile,
        dependencies,
      );
      return text(workspaces);
    } catch (error: any) {
      return toolError(error, { code: "workspace_list_failed" });
    }
  };

  server.registerTool(
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List available AFFiNE workspaces with best-effort profile metadata and direct URLs",
      inputSchema: {
        includeProfile: z.boolean().optional().default(true).describe(
          "Load workspace names and avatar references from realtime metadata. Set false for a faster GraphQL-only response.",
        ),
      },
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
      const data = await gql.request<{ workspace: WorkspaceRecord }>(query, { id });
      if (!data.workspace || typeof data.workspace !== "object") {
        return text(data.workspace);
      }
      const [workspace] = await enrichWorkspaceProfiles(gql, [data.workspace], true, dependencies);
      return text(workspace);
    } catch (error: any) {
      return toolError(error, { code: "workspace_get_failed" });
    }
  };

  server.registerTool(
    "get_workspace",
    {
      title: "Get Workspace",
      description: "Get workspace details with best-effort profile metadata and a direct URL",
      inputSchema: { 
        id: z.string().describe("Workspace ID") 
      }
    },
    getWorkspaceHandler as any
  );

  // CREATE WORKSPACE
  const createWorkspaceHandler = async ({ name, avatar }: { name: string; avatar?: string }) => {
      try {
        // Wait for the shared auth session before multipart or WebSocket operations.
        const { endpoint, headers, cookie, bearer } = await gql.getConnectionAuth();
        
        // Create initial workspace data
        const { workspaceUpdate, firstDocId, docUpdate } = createInitialWorkspaceData(name, avatar || '');
        
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
        const baseUrl = affineBaseUrl(endpoint);

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
          return receipt("workspace.create", {
            workspaceId: workspace.id,
            ...workspace,
            name,
            avatar,
            firstDocId,
            syncStatus: "partial",
            status: "partial",
            message: "Workspace created (document sync may be pending)",
            url: `${baseUrl}/workspace/${workspace.id}`
          });
        }

        return receipt("workspace.create", {
          workspaceId: workspace.id,
          ...workspace,
          name,
          avatar,
          firstDocId,
          syncStatus: "success",
          status: "success",
          message: "Workspace created successfully",
          url: `${baseUrl}/workspace/${workspace.id}`
        });
        
      } catch (error: any) {
        return toolError(error, {
          code: "workspace_create_failed",
          data: {
            kind: "workspace.create",
            status: "failed",
          },
        });
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
        
        if (!data.updateWorkspace || typeof data.updateWorkspace !== "object") {
          return toolError("AFFiNE did not confirm the workspace update.", {
            code: "workspace_update_failed",
            data: { kind: "workspace.update", status: "not_applied", workspaceId: id, id },
          });
        }

        return receipt("workspace.update", {
          status: "updated",
          workspaceId: id,
          id,
          ...data.updateWorkspace,
        });
      } catch (error: any) {
        return toolError(error, {
          code: "workspace_update_failed",
          data: { kind: "workspace.update", status: "failed", workspaceId: id, id },
        });
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
  const deleteWorkspaceHandler = async ({ id, confirmWorkspaceId }: { id: string; confirmWorkspaceId?: string }) => {
      try {
        requireMatchingConfirmation("delete_workspace", id, confirmWorkspaceId);
        const mutation = `
          mutation DeleteWorkspace($id: String!) {
            deleteWorkspace(id: $id)
          }
        `;
        
        const data = await gql.request<{ deleteWorkspace: boolean }>(mutation, { id });
        if (!data.deleteWorkspace) {
          return toolError("AFFiNE did not confirm workspace deletion.", {
            code: "workspace_delete_failed",
            data: {
              kind: "workspace.delete",
              status: "failed",
              workspaceId: id,
              id,
              deleted: false,
            },
          });
        }

        return receipt("workspace.delete", {
          status: "deleted",
          workspaceId: id,
          id,
          deleted: true,
          success: true,
        });
      } catch (error: any) {
        return toolError(error, {
          code: "workspace_delete_failed",
          data: {
            kind: "workspace.delete",
            status: "failed",
            workspaceId: id,
            id,
            deleted: false,
          },
        });
      }
    };
  server.registerTool(
    "delete_workspace",
    {
      title: "Delete Workspace",
      description: "Delete a workspace permanently and report success only when AFFiNE confirms the mutation.",
      inputSchema: {
        id: z.string().describe("Workspace ID"),
        confirmWorkspaceId: z.string().describe("Must exactly match id to confirm permanent workspace deletion.")
      }
    },
    deleteWorkspaceHandler as any
  );
}
