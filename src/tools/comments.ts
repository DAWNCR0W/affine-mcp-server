import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";

export function registerCommentTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  server.registerTool(
    "affine_list_comments",
    {
      title: "List Comments",
      description: "List comments of a doc (with replies).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      const query = `query ListComments($workspaceId:String!,$docId:String!,$first:Int,$offset:Int,$after:String){ workspace(id:$workspaceId){ comments(docId:$docId, pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id content createdAt updatedAt resolved user{ id name avatarUrl } replies{ id content createdAt updatedAt user{ id name avatarUrl } } } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return { content: [{ type: "text", text: JSON.stringify(data.workspace.comments) }] };
    }
  );

  server.registerTool(
    "affine_create_comment",
    {
      title: "Create Comment",
      description: "Create a comment on a doc.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        docTitle: z.string().optional(),
        docMode: z.enum(["Page","Edgeless"]).optional(),
        content: z.any(),
        mentions: z.array(z.string()).optional()
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
      const input = { content: parsed.content, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: parsed.docMode || "Page", mentions: parsed.mentions };
      const data = await gql.request<{ createComment: any }>(mutation, { input });
      return { content: [{ type: "text", text: JSON.stringify(data.createComment) }] };
    }
  );

  server.registerTool(
    "affine_update_comment",
    {
      title: "Update Comment",
      description: "Update a comment content.",
      inputSchema: {
        id: z.string(),
        content: z.any()
      }
    },
    async (parsed) => {
      const mutation = `mutation UpdateComment($input: CommentUpdateInput!){ updateComment(input:$input) }`;
      const data = await gql.request<{ updateComment: boolean }>(mutation, { input: { id: parsed.id, content: parsed.content } });
      return { content: [{ type: "text", text: JSON.stringify({ success: data.updateComment }) }] };
    }
  );

  server.registerTool(
    "affine_delete_comment",
    {
      title: "Delete Comment",
      description: "Delete a comment by id.",
      inputSchema: {
        id: z.string()
      }
    },
    async (parsed) => {
      const mutation = `mutation DeleteComment($id:String!){ deleteComment(id:$id) }`;
      const data = await gql.request<{ deleteComment: boolean }>(mutation, { id: parsed.id });
      return { content: [{ type: "text", text: JSON.stringify({ success: data.deleteComment }) }] };
    }
  );

  server.registerTool(
    "affine_resolve_comment",
    {
      title: "Resolve Comment",
      description: "Resolve or unresolve a comment.",
      inputSchema: {
        id: z.string(),
        resolved: z.boolean()
      }
    },
    async (parsed) => {
      const mutation = `mutation ResolveComment($input: CommentResolveInput!){ resolveComment(input:$input) }`;
      const data = await gql.request<{ resolveComment: boolean }>(mutation, { input: parsed });
      return { content: [{ type: "text", text: JSON.stringify({ success: data.resolveComment }) }] };
    }
  );
}

