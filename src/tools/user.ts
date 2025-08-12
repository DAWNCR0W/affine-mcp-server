import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { z } from "zod";

export function registerUserTools(server: McpServer, gql: GraphQLClient) {
  server.registerTool(
    "affine_current_user",
    {
      title: "Current User",
      description: "Get current signed-in user.",
      inputSchema: {}
    },
    async () => {
      const query = `query Me { currentUser { id name email emailVerified avatarUrl disabled } }`;
      const data = await gql.request<{ currentUser: any }>(query);
      return { content: [{ type: "text", text: JSON.stringify(data.currentUser) }] };
    }
  );
}
