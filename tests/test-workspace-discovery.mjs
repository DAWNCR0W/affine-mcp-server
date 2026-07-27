#!/usr/bin/env node

import assert from "node:assert/strict";

import * as Y from "yjs";

import { registerWorkspaceTools } from "../dist/tools/workspaces.js";

class ToolRegistry {
  tools = new Map();

  registerTool(name, definition, handler) {
    this.tools.set(name, { definition, handler });
  }
}

function parseTextContent(result) {
  const raw = result?.content?.[0]?.text;
  return raw ? JSON.parse(raw) : null;
}

function parseToolResult(result) {
  return result?.structuredContent ?? parseTextContent(result);
}

function encodedWorkspaceProfile(name, avatar) {
  const doc = new Y.Doc();
  const meta = doc.getMap("meta");
  if (name !== undefined) meta.set("name", name);
  if (avatar !== undefined) meta.set("avatar", avatar);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function makeSocket() {
  return {
    disconnected: false,
    disconnect() {
      this.disconnected = true;
    },
  };
}

async function testListEnrichesProfilesBestEffort() {
  const originalBaseUrl = process.env.AFFINE_BASE_URL;
  process.env.AFFINE_BASE_URL = "https://affine.example/";
  try {
    const registry = new ToolRegistry();
    const socket = makeSocket();
    const joins = [];
    const loads = [];
    let connectionAuthCalls = 0;
    let connectCalls = 0;

    const gql = {
      endpoint: "https://api.example/graphql",
      async request(query) {
        assert.match(query, /workspaces \{ id public enableAi createdAt \}/);
        return {
          workspaces: [
            { id: "workspace-1", public: false, enableAi: true, createdAt: "2026-07-27T00:00:00.000Z" },
            { id: "workspace-2", public: true, enableAi: false, createdAt: "2026-07-26T00:00:00.000Z" },
          ],
        };
      },
      async getConnectionAuth() {
        connectionAuthCalls += 1;
        return {
          endpoint: "https://api.example/graphql",
          cookie: "session=value",
          bearer: "",
          headers: {},
        };
      },
    };

    registerWorkspaceTools(registry, gql, {
      async connectWorkspaceSocket(url, cookie, bearer) {
        connectCalls += 1;
        assert.equal(url, "wss://api.example");
        assert.equal(cookie, "session=value");
        assert.equal(bearer, "");
        return socket;
      },
      async joinWorkspace(_socket, workspaceId) {
        joins.push(workspaceId);
        if (workspaceId === "workspace-2") throw new Error("profile denied");
      },
      async loadDoc(_socket, workspaceId, docId) {
        loads.push({ workspaceId, docId });
        return { missing: encodedWorkspaceProfile("Product", "blob-avatar") };
      },
    });

    const listTool = registry.tools.get("list_workspaces");
    assert.ok(listTool, "list_workspaces must be registered");
    assert.ok(listTool.definition.inputSchema.includeProfile, "includeProfile input must be declared");

    const result = await listTool.handler({});
    assert.equal(result.isError, undefined);
    assert.deepEqual(parseTextContent(result), [
      {
        id: "workspace-1",
        public: false,
        enableAi: true,
        createdAt: "2026-07-27T00:00:00.000Z",
        name: "Product",
        avatar: "blob-avatar",
        url: "https://affine.example/workspace/workspace-1",
        profileStatus: "available",
      },
      {
        id: "workspace-2",
        public: true,
        enableAi: false,
        createdAt: "2026-07-26T00:00:00.000Z",
        name: null,
        avatar: null,
        url: "https://affine.example/workspace/workspace-2",
        profileStatus: "unavailable",
      },
    ]);
    assert.equal(connectionAuthCalls, 1);
    assert.equal(connectCalls, 1, "one socket must be reused for the full list");
    assert.deepEqual(joins, ["workspace-1", "workspace-2"]);
    assert.deepEqual(loads, [{ workspaceId: "workspace-1", docId: "workspace-1" }]);
    assert.equal(socket.disconnected, true, "the shared socket must always disconnect");
  } finally {
    if (originalBaseUrl === undefined) delete process.env.AFFINE_BASE_URL;
    else process.env.AFFINE_BASE_URL = originalBaseUrl;
  }
}

async function testListCanSkipProfileLoading() {
  const registry = new ToolRegistry();
  let connectionAuthCalls = 0;
  const gql = {
    endpoint: "https://affine.example/custom-graphql",
    async request() {
      return { workspaces: [{ id: "workspace-fast", public: false, enableAi: false, createdAt: "now" }] };
    },
    async getConnectionAuth() {
      connectionAuthCalls += 1;
      throw new Error("profile loading must be skipped");
    },
  };
  registerWorkspaceTools(registry, gql, {
    async connectWorkspaceSocket() {
      throw new Error("profile loading must be skipped");
    },
  });

  const result = parseTextContent(await registry.tools.get("list_workspaces").handler({ includeProfile: false }));
  assert.deepEqual(result, [{
    id: "workspace-fast",
    public: false,
    enableAi: false,
    createdAt: "now",
    name: null,
    avatar: null,
    url: "https://affine.example/workspace/workspace-fast",
    profileStatus: "skipped",
  }]);
  assert.equal(connectionAuthCalls, 0);
}

async function testGetWorkspaceUsesTheSameProfileContract() {
  const registry = new ToolRegistry();
  const socket = makeSocket();
  const requests = [];
  const gql = {
    endpoint: "https://affine.example/graphql",
    async request(query, variables) {
      requests.push({ query, variables });
      return {
        workspace: {
          id: "workspace-detail",
          public: false,
          enableAi: true,
          createdAt: "2026-07-27T00:00:00.000Z",
          permissions: { Workspace_Read: true, Workspace_CreateDoc: true },
        },
      };
    },
    async getConnectionAuth() {
      return { endpoint: this.endpoint, cookie: "", bearer: "token", headers: {} };
    },
  };
  registerWorkspaceTools(registry, gql, {
    async connectWorkspaceSocket() {
      return socket;
    },
    async joinWorkspace(_socket, workspaceId) {
      assert.equal(workspaceId, "workspace-detail");
    },
    async loadDoc(_socket, workspaceId, docId) {
      assert.equal(workspaceId, "workspace-detail");
      assert.equal(docId, "workspace-detail");
      return { missing: encodedWorkspaceProfile("Detailed Workspace", "") };
    },
  });

  const result = await registry.tools.get("get_workspace").handler({ id: "workspace-detail" });
  assert.deepEqual(result.structuredContent, {
    id: "workspace-detail",
    public: false,
    enableAi: true,
    createdAt: "2026-07-27T00:00:00.000Z",
    permissions: { Workspace_Read: true, Workspace_CreateDoc: true },
    name: "Detailed Workspace",
    avatar: "",
    url: "https://affine.example/workspace/workspace-detail",
    profileStatus: "available",
  });
  assert.deepEqual(requests[0].variables, { id: "workspace-detail" });
  assert.equal(socket.disconnected, true);
}

async function testProfileFailuresDoNotHideGraphqlResults() {
  const registry = new ToolRegistry();
  let requestMode = "success";
  const gql = {
    endpoint: "https://affine.example/graphql",
    async request() {
      if (requestMode === "failure") throw new Error("GraphQL unavailable");
      return { workspaces: [{ id: "workspace-1", public: false, enableAi: true, createdAt: "now" }] };
    },
    async getConnectionAuth() {
      return { endpoint: this.endpoint, cookie: "", bearer: "", headers: {} };
    },
  };
  registerWorkspaceTools(registry, gql, {
    async connectWorkspaceSocket() {
      throw new Error("WebSocket unavailable");
    },
  });

  const degraded = await registry.tools.get("list_workspaces").handler({});
  assert.equal(degraded.isError, undefined);
  assert.equal(parseTextContent(degraded)[0].profileStatus, "unavailable");

  requestMode = "failure";
  const failed = await registry.tools.get("list_workspaces").handler({});
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.code, "workspace_list_failed");
  assert.match(failed.structuredContent.error, /GraphQL unavailable/);
}

await testListEnrichesProfilesBestEffort();
await testListCanSkipProfileLoading();
await testGetWorkspaceUsesTheSameProfileContract();
await testProfileFailuresDoNotHideGraphqlResults();
console.log("Workspace discovery tests passed");
