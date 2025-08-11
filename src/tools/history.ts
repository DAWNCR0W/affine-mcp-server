import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GraphQLClient } from "../graphqlClient.js";
import { z } from "zod";

export function registerHistoryTools(server: Server, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  server.addTool(
    {
      name: "affine_list_histories",
      description: "List doc histories (timestamps) for a doc.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, guid: { type: "string" }, take: { type: "number" }, before: { type: "string" } }, required: ["guid"] }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), guid: z.string(), take: z.number().optional(), before: z.string().optional() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      const query = `query Histories($workspaceId:String!,$guid:String!,$take:Int,$before:DateTime){ workspace(id:$workspaceId){ histories(guid:$guid, take:$take, before:$before){ id timestamp workspaceId } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, guid: parsed.guid, take: parsed.take, before: parsed.before });
      return { content: [{ type: "application/json", json: data.workspace.histories }] };
    }
  );

  server.addTool(
    {
      name: "affine_recover_doc",
      description: "Recover a doc to a previous timestamp.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, guid: { type: "string" }, timestamp: { type: "string" } }, required: ["guid", "timestamp"] }
    },
    async (args) => {
      const parsed = z.object({ workspaceId: z.string().optional(), guid: z.string(), timestamp: z.string() }).parse(args);
      const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      const mutation = `mutation Recover($workspaceId:String!,$guid:String!,$timestamp:DateTime!){ recoverDoc(workspaceId:$workspaceId, guid:$guid, timestamp:$timestamp) }`;
      const data = await gql.request<{ recoverDoc: string }>(mutation, { workspaceId, guid: parsed.guid, timestamp: parsed.timestamp });
      return { content: [{ type: "application/json", json: { recoveredAt: data.recoverDoc } }] };
    }
  );
}

