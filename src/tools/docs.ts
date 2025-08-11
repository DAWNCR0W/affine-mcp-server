import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GraphQLClient } from "../graphqlClient.js";

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");

export function registerDocTools(server: Server, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  server.addTool(
    {
      name: "affine_list_docs",
      description: "List documents in a workspace (GraphQL).",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace ID (optional if default set)." },
          first: { type: "number" },
          offset: { type: "number" },
          after: { type: "string" }
        }
      }
    },
    async (args) => {
      const parsed = z
        .object({ workspaceId: z.string().optional(), first: z.number().optional(), offset: z.number().optional(), after: z.string().optional() })
        .parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const query = `query ListDocs($workspaceId: String!, $first: Int, $offset: Int, $after: String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return { content: [{ type: "application/json", json: data.workspace.docs }] };
    }
  );

  server.addTool(
    {
      name: "affine_get_doc",
      description: "Get a document by ID (GraphQL metadata).",
      inputSchema: {
        type: "object",
        properties: { workspaceId: { type: "string" }, docId: { type: "string" } },
        required: ["docId"]
      }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), docId: DocId }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const query = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id workspaceId title summary public defaultRole createdAt updatedAt } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId });
      return { content: [{ type: "application/json", json: data.workspace.doc }] };
    }
  );

  server.addTool(
    {
      name: "affine_search_docs",
      description: "Search documents in a workspace.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          keyword: { type: "string" },
          limit: { type: "number" }
        },
        required: ["keyword"]
      }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), keyword: z.string().min(1), limit: z.number().optional() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const query = `query SearchDocs($workspaceId:String!, $keyword:String!, $limit:Int){ workspace(id:$workspaceId){ searchDocs(input:{ keyword:$keyword, limit:$limit }){ docId title highlight createdAt updatedAt } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, keyword: parsed.keyword, limit: parsed.limit });
      return { content: [{ type: "application/json", json: data.workspace.searchDocs }] };
    }
  );

  server.addTool(
    {
      name: "affine_recent_docs",
      description: "List recently updated docs in a workspace.",
      inputSchema: {
        type: "object",
        properties: { workspaceId: { type: "string" }, first: { type: "number" }, offset: { type: "number" }, after: { type: "string" } }
      }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), first: z.number().optional(), offset: z.number().optional(), after: z.string().optional() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const query = `query RecentDocs($workspaceId:String!, $first:Int, $offset:Int, $after:String){ workspace(id:$workspaceId){ recentlyUpdatedDocs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return { content: [{ type: "application/json", json: data.workspace.recentlyUpdatedDocs }] };
    }
  );

  server.addTool(
    {
      name: "affine_publish_doc",
      description: "Publish a doc (make public).",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, docId: { type: "string" }, mode: { type: "string" } }, required: ["docId"] }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), docId: z.string(), mode: z.enum(["Page","Edgeless"]).optional() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const mutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
      const data = await gql.request<{ publishDoc: any }>(mutation, { workspaceId, docId: parsed.docId, mode: parsed.mode });
      return { content: [{ type: "application/json", json: data.publishDoc }] };
    }
  );

  server.addTool(
    {
      name: "affine_revoke_doc",
      description: "Revoke a doc's public access.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, docId: { type: "string" } }, required: ["docId"] }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), docId: z.string() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const mutation = `mutation RevokeDoc($workspaceId:String!,$docId:String!){ revokePublicDoc(workspaceId:$workspaceId, docId:$docId){ id workspaceId public } }`;
      const data = await gql.request<{ revokePublicDoc: any }>(mutation, { workspaceId, docId: parsed.docId });
      return { content: [{ type: "application/json", json: data.revokePublicDoc }] };
    }
  );
}
