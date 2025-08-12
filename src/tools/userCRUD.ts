import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";

export function registerUserCRUDTools(server: McpServer, gql: GraphQLClient) {
  // UPDATE PROFILE
  server.registerTool(
    "affine_update_profile",
    {
      title: "Update Profile",
      description: "Update current user's profile information.",
      inputSchema: {
        name: z.string().optional().describe("Display name"),
        avatarUrl: z.string().optional().describe("Avatar URL")
      }
    },
    async ({ name, avatarUrl }) => {
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
        return { content: [{ type: "text", text: JSON.stringify(data.updateProfile) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // UPDATE SETTINGS
  server.registerTool(
    "affine_update_settings",
    {
      title: "Update Settings",
      description: "Update user settings and preferences.",
      inputSchema: {
        settings: z.record(z.any()).describe("Settings object with key-value pairs")
      }
    },
    async ({ settings }) => {
      try {
        const mutation = `
          mutation UpdateSettings($input: UpdateUserSettingsInput!) {
            updateSettings(input: $input) {
              success
            }
          }
        `;
        
        const data = await gql.request<{ updateSettings: any }>(mutation, { 
          input: settings 
        });
        
        return { content: [{ type: "text", text: JSON.stringify(data.updateSettings) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // SEND VERIFICATION EMAIL
  server.registerTool(
    "affine_send_verify_email",
    {
      title: "Send Verification Email",
      description: "Send email verification link.",
      inputSchema: {
        callbackUrl: z.string().optional().describe("Callback URL after verification")
      }
    },
    async ({ callbackUrl }) => {
      try {
        const mutation = `
          mutation SendVerifyEmail($callbackUrl: String!) {
            sendVerifyEmail(callbackUrl: $callbackUrl)
          }
        `;
        
        const data = await gql.request<{ sendVerifyEmail: boolean }>(mutation, {
          callbackUrl: callbackUrl || `${process.env.AFFINE_BASE_URL}/verify`
        });
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.sendVerifyEmail,
          message: "Verification email sent"
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // CHANGE PASSWORD
  server.registerTool(
    "affine_change_password",
    {
      title: "Change Password",
      description: "Change user password (requires token from email).",
      inputSchema: {
        token: z.string().describe("Password reset token from email"),
        newPassword: z.string().describe("New password"),
        userId: z.string().optional().describe("User ID")
      }
    },
    async ({ token, newPassword, userId }) => {
      try {
        const mutation = `
          mutation ChangePassword($token: String!, $newPassword: String!, $userId: String) {
            changePassword(token: $token, newPassword: $newPassword, userId: $userId)
          }
        `;
        
        const data = await gql.request<{ changePassword: boolean }>(mutation, {
          token,
          newPassword,
          userId
        });
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.changePassword,
          message: "Password changed successfully"
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // SEND PASSWORD RESET EMAIL
  server.registerTool(
    "affine_send_password_reset",
    {
      title: "Send Password Reset",
      description: "Send password reset email.",
      inputSchema: {
        callbackUrl: z.string().optional().describe("Callback URL for password reset")
      }
    },
    async ({ callbackUrl }) => {
      try {
        const mutation = `
          mutation SendChangePasswordEmail($callbackUrl: String!) {
            sendChangePasswordEmail(callbackUrl: $callbackUrl)
          }
        `;
        
        const data = await gql.request<{ sendChangePasswordEmail: boolean }>(mutation, {
          callbackUrl: callbackUrl || `${process.env.AFFINE_BASE_URL}/reset-password`
        });
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.sendChangePasswordEmail,
          message: "Password reset email sent"
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // DELETE ACCOUNT
  server.registerTool(
    "affine_delete_account",
    {
      title: "Delete Account",
      description: "Permanently delete user account. WARNING: This cannot be undone!",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true to confirm account deletion")
      }
    },
    async ({ confirm }) => {
      if (!confirm) {
        return { content: [{ type: "text", text: JSON.stringify({ 
          error: "Confirmation required. Set confirm: true to delete account."
        }) }] };
      }
      
      try {
        const mutation = `
          mutation DeleteAccount {
            deleteAccount
          }
        `;
        
        const data = await gql.request<{ deleteAccount: boolean }>(mutation);
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.deleteAccount,
          message: "Account deleted successfully"
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );
}