import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphQLClient } from "../graphqlClient.js";
import { text, toolError } from "../util/mcp.js";

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
  cursor: string;
  node: NotificationNode;
};

type NotificationConnection = {
  edges: NotificationEdge[];
  totalCount: number;
  pageInfo: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
};

class NotificationAuthenticationError extends Error {}

class NotificationResponseContractError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseContractError(message: string): NotificationResponseContractError {
  return new NotificationResponseContractError(`AFFiNE returned an invalid notification response: ${message}.`);
}

function isAuthenticationError(error: unknown): boolean {
  if (error instanceof NotificationAuthenticationError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /GraphQL HTTP (?:401|403)\b|\b(?:unauthenticated|unauthorized|forbidden|authentication required|login required|not authenticated|not logged in|not signed in|must be signed in|permission denied|access denied)\b/i.test(
    message,
  );
}

function notificationFailure(error: unknown): {
  retryable: boolean;
  status: "auth_required" | "invalid_response" | "failed";
} {
  if (isAuthenticationError(error)) {
    return { retryable: false, status: "auth_required" };
  }
  if (error instanceof NotificationResponseContractError) {
    return { retryable: false, status: "invalid_response" };
  }
  return { retryable: true, status: "failed" };
}

function requireNotificationConnection(data: unknown): NotificationConnection {
  if (!isRecord(data)) {
    throw responseContractError("the GraphQL data object is missing");
  }
  if (data.currentUser === null) {
    throw new NotificationAuthenticationError(
      "AFFiNE did not return a current user; authentication may be missing or expired.",
    );
  }
  if (!isRecord(data.currentUser)) {
    throw responseContractError("currentUser is missing or malformed");
  }
  if (data.currentUser.notifications === null) {
    throw responseContractError("currentUser.notifications is null");
  }
  if (!isRecord(data.currentUser.notifications)) {
    throw responseContractError("currentUser.notifications is missing or malformed");
  }

  const connection = data.currentUser.notifications;
  if (!Array.isArray(connection.edges)) {
    throw responseContractError("notifications.edges is missing or malformed");
  }
  const edges = connection.edges.map((edge, index) => {
    if (!isRecord(edge)) {
      throw responseContractError(`notifications.edges[${index}] is malformed`);
    }
    if (typeof edge.cursor !== "string" || edge.cursor.length === 0) {
      throw responseContractError(`notifications.edges[${index}].cursor is missing or malformed`);
    }
    if (!isRecord(edge.node)) {
      throw responseContractError(`notifications.edges[${index}].node is missing or malformed`);
    }
    if (typeof edge.node.id !== "string" || edge.node.id.length === 0) {
      throw responseContractError(`notifications.edges[${index}].node.id is missing or malformed`);
    }
    return {
      cursor: edge.cursor,
      node: edge.node as NotificationNode,
    };
  });

  if (
    typeof connection.totalCount !== "number" ||
    !Number.isSafeInteger(connection.totalCount) ||
    connection.totalCount < 0
  ) {
    throw responseContractError("notifications.totalCount is missing or malformed");
  }
  if (!isRecord(connection.pageInfo)) {
    throw responseContractError("notifications.pageInfo is missing or malformed");
  }
  if (typeof connection.pageInfo.hasNextPage !== "boolean") {
    throw responseContractError("notifications.pageInfo.hasNextPage is missing or malformed");
  }
  if (
    connection.pageInfo.endCursor !== undefined &&
    connection.pageInfo.endCursor !== null &&
    typeof connection.pageInfo.endCursor !== "string"
  ) {
    throw responseContractError("notifications.pageInfo.endCursor is malformed");
  }

  return {
    edges,
    totalCount: connection.totalCount,
    pageInfo: {
      hasNextPage: connection.pageInfo.hasNextPage,
      endCursor: connection.pageInfo.endCursor as string | null | undefined,
    },
  };
}

function normalizeNotificationConnection(
  connection: NotificationConnection,
  input: Required<Pick<NotificationListArgs, "first" | "unreadOnly">> &
    Pick<NotificationListArgs, "offset" | "after">,
) {
  const pageNotifications = connection.edges.map((edge) => ({
    ...edge.node,
    cursor: edge.cursor,
  }));
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
        hasNextPage: connection.pageInfo.hasNextPage,
        endCursor: typeof connection.pageInfo.endCursor === "string"
          ? connection.pageInfo.endCursor
          : null,
      },
    },
    counts: {
      serverTotalCount: connection.totalCount,
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
      const data = await gql.request<unknown>(query, { pagination });
      const connection = requireNotificationConnection(data);

      return text(normalizeNotificationConnection(connection, {
        first,
        offset: parsed.offset,
        after: parsed.after,
        unreadOnly,
      }));
    } catch (error: any) {
      const failure = notificationFailure(error);
      return toolError(error, {
        code: "notification_list_failed",
        retryable: failure.retryable,
        data: {
          kind: "notification.list",
          status: failure.status,
        },
      });
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
      const data = await gql.request<unknown>(mutation);
      if (!isRecord(data) || typeof data.readAllNotifications !== "boolean") {
        throw responseContractError("readAllNotifications is missing or malformed");
      }
      const serverResult = data.readAllNotifications;
      const applied = serverResult === true;

      if (!applied) {
        return toolError(
          "AFFiNE did not report applying the read-all mutation; notification state may be unchanged.",
          {
            code: "notification_update_failed",
            retryable: false,
            data: {
              kind: "notification.read_all",
              applied: false,
              status: "not_applied",
              serverResult,
            },
          },
        );
      }

      return text({
        kind: "notification.read_all",
        success: true,
        applied: true,
        status: "applied",
        serverResult,
        message: "AFFiNE reported that all notifications were marked as read.",
      });
    } catch (error: any) {
      const failure = notificationFailure(error);
      return toolError(error, {
        code: "notification_update_failed",
        retryable: failure.retryable,
        data: {
          kind: "notification.read_all",
          applied: false,
          status: "failed",
          serverResult: null,
        },
      });
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
