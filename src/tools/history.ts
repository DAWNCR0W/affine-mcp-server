import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { z } from "zod";

export function registerHistoryTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const listHistoriesHandler = async (parsed: { workspaceId?: string; guid: string; take?: number; before?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const query = `query Histories($workspaceId:String!,$guid:String!,$take:Int,$before:DateTime){ workspace(id:$workspaceId){ histories(guid:$guid, take:$take, before:$before){ id timestamp workspaceId } } }`;
    const data = await gql.request<{ workspace: any }>(query, { workspaceId, guid: parsed.guid, take: parsed.take, before: parsed.before });
    return text(data.workspace.histories);
  };
  server.registerTool(
    "list_histories",
    {
      title: "List Histories",
      description: "List doc histories (timestamps) for a doc.",
      inputSchema: {
        workspaceId: z.string().optional(),
        guid: z.string(),
        take: z.number().optional(),
        before: z.string().optional()
      }
    },
    listHistoriesHandler as any
  );
}
