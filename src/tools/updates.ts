import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { z } from "zod";

export function registerUpdateTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  server.registerTool(
    "affine_apply_doc_updates",
    {
      title: "Apply Document Updates",
      description: "Apply CRDT updates to a doc (advanced).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        op: z.string(),
        updates: z.string()
      }
    },
    async (parsed) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      const query = `query Apply($workspaceId:String!,$docId:String!,$op:String!,$updates:String!){ applyDocUpdates(workspaceId:$workspaceId, docId:$docId, op:$op, updates:$updates) }`;
      const data = await gql.request<{ applyDocUpdates: string }>(query, { workspaceId, docId: parsed.docId, op: parsed.op, updates: parsed.updates });
      return { content: [{ type: "text", text: data.applyDocUpdates }] };
    }
  );
}

