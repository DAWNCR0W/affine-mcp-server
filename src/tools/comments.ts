import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { receipt, text } from "../util/mcp.js";

const CommentContent = z.union([
  z.string(),
  z.record(z.unknown()),
  z.array(z.unknown()),
]).describe("Comment content accepted by AFFiNE. Plain strings are normalized to { text }, and rich AFFiNE payload objects are passed through.");
const CommentPageSize = z.number().int().positive().describe("Maximum number of comments to return from the AFFiNE pagination connection.");
const CommentOffset = z.number().int().nonnegative().describe("Zero-based offset used by AFFiNE pagination. Do not combine with after unless the AFFiNE API requires it.");

export function registerCommentTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const listCommentsHandler = async (parsed: { workspaceId?: string; docId: string; first?: number; offset?: number; after?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const query = `query ListComments($workspaceId:String!,$docId:String!,$first:Int,$offset:Int,$after:String){ workspace(id:$workspaceId){ comments(docId:$docId, pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id content createdAt updatedAt resolved user{ id name avatarUrl } replies{ id content createdAt updatedAt user{ id name avatarUrl } } } } } } }`;
    const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId, first: parsed.first, offset: parsed.offset, after: parsed.after });
    return text(data.workspace.comments);
  };
  server.registerTool(
    "list_comments",
    {
      title: "List Comments",
      description: "List paginated comments for a document, including nested replies and resolution state. Use this before update_comment, delete_comment, or resolve_comment when you need the existing comment ids.",
      inputSchema: {
        workspaceId: z.string().optional().describe("AFFiNE workspace id. Omit only when AFFINE_WORKSPACE_ID is configured."),
        docId: z.string().describe("Document id whose comments should be listed."),
        first: CommentPageSize.optional(),
        offset: CommentOffset.optional(),
        after: z.string().optional().describe("Cursor from pageInfo.endCursor for fetching the next page.")
      }
    },
    listCommentsHandler as any
  );

  const createCommentHandler = async (parsed: { workspaceId?: string; docId: string; docTitle?: string; docMode?: "Page"|"Edgeless"|"page"|"edgeless"; content: any; mentions?: string[] }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
    const normalizedDocMode = (parsed.docMode || 'page').toLowerCase() === 'edgeless' ? 'edgeless' : 'page';
    const normalizedContent = typeof parsed.content === 'string' ? { text: parsed.content } : parsed.content;
    const input = { content: normalizedContent, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: normalizedDocMode, mentions: parsed.mentions };
    const data = await gql.request<{ createComment: any }>(mutation, { input });
    return receipt("comment.create", {
      workspaceId,
      docId: parsed.docId,
      commentId: data.createComment.id,
      id: data.createComment.id,
      ...data.createComment,
      comment: data.createComment,
    });
  };
  server.registerTool(
    "create_comment",
    {
      title: "Create Comment",
      description: "Create a new comment on an existing document. This writes collaboration state; use update_comment when editing an existing comment instead.",
      inputSchema: {
        workspaceId: z.string().optional().describe("AFFiNE workspace id. Omit only when AFFINE_WORKSPACE_ID is configured."),
        docId: z.string().describe("Document id that will receive the new comment."),
        docTitle: z.string().optional().describe("Optional document title stored with the comment metadata."),
        docMode: z.enum(["Page","Edgeless","page","edgeless"]).optional().describe("Document surface for the comment. Defaults to page."),
        content: CommentContent,
        mentions: z.array(z.string()).optional().describe("Optional AFFiNE user ids to mention in the comment.")
      }
    },
    createCommentHandler as any
  );

  const updateCommentHandler = async (parsed: { id: string; content: any }) => {
    const mutation = `mutation UpdateComment($input: CommentUpdateInput!){ updateComment(input:$input) }`;
    const normalizedContent = typeof parsed.content === 'string' ? { text: parsed.content } : parsed.content;
    const data = await gql.request<{ updateComment: boolean }>(mutation, { input: { id: parsed.id, content: normalizedContent } });
    return receipt("comment.update", {
      commentId: parsed.id,
      id: parsed.id,
      success: data.updateComment,
    });
  };
  server.registerTool(
    "update_comment",
    {
      title: "Update Comment",
      description: "Replace the content of an existing comment. This preserves the comment thread; use create_comment for a new thread.",
      inputSchema: {
        id: z.string().describe("Comment id returned by list_comments or create_comment."),
        content: CommentContent.describe("Replacement comment content accepted by AFFiNE.")
      }
    },
    updateCommentHandler as any
  );

  const deleteCommentHandler = async (parsed: { id: string }) => {
    const mutation = `mutation DeleteComment($id:String!){ deleteComment(id:$id) }`;
    const data = await gql.request<{ deleteComment: boolean }>(mutation, { id: parsed.id });
    return receipt("comment.delete", {
      commentId: parsed.id,
      id: parsed.id,
      success: data.deleteComment,
    });
  };
  server.registerTool(
    "delete_comment",
    {
      title: "Delete Comment",
      description: "Delete an existing comment by id. This is destructive for that comment; use resolve_comment when you only want to mark a thread resolved.",
      inputSchema: {
        id: z.string().describe("Comment id returned by list_comments or create_comment.")
      }
    },
    deleteCommentHandler as any
  );

  const resolveCommentHandler = async (parsed: { id: string; resolved: boolean }) => {
    const mutation = `mutation ResolveComment($input: CommentResolveInput!){ resolveComment(input:$input) }`;
    const data = await gql.request<{ resolveComment: boolean }>(mutation, { input: parsed });
    return receipt("comment.resolve", {
      commentId: parsed.id,
      id: parsed.id,
      resolved: parsed.resolved,
      success: data.resolveComment,
    });
  };
  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve Comment",
      description: "Set a comment thread's resolved state without changing its content. Use delete_comment only when the comment should be removed.",
      inputSchema: {
        id: z.string().describe("Comment id returned by list_comments or create_comment."),
        resolved: z.boolean().describe("true marks the comment resolved; false reopens it.")
      }
    },
    resolveCommentHandler as any
  );
}
