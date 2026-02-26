import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";

export function registerUserTools(server: McpServer, gql: GraphQLClient) {
  const currentUserHandler = async () => {
    const query = `query Me { currentUser { id name email emailVerified avatarUrl disabled } }`;
    const data = await gql.request<{ currentUser: any }>(query);
    return text(data.currentUser);
  };

  server.registerTool(
    "current_user",
    {
      title: "Current User",
      description: "Get current signed-in user.",
      inputSchema: {}
    },
    currentUserHandler as any
  );
}
