import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";

export function registerNotificationTools(server: McpServer, gql: GraphQLClient) {
  // LIST NOTIFICATIONS
  server.registerTool(
    "affine_list_notifications",
    {
      title: "List Notifications",
      description: "Get user notifications.",
      inputSchema: {
        first: z.number().optional().describe("Number of notifications to fetch"),
        unreadOnly: z.boolean().optional().describe("Show only unread notifications")
      }
    },
    async ({ first = 20, unreadOnly = false }) => {
      try {
        const query = `
          query GetNotifications($first: Int!) {
            currentUser {
              notifications(first: $first) {
                nodes {
                  id
                  type
                  title
                  body
                  read
                  createdAt
                }
                totalCount
                pageInfo {
                  hasNextPage
                }
              }
            }
          }
        `;
        
        const data = await gql.request<{ currentUser: { notifications: any } }>(query, { first });
        
        let notifications = data.currentUser?.notifications?.nodes || [];
        if (unreadOnly) {
          notifications = notifications.filter((n: any) => !n.read);
        }
        
        return { content: [{ type: "text", text: JSON.stringify(notifications) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // MARK NOTIFICATION AS READ
  server.registerTool(
    "affine_read_notification",
    {
      title: "Mark Notification Read",
      description: "Mark a notification as read.",
      inputSchema: {
        id: z.string().describe("Notification ID")
      }
    },
    async ({ id }) => {
      try {
        const mutation = `
          mutation ReadNotification($id: String!) {
            readNotification(id: $id)
          }
        `;
        
        const data = await gql.request<{ readNotification: boolean }>(mutation, { id });
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.readNotification,
          notificationId: id
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // MARK ALL NOTIFICATIONS READ
  server.registerTool(
    "affine_read_all_notifications",
    {
      title: "Mark All Notifications Read",
      description: "Mark all notifications as read.",
      inputSchema: {}
    },
    async () => {
      try {
        const mutation = `
          mutation ReadAllNotifications {
            readAllNotifications
          }
        `;
        
        const data = await gql.request<{ readAllNotifications: boolean }>(mutation);
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.readAllNotifications,
          message: "All notifications marked as read"
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );
}