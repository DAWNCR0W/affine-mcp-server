import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { loginWithPassword } from "../auth.js";
import { text } from "../util/mcp.js";

export function registerAuthTools(server: McpServer, gql: GraphQLClient, baseUrl: string) {
  const signInHandler = async (parsed: { email: string; password: string }) => {
    const { cookieHeader } = await loginWithPassword(baseUrl, parsed.email, parsed.password);
    gql.setCookie(cookieHeader);
    return text({ signedIn: true });
  };
  server.registerTool(
    "affine_sign_in",
    {
      title: "Sign In",
      description: "Sign in to AFFiNE using email and password; sets session cookies for subsequent calls.",
      inputSchema: {
        email: z.string().email(),
        password: z.string().min(1)
      }
    },
    signInHandler as any
  );
  server.registerTool(
    "sign_in",
    {
      title: "Sign In",
      description: "Sign in to AFFiNE using email and password; sets session cookies for subsequent calls.",
      inputSchema: {
        email: z.string().email(),
        password: z.string().min(1)
      }
    },
    signInHandler as any
  );
}
