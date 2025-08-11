import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GraphQLClient } from "../graphqlClient.js";

export function registerWorkspaceTools(server: Server, gql: GraphQLClient) {
  server.addTool(
    {
      name: "affine_list_workspaces",
      description: "List available AFFiNE workspaces via GraphQL.",
      inputSchema: { type: "object", properties: {} }
    },
    async () => {
      const query = `query ListWorkspaces { workspaces { id public enableAi enableUrlPreview enableDocEmbedding } }`;
      const data = await gql.request<{ workspaces: any[] }>(query);
      return { content: [{ type: "application/json", json: data.workspaces }] };
    }
  );

  server.addTool(
    {
      name: "affine_get_workspace",
      description: "Get a workspace by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    },
    async (args) => {
      const id = String((args as any).id);
      const query = `query GetWorkspace($id: String!) { workspace(id: $id) { id public enableAi enableUrlPreview enableDocEmbedding team role: role permissions: permissions { Workspace_Read Workspace_CreateDoc } } }`;
      const data = await gql.request<{ workspace: any }>(query, { id });
      return { content: [{ type: "application/json", json: data.workspace }] };
    }
  );
}
