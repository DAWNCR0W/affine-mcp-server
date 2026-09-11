import { z, type ZodRawShape } from "zod";
import * as Y from "yjs";
import type { GraphQLClient } from "./graphqlClient.js";
import { toolAnnotationsFor, type ToolName } from "./toolSurface.js";
import { documentRevision, isDocumentRegistered } from "./util/documentRevision.js";
import { toolError } from "./util/mcp.js";
import { writeCoordinator, WriteCoordinatorError } from "./util/writeCoordinator.js";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, wsUrlFromGraphQLEndpoint } from "./ws.js";

type Handler = (args: Record<string, any>, extra: any) => Promise<any>;

// Workspace metadata, properties, and GraphQL mutations need their own revision
// contract; a page-content token must not imply protection for those resources.
const DOCUMENT_CONTENT_MUTATIONS = new Set<ToolName>([
  "add_database_column", "add_database_row", "add_mindmap_node", "add_surface_element",
  "append_block", "append_markdown", "append_semantic_section", "compose_database_from_intent",
  "create_mindmap", "delete_block", "delete_database_row", "delete_doc", "delete_surface_element",
  "move_block", "reparent_mindmap_node", "replace_doc_with_markdown", "set_mindmap_layout",
  "set_mindmap_lock", "set_mindmap_style", "update_block", "update_database_row", "update_doc_title",
  "update_edgeless_block", "update_frame_children", "update_mindmap_node", "update_surface_element",
  "update_table_cell",
]);

async function currentDocumentRevision(gql: GraphQLClient, workspaceId: string, docId: string) {
  const { endpoint, cookie, bearer } = await gql.getConnectionAuth();
  const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
  const doc = new Y.Doc();
  const workspaceDoc = new Y.Doc();
  try {
    await joinWorkspace(socket, workspaceId);
    const workspaceSnapshot = await loadDoc(socket, workspaceId, workspaceId);
    if (workspaceSnapshot.missing) Y.applyUpdate(workspaceDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
    const snapshot = await loadDoc(socket, workspaceId, docId);
    if (!snapshot.missing) return null;
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
    return documentRevision(doc, isDocumentRegistered(workspaceDoc, docId));
  } finally {
    doc.destroy();
    workspaceDoc.destroy();
    socket.disconnect();
  }
}

/** Coordinate whole tool calls across every session served by this process. */
export function coordinateTool(
  name: string,
  inputSchema: ZodRawShape,
  handler: Handler,
  context: { gql: GraphQLClient; endpoint: string; workspaceId?: string },
) {
  const write = !toolAnnotationsFor(name).readOnlyHint;
  if (!write && name !== "read_doc") return { inputSchema, handler };
  const supportsRevision = DOCUMENT_CONTENT_MUTATIONS.has(name as ToolName) && Object.hasOwn(inputSchema, "docId");
  const schema = supportsRevision ? {
    ...inputSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional().describe(
      "Optional read_doc revision of this primary document. Reject stale content before writing. " +
      "Covers document content, not workspace metadata; requires all writers to share one MCP server.",
    ),
  } : inputSchema;

  return {
    inputSchema: schema,
    handler: async (args: Record<string, any>, extra: any) => {
      // Workspace administrative tools use id, not workspaceId.
      const workspaceId = name === "update_workspace" || name === "delete_workspace"
        ? args.id
        : args.workspaceId || context.workspaceId;
      // ponytail: workspace-wide serialization also covers metadata and composite
      // operations. Ordered multi-document locks can improve throughput later.
      const scope = JSON.stringify([new URL(context.endpoint).origin, workspaceId ?? null]);
      try {
        return await writeCoordinator.run(scope, async () => {
          if (supportsRevision && args.expectedRevision !== undefined) {
            if (!workspaceId) return toolError("workspaceId is required", { code: "invalid_arguments" });
            const currentRevision = await currentDocumentRevision(context.gql, workspaceId, args.docId);
            if (currentRevision !== args.expectedRevision) {
              return toolError("Document content changed. Read it again and reconcile your edit before retrying.", {
                code: "STALE_DOCUMENT_REVISION",
                retryable: false,
                details: { workspaceId, docId: args.docId, expectedRevision: args.expectedRevision, currentRevision },
              });
            }
          }
          return handler(args, extra);
        }, extra?.signal);
      } catch (error) {
        if (error instanceof WriteCoordinatorError) {
          return toolError(error, { code: error.code, retryable: error.retryable });
        }
        throw error;
      }
    },
  };
}
