import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { z } from "zod";
import { receipt, text, toolError } from "../util/mcp.js";

export function registerAccessTokenTools(server: McpServer, gql: GraphQLClient) {
  const listAccessTokensHandler = async () => {
    try {
      const query = `query { currentUser { accessTokens { id name createdAt expiresAt } } }`;
      const data = await gql.request<{ currentUser: { accessTokens: any[] } }>(query);
      return text(data.currentUser?.accessTokens || []);
    } catch (error: any) {
      console.error("List access tokens error:", error.message);
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "list_access_tokens",
    {
      title: "List Access Tokens",
      description: "List metadata for the current user's personal access tokens. Token secrets are not returned; use generate_access_token only when a new secret is needed.",
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
    "generate_access_token",
    {
      title: "Generate Access Token",
      description: "Generate a new personal access token and return its one-time secret. This creates a credential; store the returned token securely because it may not be shown again.",
      inputSchema: {
        name: z.string().describe("Human-readable token name shown in AFFiNE token settings."),
        expiresAt: z.string().optional().describe("Optional expiration timestamp accepted by AFFiNE, typically an ISO 8601 string.")
      }
    },
    generateAccessTokenHandler as any
  );

  const revokeAccessTokenHandler = async (parsed: { id: string }) => {
    try {
      const mutation = `mutation($id:String!){ revokeUserAccessToken(id:$id) }`;
      const data = await gql.request<{ revokeUserAccessToken: boolean }>(mutation, { id: parsed.id });
      if (!data.revokeUserAccessToken) {
        return toolError("AFFiNE did not confirm access token revocation.", {
          code: "access_token_revoke_failed",
          data: { kind: "access_token.revoke", status: "not_applied", tokenId: parsed.id, id: parsed.id },
        });
      }
      return receipt("access_token.revoke", {
        status: "revoked",
        tokenId: parsed.id,
        id: parsed.id,
        revoked: true,
        success: true,
      });
    } catch (error) {
      return toolError(error, {
        code: "access_token_revoke_failed",
        data: { kind: "access_token.revoke", status: "failed", tokenId: parsed.id, id: parsed.id },
      });
    }
  };
  server.registerTool(
    "revoke_access_token",
    {
      title: "Revoke Access Token",
      description: "Revoke an existing personal access token by id. This is destructive for API clients using that token; list tokens first if the id is unknown.",
      inputSchema: {
        id: z.string().describe("Access token id returned by list_access_tokens or generate_access_token.")
      }
    },
    revokeAccessTokenHandler as any
  );
}
