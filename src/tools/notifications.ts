import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";

const MAX_NOTIFICATION_PAGE_SIZE = 100;
const MAX_GRAPHQL_OFFSET = 2_147_483_647;
const MAX_CURSOR_LENGTH = 2_048;

const NotificationListInputShape = {
  first: z.number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATION_PAGE_SIZE)
    .optional()
    .describe(`Number of notifications to fetch (default 20, maximum ${MAX_NOTIFICATION_PAGE_SIZE}).`),
  offset: z.number()
    .int()
    .min(0)
    .max(MAX_GRAPHQL_OFFSET)
    .optional()
    .describe("Zero-based offset pagination. Mutually exclusive with after."),
  after: z.string()
    .trim()
    .min(1)
    .max(MAX_CURSOR_LENGTH)
    .optional()
    .describe("Cursor from pagination.pageInfo.endCursor. Mutually exclusive with offset."),
  unreadOnly: z.boolean()
    .optional()
    .describe("Return only unread notifications from the fetched server page; this is not a server-wide unread query."),
};

const NotificationListInput = z.object(NotificationListInputShape)
  .strict()
  .superRefine((value, context) => {
    if (value.offset !== undefined && value.after !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offset and after are mutually exclusive.",
        path: ["after"],
      });
    }
  });

type NotificationListArgs = z.infer<typeof NotificationListInput>;

type NotificationNode = {
  id: string;
  type?: string | null;
  body?: unknown;
  read?: boolean | null;
  level?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
};

type NotificationEdge = {
  cursor?: string | null;
  node?: NotificationNode | null;
};

type NotificationConnection = {
  edges?: NotificationEdge[] | null;
  totalCount?: number | null;
  pageInfo?: {
    hasNextPage?: boolean | null;
    endCursor?: string | null;
  } | null;
};

function normalizeNotificationConnection(
  connection: NotificationConnection | null | undefined,
  input: Required<Pick<NotificationListArgs, "first" | "unreadOnly">> &
    Pick<NotificationListArgs, "offset" | "after">,
) {
  const edges = Array.isArray(connection?.edges) ? connection.edges : [];
  const pageNotifications = edges.map((edge, index) => {
    if (!edge?.node || typeof edge.node !== "object") {
      throw new Error(`AFFiNE returned a malformed notification edge at index ${index}.`);
    }
    return {
      ...edge.node,
      cursor: typeof edge.cursor === "string" ? edge.cursor : null,
    };
  });
  const unreadOnFetchedPageCount = pageNotifications.filter(
    (notification) => notification.read === false,
  ).length;
  const notifications = input.unreadOnly
    ? pageNotifications.filter((notification) => notification.read === false)
    : pageNotifications;

  const mode = input.after !== undefined
    ? "cursor"
    : input.offset !== undefined
      ? "offset"
      : "initial";

  return {
    kind: "notification.list",
    notifications,
    pagination: {
      mode,
      input: {
        first: input.first,
        offset: input.offset ?? null,
        after: input.after ?? null,
      },
      pageInfo: {
        hasNextPage: typeof connection?.pageInfo?.hasNextPage === "boolean"
          ? connection.pageInfo.hasNextPage
          : null,
        endCursor: typeof connection?.pageInfo?.endCursor === "string"
          ? connection.pageInfo.endCursor
          : null,
      },
    },
    counts: {
      serverTotalCount: typeof connection?.totalCount === "number" ? connection.totalCount : null,
      serverUnreadTotalCount: null,
      fetchedPageCount: pageNotifications.length,
      unreadOnFetchedPageCount,
      returnedCount: notifications.length,
    },
    filter: {
      unreadOnly: input.unreadOnly,
      scope: input.unreadOnly ? "fetched_page" : "none",
      serverSide: false,
      affectsServerTotalCount: false,
      affectsPageInfo: false,
    },
  };
}

export function registerNotificationTools(server: McpServer, gql: GraphQLClient) {
  const listNotificationsHandler = async (rawArgs: unknown) => {
    // Parse again inside the handler so direct/programmatic callers get the same
    // fail-closed bounds and cross-field validation as MCP schema callers.
    const parsed = NotificationListInput.parse(rawArgs ?? {});
    const first = parsed.first ?? 20;
    const unreadOnly = parsed.unreadOnly ?? false;

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
      const pagination = {
        first,
        ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
        ...(parsed.after !== undefined ? { after: parsed.after } : {}),
      };
      const data = await gql.request<{
        currentUser?: { notifications?: NotificationConnection | null } | null;
      }>(query, { pagination });

      return text(normalizeNotificationConnection(data.currentUser?.notifications, {
        first,
        offset: parsed.offset,
        after: parsed.after,
        unreadOnly,
      }));
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "list_notifications",
    {
      title: "List Notifications",
      description:
        "List one server page of current-user AFFiNE notifications in a stable envelope. " +
        "The response preserves each edge cursor, server pageInfo, and serverTotalCount. " +
        "unreadOnly is a client-side filter over only the fetched page; it does not change server counts or pageInfo.",
      inputSchema: NotificationListInputShape,
    },
    listNotificationsHandler as any,
  );

  const readAllNotificationsHandler = async () => {
    try {
      const mutation = `
        mutation ReadAllNotifications {
          readAllNotifications
        }
      `;
      const data = await gql.request<{ readAllNotifications: boolean }>(mutation);
      const serverResult = typeof data.readAllNotifications === "boolean"
        ? data.readAllNotifications
        : null;
      const applied = serverResult === true;

      return text({
        kind: "notification.read_all",
        success: applied,
        applied,
        status: applied ? "applied" : "not_applied",
        serverResult,
        message: applied
          ? "AFFiNE reported that all notifications were marked as read."
          : "AFFiNE did not report applying the read-all mutation; notification state may be unchanged.",
      });
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "read_all_notifications",
    {
      title: "Mark All Notifications Read",
      description:
        "Ask AFFiNE to mark every current-user notification as read. " +
        "Inspect applied/status in the response; a false server result is reported as not_applied, not as success.",
      inputSchema: {},
    },
    readAllNotificationsHandler as any,
  );
}
