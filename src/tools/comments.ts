import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";

export function registerCommentTools(server: Server, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  server.addTool(
    {
      name: "affine_list_comments",
      description: "List comments of a doc (with replies).",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          docId: { type: "string" },
          first: { type: "number" },
          offset: { type: "number" },
          after: { type: "string" }
        },
        required: ["docId"]
      }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), docId: z.string(), first: z.number().optional(), offset: z.number().optional(), after: z.string().optional() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      const query = `query ListComments($workspaceId:String!,$docId:String!,$first:Int,$offset:Int,$after:String){ workspace(id:$workspaceId){ comments(docId:$docId, pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id content createdAt updatedAt resolved user{ id name avatarUrl } replies{ id content createdAt updatedAt user{ id name avatarUrl } } } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return { content: [{ type: "application/json", json: data.workspace.comments }] };
    }
  );

  server.addTool(
    {
      name: "affine_create_comment",
      description: "Create a comment on a doc.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          docId: { type: "string" },
          docTitle: { type: "string" },
          docMode: { type: "string", description: "Doc mode: Page or Edgeless", default: "Page" },
          content: { type: "object" },
          mentions: { type: "array", items: { type: "string" } }
        },
        required: ["docId", "content"]
      }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), docId: z.string(), docTitle: z.string().optional(), docMode: z.enum(["Page","Edgeless"]).optional(), content: z.any(), mentions: z.array(z.string()).optional() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
      const input = { content: parsed.content, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: parsed.docMode || "Page", mentions: parsed.mentions };
      const data = await gql.request<{ createComment: any }>(mutation, { input });
      return { content: [{ type: "application/json", json: data.createComment }] };
    }
  );

  server.addTool(
    {
      name: "affine_update_comment",
      description: "Update a comment content.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, content: { type: "object" } }, required: ["id", "content"] }
    },
    async (args) => {
      const parsed = z.object({ id: z.string(), content: z.any() }).parse(args);
      const mutation = `mutation UpdateComment($input: CommentUpdateInput!){ updateComment(input:$input) }`;
      const data = await gql.request<{ updateComment: boolean }>(mutation, { input: { id: parsed.id, content: parsed.content } });
      return { content: [{ type: "application/json", json: { success: data.updateComment } }] };
    }
  );

  server.addTool(
    {
      name: "affine_delete_comment",
      description: "Delete a comment by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    },
    async (args) => {
      const parsed = z.object({ id: z.string() }).parse(args);
      const mutation = `mutation DeleteComment($id:String!){ deleteComment(id:$id) }`;
      const data = await gql.request<{ deleteComment: boolean }>(mutation, { id: parsed.id });
      return { content: [{ type: "application/json", json: { success: data.deleteComment } }] };
    }
  );

  server.addTool(
    {
      name: "affine_resolve_comment",
      description: "Resolve or unresolve a comment.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, resolved: { type: "boolean" } }, required: ["id", "resolved"] }
    },
    async (args) => {
      const parsed = z.object({ id: z.string(), resolved: z.boolean() }).parse(args);
      const mutation = `mutation ResolveComment($input: CommentResolveInput!){ resolveComment(input:$input) }`;
      const data = await gql.request<{ resolveComment: boolean }>(mutation, { input: parsed });
      return { content: [{ type: "application/json", json: { success: data.resolveComment } }] };
    }
  );
}

