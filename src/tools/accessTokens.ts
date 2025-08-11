import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GraphQLClient } from "../graphqlClient.js";
import { z } from "zod";

export function registerAccessTokenTools(server: Server, gql: GraphQLClient) {
  server.addTool(
    { name: "affine_list_access_tokens", description: "List personal access tokens (metadata).", inputSchema: { type: "object", properties: {} } },
    async () => {
      const query = `query { accessTokens { id name createdAt expiresAt } }`;
      const data = await gql.request<{ accessTokens: any[] }>(query);
      return { content: [{ type: "application/json", json: data.accessTokens }] };
    }
  );

  server.addTool(
    { name: "affine_generate_access_token", description: "Generate a personal access token (returns token).", inputSchema: { type: "object", properties: { name: { type: "string" }, expiresAt: { type: "string" } }, required: ["name"] } },
    async (args) => {
      const parsed = z.object({ name: z.string(), expiresAt: z.string().optional() }).parse(args);
      const mutation = `mutation($input: GenerateAccessTokenInput!){ generateUserAccessToken(input:$input){ id name createdAt expiresAt token } }`;
      const data = await gql.request<{ generateUserAccessToken: any }>(mutation, { input: { name: parsed.name, expiresAt: parsed.expiresAt ?? null } });
      return { content: [{ type: "application/json", json: data.generateUserAccessToken }] };
    }
  );

  server.addTool(
    { name: "affine_revoke_access_token", description: "Revoke a personal access token by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    async (args) => {
      const parsed = z.object({ id: z.string() }).parse(args);
      const mutation = `mutation($id:String!){ revokeUserAccessToken(id:$id) }`;
      const data = await gql.request<{ revokeUserAccessToken: boolean }>(mutation, { id: parsed.id });
      return { content: [{ type: "application/json", json: { success: data.revokeUserAccessToken } }] };
    }
  );
}

