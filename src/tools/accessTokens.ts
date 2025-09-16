import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { z } from "zod";
import { text } from "../util/mcp.js";

export function registerAccessTokenTools(server: McpServer, gql: GraphQLClient) {
  const listAccessTokensHandler = async () => {
    try {
      const query = `query { accessTokens { id name createdAt expiresAt } }`;
      const data = await gql.request<{ accessTokens: any[] }>(query);
      return text(data.accessTokens || []);
    } catch (error: any) {
      console.error("List access tokens error:", error.message);
      return text([]);
    }
  };
  server.registerTool(
    "affine_list_access_tokens",
    {
      title: "List Access Tokens",
      description: "List personal access tokens (metadata).",
      inputSchema: {}
    },
    listAccessTokensHandler as any
  );
  server.registerTool(
    "list_access_tokens",
    {
      title: "List Access Tokens",
      description: "List personal access tokens (metadata).",
      inputSchema: {}
    },
    listAccessTokensHandler as any
  );

  const generateAccessTokenHandler = async (parsed: { name: string; expiresAt?: string }) => {
    const mutation = `mutation($input: GenerateAccessTokenInput!){ generateUserAccessToken(input:$input){ id name createdAt expiresAt token } }`;
    const data = await gql.request<{ generateUserAccessToken: any }>(mutation, { input: { name: parsed.name, expiresAt: parsed.expiresAt ?? null } });
    return text(data.generateUserAccessToken);
  };
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
    generateAccessTokenHandler as any
  );
  server.registerTool(
    "generate_access_token",
    {
      title: "Generate Access Token",
      description: "Generate a personal access token (returns token).",
      inputSchema: {
        name: z.string(),
        expiresAt: z.string().optional()
      }
    },
    generateAccessTokenHandler as any
  );

  const revokeAccessTokenHandler = async (parsed: { id: string }) => {
    const mutation = `mutation($id:String!){ revokeUserAccessToken(id:$id) }`;
    const data = await gql.request<{ revokeUserAccessToken: boolean }>(mutation, { id: parsed.id });
    return text({ success: data.revokeUserAccessToken });
  };
  server.registerTool(
    "affine_revoke_access_token",
    {
      title: "Revoke Access Token",
      description: "Revoke a personal access token by id.",
      inputSchema: {
        id: z.string()
      }
    },
    revokeAccessTokenHandler as any
  );
  server.registerTool(
    "revoke_access_token",
    {
      title: "Revoke Access Token",
      description: "Revoke a personal access token by id.",
      inputSchema: {
        id: z.string()
      }
    },
    revokeAccessTokenHandler as any
  );
}
