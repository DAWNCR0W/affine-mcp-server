import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";

export function registerWorkspaceTools(server: McpServer, gql: GraphQLClient) {
  server.registerTool(
    "affine_list_workspaces",
    {
      title: "List Workspaces",
      description: "List available AFFiNE workspaces via GraphQL."
    },
    async () => {
      const query = `query ListWorkspaces { workspaces { id public enableAi enableUrlPreview enableDocEmbedding } }`;
      const data = await gql.request<{ workspaces: any[] }>(query);
      return { content: [{ type: "text", text: JSON.stringify(data.workspaces) }] };
    }
  );

  server.registerTool(
    "affine_get_workspace",
    {
      title: "Get Workspace",
      description: "Get a workspace by id.",
      inputSchema: { id: z.string() }
    },
    async ({ id }) => {
      const query = `query GetWorkspace($id: String!) { workspace(id: $id) { id public enableAi enableUrlPreview enableDocEmbedding team role: role permissions: permissions { Workspace_Read Workspace_CreateDoc } } }`;
      const data = await gql.request<{ workspace: any }>(query, { id });
      return { content: [{ type: "text", text: JSON.stringify(data.workspace) }] };
    }
  );
}
