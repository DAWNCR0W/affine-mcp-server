import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { loginWithPassword } from "../auth.js";

export function registerAuthTools(server: Server, gql: GraphQLClient, baseUrl: string) {
  server.addTool(
    {
      name: "affine_sign_in",
      description: "Sign in to AFFiNE using email and password; sets session cookies for subsequent calls.",
      inputSchema: { type: "object", properties: { email: { type: "string" }, password: { type: "string" } }, required: ["email", "password"] }
    },
    async (args) => {
      const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(args);
      const { cookieHeader } = await loginWithPassword(baseUrl, parsed.email, parsed.password);
      gql.setCookie(cookieHeader);
      return { content: [{ type: "application/json", json: { signedIn: true } }] };
    }
  );
}

