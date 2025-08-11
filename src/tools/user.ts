import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GraphQLClient } from "../graphqlClient.js";

export function registerUserTools(server: Server, gql: GraphQLClient) {
  server.addTool(
    { name: "affine_current_user", description: "Get current signed-in user.", inputSchema: { type: "object", properties: {} } },
    async () => {
      const query = `query Me { currentUser { id name email emailVerified avatarUrl disabled } }`;
      const data = await gql.request<{ currentUser: any }>(query);
      return { content: [{ type: "application/json", json: data.currentUser }] };
    }
  );
}
