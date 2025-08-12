import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");

export function registerDocTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  server.registerTool(
    "affine_list_docs",
    {
      title: "List Documents",
      description: "List documents in a workspace (GraphQL).",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const query = `query ListDocs($workspaceId: String!, $first: Int, $offset: Int, $after: String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return { content: [{ type: "text", text: JSON.stringify(data.workspace.docs) }] };
    }
  );

  server.registerTool(
    "affine_get_doc",
    {
      title: "Get Document",
      description: "Get a document by ID (GraphQL metadata).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: DocId
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const query = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id workspaceId title summary public defaultRole createdAt updatedAt } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId });
      return { content: [{ type: "text", text: JSON.stringify(data.workspace.doc) }] };
    }
  );

  server.registerTool(
    "affine_search_docs",
    {
      title: "Search Documents",
      description: "Search documents in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        keyword: z.string().min(1),
        limit: z.number().optional()
      }
    },
    async (parsed) => {
      try {
        const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
        const query = `query SearchDocs($workspaceId:String!, $keyword:String!, $limit:Int){ workspace(id:$workspaceId){ searchDocs(input:{ keyword:$keyword, limit:$limit }){ docId title highlight createdAt updatedAt } } }`;
        const data = await gql.request<{ workspace: any }>(query, { workspaceId, keyword: parsed.keyword, limit: parsed.limit });
        return { content: [{ type: "text", text: JSON.stringify(data.workspace?.searchDocs || []) }] };
      } catch (error: any) {
        // Return empty array on error (search might not be available)
        console.error("Search docs error:", error.message);
        return { content: [{ type: "text", text: JSON.stringify([]) }] };
      }
    }
  );

  server.registerTool(
    "affine_recent_docs",
    {
      title: "Recent Documents",
      description: "List recently updated docs in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const query = `query RecentDocs($workspaceId:String!, $first:Int, $offset:Int, $after:String){ workspace(id:$workspaceId){ recentlyUpdatedDocs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      return { content: [{ type: "text", text: JSON.stringify(data.workspace.recentlyUpdatedDocs) }] };
    }
  );

  server.registerTool(
    "affine_publish_doc",
    {
      title: "Publish Document",
      description: "Publish a doc (make public).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        mode: z.enum(["Page","Edgeless"]).optional()
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const mutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
      const data = await gql.request<{ publishDoc: any }>(mutation, { workspaceId, docId: parsed.docId, mode: parsed.mode });
      return { content: [{ type: "text", text: JSON.stringify(data.publishDoc) }] };
    }
  );

  server.registerTool(
    "affine_revoke_doc",
    {
      title: "Revoke Document",
      description: "Revoke a doc's public access.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string()
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || WorkspaceId.parse(parsed.workspaceId);
      const mutation = `mutation RevokeDoc($workspaceId:String!,$docId:String!){ revokePublicDoc(workspaceId:$workspaceId, docId:$docId){ id workspaceId public } }`;
      const data = await gql.request<{ revokePublicDoc: any }>(mutation, { workspaceId, docId: parsed.docId });
      return { content: [{ type: "text", text: JSON.stringify(data.revokePublicDoc) }] };
    }
  );
}
