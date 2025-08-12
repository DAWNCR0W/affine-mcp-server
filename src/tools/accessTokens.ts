import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { z } from "zod";

export function registerAccessTokenTools(server: McpServer, gql: GraphQLClient) {
  server.registerTool(
    "affine_list_access_tokens",
    {
      title: "List Access Tokens",
      description: "List personal access tokens (metadata).",
      inputSchema: {}
    },
    async () => {
      try {
        const query = `query { accessTokens { id name createdAt expiresAt } }`;
        const data = await gql.request<{ accessTokens: any[] }>(query);
        return { content: [{ type: "text", text: JSON.stringify(data.accessTokens || []) }] };
      } catch (error: any) {
        // Access tokens might not be available for all users
        console.error("List access tokens error:", error.message);
        return { content: [{ type: "text", text: JSON.stringify([]) }] };
      }
    }
  );

  server.registerTool(
    "affine_generate_access_token",
    {
      title: "Generate Access Token",
      description: "Generate a personal access token (returns token).",
      inputSchema: {
        name: z.string(),
        expiresAt: z.string().optional()
      }
    },
    async (parsed) => {
      const mutation = `mutation($input: GenerateAccessTokenInput!){ generateUserAccessToken(input:$input){ id name createdAt expiresAt token } }`;
      const data = await gql.request<{ generateUserAccessToken: any }>(mutation, { input: { name: parsed.name, expiresAt: parsed.expiresAt ?? null } });
      return { content: [{ type: "text", text: JSON.stringify(data.generateUserAccessToken) }] };
    }
  );

  server.registerTool(
    "affine_revoke_access_token",
    {
      title: "Revoke Access Token",
      description: "Revoke a personal access token by id.",
      inputSchema: {
        id: z.string()
      }
    },
    async (parsed) => {
      const mutation = `mutation($id:String!){ revokeUserAccessToken(id:$id) }`;
      const data = await gql.request<{ revokeUserAccessToken: boolean }>(mutation, { id: parsed.id });
      return { content: [{ type: "text", text: JSON.stringify({ success: data.revokeUserAccessToken }) }] };
    }
  );
}

