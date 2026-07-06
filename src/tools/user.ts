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
      description: "Return the currently authenticated AFFiNE user profile. Use this read-only check to verify credentials before workspace or document operations.",
      inputSchema: {}
    },
    currentUserHandler as any
  );
}
