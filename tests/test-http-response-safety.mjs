#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";

import { fetch as undiciFetch } from "undici";
import nodeFetch from "node-fetch";

import { loginWithPassword } from "../dist/auth.js";
import { GraphQLClient } from "../dist/graphqlClient.js";
import {
  fetchResponseBody,
  MAX_HTTP_RESPONSE_BYTES,
} from "../dist/util/httpResponse.js";
import { registerWorkspaceTools } from "../dist/tools/workspaces.js";

class ToolRegistry {
  tools = new Map();

  registerTool(name, _definition, handler) {
    this.tools.set(name, handler);
  }
}

function parseToolResult(result) {
  return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text || "null");
}

async function startResponseServer() {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume request bodies so multipart callers can finish cleanly.
    }

    if (request.url === "/ok") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === "/streamed") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("x".repeat(96));
      response.end("x".repeat(96));
      return;
    }
    if (request.url === "/at-limit") {
      response.writeHead(200, {
        "Content-Length": "128",
        "Content-Type": "text/plain",
      });
      response.end("x".repeat(128));
      return;
    }
    if (request.url === "/slow") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.flushHeaders();
      const timer = setTimeout(() => response.end('{"ok":true}'), 500);
      response.once("close", () => clearTimeout(timer));
      return;
    }

    response.writeHead(200, {
      "Content-Length": String(MAX_HTTP_RESPONSE_BYTES + 1),
      "Content-Type": "application/json",
    });
    response.end("{}");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function testSharedReader(baseUrl, fetcher, label) {
  const ok = await fetchResponseBody(
    signal => fetcher(`${baseUrl}/ok`, { signal }),
    { label, maxResponseBytes: 128, timeoutMs: 1_000 },
  );
  assert.equal(ok.body, '{"ok":true}');

  const atLimit = await fetchResponseBody(
    signal => fetcher(`${baseUrl}/at-limit`, { signal }),
    { label, maxResponseBytes: 128, timeoutMs: 1_000 },
  );
  assert.equal(Buffer.byteLength(atLimit.body), 128);

  await assert.rejects(
    fetchResponseBody(
      signal => fetcher(`${baseUrl}/declared`, { signal }),
      { label, maxResponseBytes: 128, timeoutMs: 1_000 },
    ),
    /declared 16777217 bytes; the configured limit is 128 bytes/,
  );
  await assert.rejects(
    fetchResponseBody(
      signal => fetcher(`${baseUrl}/streamed`, { signal }),
      { label, maxResponseBytes: 128, timeoutMs: 1_000 },
    ),
    /exceeded the configured limit of 128 bytes/,
  );
  await assert.rejects(
    fetchResponseBody(
      signal => fetcher(`${baseUrl}/slow`, { signal }),
      { label, maxResponseBytes: 128, timeoutMs: 50 },
    ),
    new RegExp(`${label} timed out after 50ms`),
  );
}

async function testCallersRejectDeclaredOversize(baseUrl) {
  const client = new GraphQLClient({ endpoint: `${baseUrl}/graphql` });
  await assert.rejects(
    client.request("query { __typename }"),
    /GraphQL request response declared 16777217 bytes/,
  );

  await assert.rejects(
    loginWithPassword(baseUrl, "user@example.test", "not-a-secret"),
    /Sign-in request response declared 16777217 bytes/,
  );

  const registry = new ToolRegistry();
  const gql = {
    endpoint: `${baseUrl}/workspace`,
    async getConnectionAuth() {
      return {
        bearer: "",
        cookie: "",
        endpoint: this.endpoint,
        headers: {},
      };
    },
  };
  registerWorkspaceTools(registry, gql);
  const result = await registry.tools.get("create_workspace")({ name: "Response Safety" });
  const payload = parseToolResult(result);
  assert.equal(result.isError, true);
  assert.match(payload.error, /Workspace creation request response declared 16777217 bytes/);
}

const server = await startResponseServer();
try {
  await testSharedReader(server.baseUrl, undiciFetch, "Undici request");
  await testSharedReader(server.baseUrl, nodeFetch, "node-fetch request");
  await testCallersRejectDeclaredOversize(server.baseUrl);
} finally {
  await server.close();
}

console.log("HTTP response safety tests passed");
