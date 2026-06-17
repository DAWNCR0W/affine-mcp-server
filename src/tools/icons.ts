import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphQLClient } from "../graphqlClient.js";
import { receipt } from "../util/mcp.js";
import {
  connectWorkspaceSocket,
  joinWorkspace,
  wsUrlFromGraphQLEndpoint,
  type WorkspaceSocket,
} from "../ws.js";
import {
  docIconKey,
  folderIconKey,
  getExplorerIcon,
  normalizeIconInput,
  setExplorerIcon,
  type ExplorerIconInput,
} from "../util/explorerIcon.js";

/**
 * Zod shape for the `icon` parameter shared by both setters. Accepts an emoji
 * shorthand string, a full `{type:"emoji",unicode}` / `{type:"icon",name}`
 * object, or `null` to clear the icon.
 */
const iconSchema = z
  .union([
    z.string(),
    z.object({ type: z.literal("emoji"), unicode: z.string() }),
    z.object({ type: z.literal("icon"), name: z.string() }),
    z.null(),
  ])
  .describe(
    'Emoji shorthand ("🧪"), a full object ({type:"emoji",unicode:"🧪"} or ' +
      '{type:"icon",name:"check"}), or null to remove the icon.',
  );

/**
 * Registers the explorer-icon tools: set/clear and read the Notion-style
 * sidebar icon on a document or an organize folder. All four share the
 * `explorerIcon` sub-doc helper so the storage model lives in one place.
 */
export function registerIconTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string },
) {
  function resolveWorkspaceId(workspaceId?: string): string {
    const resolved = workspaceId || defaults.workspaceId;
    if (!resolved) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID.",
      );
    }
    return resolved;
  }

  async function withSocket<T>(
    workspaceId: string,
    fn: (socket: WorkspaceSocket) => Promise<T>,
  ): Promise<T> {
    const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, gql.cookie, gql.bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      return await fn(socket);
    } finally {
      socket.disconnect();
    }
  }

  // ─── update_doc_icon ────────────────────────────────────────────────────────
  const updateDocIconHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    icon: ExplorerIconInput;
  }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const icon = normalizeIconInput(parsed.icon);
    const result = await withSocket(workspaceId, (socket) =>
      setExplorerIcon(socket, workspaceId, docIconKey(parsed.docId), icon),
    );
    return receipt("doc.update_icon", {
      workspaceId,
      docId: parsed.docId,
      icon: result.icon,
      cleared: result.icon === null,
    });
  };
  server.registerTool(
    "update_doc_icon",
    {
      title: "Update Document Icon",
      description:
        "Set or clear the sidebar icon (the Notion-style emoji slot) on a document. " +
        "Pass an emoji string, a full icon object, or null to remove it.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().describe("The document whose icon to update."),
        icon: iconSchema,
      },
    },
    updateDocIconHandler as any,
  );

  // ─── update_folder_icon ─────────────────────────────────────────────────────
  const updateFolderIconHandler = async (parsed: {
    workspaceId?: string;
    folderId: string;
    icon: ExplorerIconInput;
  }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const icon = normalizeIconInput(parsed.icon);
    const result = await withSocket(workspaceId, (socket) =>
      setExplorerIcon(socket, workspaceId, folderIconKey(parsed.folderId), icon),
    );
    return receipt("folder.update_icon", {
      workspaceId,
      folderId: parsed.folderId,
      icon: result.icon,
      cleared: result.icon === null,
    });
  };
  server.registerTool(
    "update_folder_icon",
    {
      title: "Update Folder Icon",
      description:
        "Set or clear the sidebar icon on an organize folder. " +
        "Pass an emoji string, a full icon object, or null to remove it. Experimental.",
      inputSchema: {
        workspaceId: z.string().optional(),
        folderId: z.string().describe("The organize folder whose icon to update."),
        icon: iconSchema,
      },
    },
    updateFolderIconHandler as any,
  );

  // ─── get_doc_icon ───────────────────────────────────────────────────────────
  const getDocIconHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const result = await withSocket(workspaceId, (socket) =>
      getExplorerIcon(socket, workspaceId, docIconKey(parsed.docId)),
    );
    return receipt("doc.get_icon", {
      workspaceId,
      docId: parsed.docId,
      icon: result.icon,
      hasIcon: result.icon !== null,
    });
  };
  server.registerTool(
    "get_doc_icon",
    {
      title: "Get Document Icon",
      description: "Read the current sidebar icon of a document. Returns null when none is set.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().describe("The document whose icon to read."),
      },
    },
    getDocIconHandler as any,
  );

  // ─── get_folder_icon ────────────────────────────────────────────────────────
  const getFolderIconHandler = async (parsed: { workspaceId?: string; folderId: string }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const result = await withSocket(workspaceId, (socket) =>
      getExplorerIcon(socket, workspaceId, folderIconKey(parsed.folderId)),
    );
    return receipt("folder.get_icon", {
      workspaceId,
      folderId: parsed.folderId,
      icon: result.icon,
      hasIcon: result.icon !== null,
    });
  };
  server.registerTool(
    "get_folder_icon",
    {
      title: "Get Folder Icon",
      description:
        "Read the current sidebar icon of an organize folder. Returns null when none is set. Experimental.",
      inputSchema: {
        workspaceId: z.string().optional(),
        folderId: z.string().describe("The organize folder whose icon to read."),
      },
    },
    getFolderIconHandler as any,
  );
}
