#!/usr/bin/env node
import { registerNotificationTools } from "../dist/tools/notifications.js";

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function expectToolFailure(result, expected, label) {
  const payload = result.structuredContent;
  expect(result.isError === true, `${label}: MCP isError must be true`);
  expectEqual(payload.ok, false, `${label}: ok`);
  expectEqual(payload.code, expected.code, `${label}: code`);
  expectEqual(payload.retryable, expected.retryable, `${label}: retryable`);
  expectEqual(payload.status, expected.status, `${label}: status`);
  expect(typeof payload.error === "string" && payload.error.length > 0, `${label}: error message`);
  expect(!("success" in payload), `${label}: failure must not include success`);
  return payload;
}

async function expectRejected(promise, messagePattern, label) {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(messagePattern.test(message), `${label}: unexpected error: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

function makeConnection() {
  return {
    totalCount: 42,
    pageInfo: {
      hasNextPage: true,
      endCursor: "cursor-3",
    },
    edges: [
      {
        cursor: "cursor-1",
        node: {
          id: "notification-1",
          type: "comment",
          body: { text: "First" },
          read: false,
          level: "info",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      },
      {
        cursor: "cursor-2",
        node: {
          id: "notification-2",
          type: "mention",
          body: { text: "Second" },
          read: true,
          level: "info",
          createdAt: "2026-07-10T00:01:00.000Z",
          updatedAt: "2026-07-10T00:01:00.000Z",
        },
      },
      {
        cursor: "cursor-3",
        node: {
          id: "notification-3",
          type: "comment",
          body: { text: "Third" },
          read: false,
          level: "warning",
          createdAt: "2026-07-10T00:02:00.000Z",
          updatedAt: "2026-07-10T00:02:00.000Z",
        },
      },
    ],
  };
}

const tools = new Map();
const server = {
  registerTool(name, definition, handler) {
    tools.set(name, { definition, handler });
  },
};

const requests = [];
const readAllResults = [true, false];
let nextRequestError = null;
const gql = {
  async request(query, variables) {
    requests.push({ query, variables });
    if (nextRequestError) {
      const error = nextRequestError;
      nextRequestError = null;
      throw error;
    }
    if (query.includes("ReadAllNotifications")) {
      return { readAllNotifications: readAllResults.shift() };
    }
    return {
      currentUser: {
        notifications: makeConnection(),
      },
    };
  },
};

registerNotificationTools(server, gql);

const listTool = tools.get("list_notifications");
const readAllTool = tools.get("read_all_notifications");
expect(listTool, "list_notifications was not registered");
expect(readAllTool, "read_all_notifications was not registered");
expect(
  listTool.definition.description.includes("only the fetched page"),
  "list_notifications description must disclose page-local unread filtering",
);
expect(
  readAllTool.definition.description.includes("not_applied"),
  "read_all_notifications description must disclose false-result semantics",
);

const initialResult = await listTool.handler({});
const initial = initialResult.structuredContent;
expectEqual(initial.kind, "notification.list", "list envelope kind");
expectEqual(initial.pagination, {
  mode: "initial",
  input: { first: 20, offset: null, after: null },
  pageInfo: { hasNextPage: true, endCursor: "cursor-3" },
}, "initial pagination envelope");
expectEqual(initial.counts, {
  serverTotalCount: 42,
  serverUnreadTotalCount: null,
  fetchedPageCount: 3,
  unreadOnFetchedPageCount: 2,
  returnedCount: 3,
}, "initial count envelope");
expectEqual(initial.notifications.map((notification) => notification.cursor), [
  "cursor-1",
  "cursor-2",
  "cursor-3",
], "edge cursors must be preserved on notifications");
expectEqual(initial.filter, {
  unreadOnly: false,
  scope: "none",
  serverSide: false,
  affectsServerTotalCount: false,
  affectsPageInfo: false,
}, "unfiltered filter metadata");
expectEqual(requests[0].variables.pagination, { first: 20 }, "default GraphQL pagination variables");

const unreadResult = await listTool.handler({ first: 3, offset: 10, unreadOnly: true });
const unread = unreadResult.structuredContent;
expectEqual(unread.notifications.map((notification) => notification.id), [
  "notification-1",
  "notification-3",
], "unreadOnly must filter only unread nodes from the fetched page");
expectEqual(unread.counts, {
  serverTotalCount: 42,
  serverUnreadTotalCount: null,
  fetchedPageCount: 3,
  unreadOnFetchedPageCount: 2,
  returnedCount: 2,
}, "unread count envelope");
expectEqual(unread.filter, {
  unreadOnly: true,
  scope: "fetched_page",
  serverSide: false,
  affectsServerTotalCount: false,
  affectsPageInfo: false,
}, "page-local unread filter metadata");
expectEqual(unread.pagination.pageInfo, {
  hasNextPage: true,
  endCursor: "cursor-3",
}, "unread filtering must not rewrite server pageInfo");
expectEqual(requests[1].variables.pagination, {
  first: 3,
  offset: 10,
}, "offset GraphQL pagination variables");

const cursorResult = await listTool.handler({ first: 5, after: "  cursor-before  " });
const cursorPage = cursorResult.structuredContent;
expectEqual(cursorPage.pagination.mode, "cursor", "cursor pagination mode");
expectEqual(cursorPage.pagination.input.after, "cursor-before", "cursor normalization");
expectEqual(requests[2].variables.pagination, {
  first: 5,
  after: "cursor-before",
}, "cursor GraphQL pagination variables");

const invalidCases = [
  [{ first: 0 }, /greater than or equal to 1/, "first lower bound"],
  [{ first: 101 }, /less than or equal to 100/, "first upper bound"],
  [{ first: 1.5 }, /integer/, "first integer bound"],
  [{ offset: -1 }, /greater than or equal to 0/, "offset lower bound"],
  [{ offset: 1.5 }, /integer/, "offset integer bound"],
  [{ offset: 2_147_483_648 }, /less than or equal to 2147483647/, "offset GraphQL bound"],
  [{ after: "   " }, /at least 1 character/, "empty cursor"],
  [{ after: "x".repeat(2_049) }, /at most 2048 character/, "cursor length bound"],
  [{ offset: 0, after: "cursor" }, /mutually exclusive/, "offset/after conflict"],
];
for (const [args, pattern, label] of invalidCases) {
  await expectRejected(listTool.handler(args), pattern, label);
}
expectEqual(requests.length, 3, "invalid pagination must fail before GraphQL requests");

nextRequestError = new Error("notification backend unavailable");
const listFailure = await listTool.handler({ first: 5 });
const listFailurePayload = expectToolFailure(listFailure, {
  code: "notification_list_failed",
  retryable: true,
  status: "failed",
}, "list failure contract");
expectEqual(listFailurePayload.kind, "notification.list", "list failure kind");
expectEqual(listFailurePayload.error, "notification backend unavailable", "list failure error");

const appliedResult = (await readAllTool.handler({})).structuredContent;
expectEqual(appliedResult, {
  kind: "notification.read_all",
  success: true,
  applied: true,
  status: "applied",
  serverResult: true,
  message: "AFFiNE reported that all notifications were marked as read.",
}, "truthful applied read-all contract");

const notAppliedToolResult = await readAllTool.handler({});
const notAppliedResult = expectToolFailure(notAppliedToolResult, {
  code: "notification_update_failed",
  retryable: false,
  status: "not_applied",
}, "not-applied read-all contract");
expectEqual(notAppliedResult, {
  kind: "notification.read_all",
  applied: false,
  status: "not_applied",
  serverResult: false,
  ok: false,
  error: "AFFiNE did not report applying the read-all mutation; notification state may be unchanged.",
  code: "notification_update_failed",
  retryable: false,
}, "truthful false read-all contract");
expect(
  !/all notifications marked as read/i.test(notAppliedResult.error),
  "false read-all responses must not use a success-like message",
);

nextRequestError = new Error("notification mutation timed out");
const failedReadAll = await readAllTool.handler({});
const failedReadAllPayload = expectToolFailure(failedReadAll, {
  code: "notification_update_failed",
  retryable: true,
  status: "failed",
}, "read-all exception contract");
expectEqual(failedReadAllPayload.kind, "notification.read_all", "read-all exception kind");
expectEqual(failedReadAllPayload.applied, false, "read-all exception applied");
expectEqual(failedReadAllPayload.serverResult, null, "read-all exception server result");
expectEqual(failedReadAllPayload.error, "notification mutation timed out", "read-all exception error");

console.log(JSON.stringify({
  ok: true,
  cases: [
    "stable list envelope",
    "edge cursor preservation",
    "page-local unread semantics",
    "server and returned counts",
    "offset pagination",
    "cursor pagination",
    "pagination bounds",
    "offset/after conflict",
    "truthful read-all true response",
    "truthful read-all false response",
    "stable list failure envelope",
    "stable read-all failure envelope",
  ],
}, null, 2));
