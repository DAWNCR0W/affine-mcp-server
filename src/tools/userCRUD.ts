import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";

export function registerUserCRUDTools(server: McpServer, gql: GraphQLClient) {
  // UPDATE PROFILE
  const updateProfileHandler = async ({ name, avatarUrl }: { name?: string; avatarUrl?: string }) => {
    try {
      const mutation = `
        mutation UpdateProfile($input: UpdateUserInput!) {
          updateProfile(input: $input) {
            id
            name
            avatarUrl
            email
          }
        }
      `;
      
      const input: any = {};
      if (name !== undefined) input.name = name;
      if (avatarUrl !== undefined) input.avatarUrl = avatarUrl;
      
      const data = await gql.request<{ updateProfile: any }>(mutation, { input });
      return text(data.updateProfile);
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "update_profile",
    {
      title: "Update Profile",
      description: "Update current user's profile information.",
      inputSchema: {
        name: z.string().optional().describe("Display name"),
        avatarUrl: z.string().optional().describe("Avatar URL")
      }
    },
    updateProfileHandler as any
  );

  // UPDATE SETTINGS
  const updateSettingsHandler = async ({ settings }: { settings: { receiveCommentEmail?: boolean; receiveInvitationEmail?: boolean; receiveMentionEmail?: boolean } }) => {
    try {
      const mutation = `
        mutation UpdateSettings($input: UpdateUserSettingsInput!) {
          updateSettings(input: $input)
        }
      `;

      const input: { receiveCommentEmail?: boolean; receiveInvitationEmail?: boolean; receiveMentionEmail?: boolean } = {};
      if (typeof settings.receiveCommentEmail === 'boolean') input.receiveCommentEmail = settings.receiveCommentEmail;
      if (typeof settings.receiveInvitationEmail === 'boolean') input.receiveInvitationEmail = settings.receiveInvitationEmail;
      if (typeof settings.receiveMentionEmail === 'boolean') input.receiveMentionEmail = settings.receiveMentionEmail;
      if (Object.keys(input).length === 0) {
        return text({
          error: "settings must include at least one of: receiveCommentEmail, receiveInvitationEmail, receiveMentionEmail",
        });
      }

      const data = await gql.request<{ updateSettings: boolean }>(mutation, { 
        input
      });
      
      return text({ success: data.updateSettings });
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "update_settings",
    {
      title: "Update Settings",
      description: "Update user settings and preferences.",
      inputSchema: {
        settings: z.object({
          receiveCommentEmail: z.boolean().optional(),
          receiveInvitationEmail: z.boolean().optional(),
          receiveMentionEmail: z.boolean().optional(),
        }).describe("User notification settings")
      }
    },
    updateSettingsHandler as any
  );
}
