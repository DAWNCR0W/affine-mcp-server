import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { receipt, text, toolError } from "../util/mcp.js";
import { BoundedOffset, BoundedPageSize } from "../util/inputSchemas.js";

export function registerNotificationTools(server: McpServer, gql: GraphQLClient) {
  // LIST NOTIFICATIONS
  const listNotificationsHandler = async ({ first = 20, offset, after, unreadOnly = false }: { first?: number; offset?: number; after?: string; unreadOnly?: boolean }) => {
    try {
      const query = `
        query GetNotifications($pagination: PaginationInput!) {
          currentUser {
            notifications(pagination: $pagination) {
              edges {
                cursor
                node {
                  id
                  type
                  body
                  read
                  level
                  createdAt
                  updatedAt
                }
              }
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `;
      
      const data = await gql.request<{ currentUser: { notifications: any } }>(query, {
        pagination: {
          first,
          offset,
          after
        }
      });
      
      let notifications = (data.currentUser?.notifications?.edges || []).map((edge: any) => edge.node);
      if (unreadOnly) {
        notifications = notifications.filter((n: any) => !n.read);
      }
      
      return text(notifications);
    } catch (error: any) {
      return toolError(error, {
        code: "notification_list_failed",
        data: { kind: "notification.list", status: "failed" },
      });
    }
  };
  server.registerTool(
    "list_notifications",
    {
      title: "List Notifications",
      description: "List the current user's AFFiNE notifications with optional unread filtering. This is read-only and returns notification ids, read state, level, and timestamps.",
      inputSchema: {
        first: BoundedPageSize.optional().describe("Number of notifications to fetch (1-200)"),
        offset: BoundedOffset.optional().describe("Offset for pagination (maximum 1,000,000)"),
        after: z.string().optional().describe("Cursor for pagination"),
        unreadOnly: z.boolean().optional().describe("Show only unread notifications")
      }
    },
    listNotificationsHandler as any
  );

  // MARK ALL NOTIFICATIONS READ
  const readAllNotificationsHandler = async () => {
    try {
      const mutation = `
        mutation ReadAllNotifications {
          readAllNotifications
        }
      `;
      
      const data = await gql.request<{ readAllNotifications: boolean }>(mutation);
      
      if (!data.readAllNotifications) {
        return toolError("AFFiNE did not confirm that notifications were marked as read.", {
          code: "notification_read_all_failed",
          data: { kind: "notification.read_all", status: "not_applied" },
        });
      }

      return receipt("notification.read_all", {
        status: "completed",
        success: true,
      });
    } catch (error: any) {
      return toolError(error, {
        code: "notification_read_all_failed",
        data: { kind: "notification.read_all", status: "failed" },
      });
    }
  };
  server.registerTool(
    "read_all_notifications",
    {
      title: "Mark All Notifications Read",
      description: "Mark every current-user notification as read. This mutates notification state; use list_notifications first when you need to inspect unread items.",
      inputSchema: {}
    },
    readAllNotificationsHandler as any
  );
}
