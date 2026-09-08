#!/usr/bin/env node
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import {
  OAUTH_DISCOVERY_TIMEOUT_MS,
  probeOAuthReadiness,
} from "../dist/oauth.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(promise, expected, message) {
  try {
    await promise;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert(detail.includes(expected), `${message}: unexpected error: ${detail}`);
    return;
  }
  throw new Error(`${message}: expected a rejection`);
}

const state = {
  issuerDelay: false,
  issuerFailures: 0,
  issuerRequests: 0,
  timeoutRequests: 0,
  timeoutMode: "hang",
};
const sockets = new Set();
let releaseIssuer;
const server = createServer(async (request, response) => {
  if (request.url === "/.well-known/oauth-authorization-server/issuer") {
    state.issuerRequests += 1;
    if (state.issuerFailures > 0) {
      state.issuerFailures -= 1;
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("temporary discovery failure");
      return;
    }
    if (state.issuerDelay) {
      await new Promise((resolve) => { releaseIssuer = resolve; });
    }
    const issuer = `http://127.0.0.1:${server.address().port}/issuer`;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      jwks_uri: `${issuer}/jwks`,
    }));
    return;
  }

  if (request.url === "/.well-known/oauth-authorization-server/timeout") {
    state.timeoutRequests += 1;
    if (state.timeoutMode === "hang") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"issuer":"');
      return;
    }
    const issuer = `http://127.0.0.1:${server.address().port}/timeout`;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      jwks_uri: `${issuer}/jwks`,
    }));
    return;
  }

  response.writeHead(404);
  response.end();
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const port = server.address().port;
  const issuerUrl = `http://127.0.0.1:${port}/issuer`;
  const timeoutIssuerUrl = `http://127.0.0.1:${port}/timeout`;

  state.issuerFailures = 1;
  await assertRejects(
    probeOAuthReadiness({
      publicBaseUrl: "http://127.0.0.1:3100",
      issuerUrl,
      scopes: ["mcp"],
      clockSkewSeconds: 60,
    }),
    "HTTP 503",
    "transient discovery failure",
  );
  assert(state.issuerRequests === 1, "failed discovery should have one in-flight request");

  state.issuerDelay = true;
  const concurrentPromise = Promise.all(Array.from({ length: 20 }, () => probeOAuthReadiness({
    publicBaseUrl: "http://127.0.0.1:3100",
    issuerUrl,
    scopes: ["mcp"],
    clockSkewSeconds: 60,
  })));
  const requestDeadline = Date.now() + 1_000;
  while (state.issuerRequests < 2 && Date.now() < requestDeadline) await delay(5);
  assert(state.issuerRequests === 2, "retry did not start a fresh discovery request");
  assert(typeof releaseIssuer === "function", "concurrent discovery request was not held in flight");
  releaseIssuer();
  state.issuerDelay = false;
  const concurrent = await concurrentPromise;
  assert(concurrent.every((result) => result.jwksUri.endsWith("/jwks")), "concurrent discovery result");
  assert(state.issuerRequests === 2, "concurrent discovery should share one in-flight request");
  const cached = await probeOAuthReadiness({
    publicBaseUrl: "http://127.0.0.1:3100",
    issuerUrl,
    scopes: ["mcp"],
    clockSkewSeconds: 60,
  });
  assert(cached.issuer === issuerUrl && state.issuerRequests === 2, "successful discovery should remain cached");

  const timeoutStartedAt = Date.now();
  await assertRejects(
    probeOAuthReadiness({
      publicBaseUrl: "http://127.0.0.1:3100",
      issuerUrl: timeoutIssuerUrl,
      scopes: ["mcp"],
      clockSkewSeconds: 60,
    }),
    "timed out",
    "discovery body timeout",
  );
  const timeoutElapsed = Date.now() - timeoutStartedAt;
  assert(timeoutElapsed >= OAUTH_DISCOVERY_TIMEOUT_MS - 500, "discovery timed out before the configured bound");
  assert(timeoutElapsed < OAUTH_DISCOVERY_TIMEOUT_MS + 2_000, "discovery timeout exceeded its configured bound");

  state.timeoutMode = "success";
  const timeoutRecovery = await probeOAuthReadiness({
    publicBaseUrl: "http://127.0.0.1:3100",
    issuerUrl: timeoutIssuerUrl,
    scopes: ["mcp"],
    clockSkewSeconds: 60,
  });
  assert(timeoutRecovery.issuer === timeoutIssuerUrl, "timed-out metadata entry was not evicted for retry");
  assert(state.timeoutRequests === 2, "timeout retry should perform a fresh discovery request");

  console.log("OAuth discovery regression tests passed.");
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await delay(0);
}
