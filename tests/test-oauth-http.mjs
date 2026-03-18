#!/usr/bin/env node
/**
 * Integration test for optional OAuth mode on the HTTP MCP server.
 *
 * Covers:
 * - protected resource metadata discovery
 * - 401 challenge for unauthenticated /mcp requests
 * - rejection of query-string tokens in oauth mode
 * - required-scope enforcement
 * - valid JWT access token acceptance
 * - sign_in tool disabled in oauth mode
 */
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.resolve(PROJECT_DIR, "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || "60000");

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectIncludes(haystack, needle, message) {
  if (!String(haystack).includes(String(needle))) {
    throw new Error(`${message}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  }
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForSuccessfulFetch(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // ignore until timeout
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function generateAffineApiToken() {
  const client = new Client({ name: "affine-mcp-oauth-http-token", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: PROJECT_DIR,
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-oauth-http-token-noconfig",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", chunk => {
    process.stderr.write(`[stdio-token] ${chunk}`);
  });

  await client.connect(transport);
  try {
    const tokenResult = await client.callTool(
      { name: "generate_access_token", arguments: { name: `oauth-http-${Date.now()}` } },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    if (tokenResult?.isError) {
      throw new Error(`generate_access_token MCP error: ${tokenResult?.content?.[0]?.text || "unknown"}`);
    }
    const parsed = parseContent(tokenResult);
    expectTruthy(parsed?.token, "generate_access_token token");
    return parsed.token;
  } finally {
    await transport.close();
  }
}

async function startMockIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "oauth-http-test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const port = await findFreePort();
  const issuerBaseUrl = `http://127.0.0.1:${port}`;
  const metadata = {
    issuer: issuerBaseUrl,
    authorization_endpoint: `${issuerBaseUrl}/authorize`,
    token_endpoint: `${issuerBaseUrl}/token`,
    jwks_uri: `${issuerBaseUrl}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp"],
  };

  const server = createServer((req, res) => {
    const sendJson = (payload) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    };

    if (req.url === "/.well-known/oauth-authorization-server" || req.url === "/.well-known/openid-configuration") {
      sendJson(metadata);
      return;
    }
    if (req.url === "/.well-known/jwks.json") {
      sendJson({ keys: [publicJwk] });
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const mintToken = async ({ scope = "mcp", expiresInSeconds = 300 }) => {
    let jwt = new SignJWT({ scope, client_id: "oauth-http-test-client" })
      .setProtectedHeader({ alg: "RS256", kid: String(publicJwk.kid) })
      .setIssuer(issuerBaseUrl)
      .setSubject("oauth-http-test-user")
      .setAudience(`${oauthPublicBaseUrl}/mcp`)
      .setIssuedAt();

    jwt = expiresInSeconds >= 0
      ? jwt.setExpirationTime(`${expiresInSeconds}s`)
      : jwt.setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds);

    return await jwt.sign(privateKey);
  };

  let oauthPublicBaseUrl = "";
  const setAudienceBase = (baseUrl) => {
    oauthPublicBaseUrl = baseUrl;
  };

  return {
    issuerBaseUrl,
    mintToken,
    setAudienceBase,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startOAuthHttpServer(affineApiToken, issuerBaseUrl) {
  const port = await findFreePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const child = spawn("node", [MCP_SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(port),
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_API_TOKEN: affineApiToken,
      AFFINE_MCP_AUTH_MODE: "oauth",
      AFFINE_MCP_HTTP_HOST: "127.0.0.1",
      AFFINE_MCP_PUBLIC_BASE_URL: publicBaseUrl,
      AFFINE_OAUTH_ISSUER_URL: issuerBaseUrl,
      AFFINE_OAUTH_SCOPES: "mcp",
      XDG_CONFIG_HOME: "/tmp/affine-mcp-oauth-http-server-noconfig",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", chunk => process.stderr.write(`[oauth-http-server] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[oauth-http-server] ${chunk}`));

  await waitForSuccessfulFetch(`${publicBaseUrl}/.well-known/oauth-protected-resource`);

  return {
    child,
    publicBaseUrl,
    mcpUrl: `${publicBaseUrl}/mcp`,
    async close() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function main() {
  console.log("=== OAuth HTTP Integration Test ===");
  console.log(`AFFiNE Base URL: ${BASE_URL}`);
  console.log();

  const affineApiToken = await generateAffineApiToken();
  const issuer = await startMockIssuer();
  let server = null;

  try {
    server = await startOAuthHttpServer(affineApiToken, issuer.issuerBaseUrl);
    issuer.setAudienceBase(server.publicBaseUrl);

    const healthz = await fetch(`${server.publicBaseUrl}/healthz`);
    expectEqual(healthz.status, 200, "oauth healthz status");
    const readyz = await fetch(`${server.publicBaseUrl}/readyz`);
    expectEqual(readyz.status, 200, "oauth readyz status");
    const readyzPayload = await readyz.json();
    expectEqual(readyzPayload?.authMode, "oauth", "oauth readyz authMode");

    const metadataResponse = await fetch(`${server.publicBaseUrl}/.well-known/oauth-protected-resource`);
    expectEqual(metadataResponse.status, 200, "protected resource metadata status");
    const metadata = await metadataResponse.json();
    expectEqual(metadata.authorization_servers?.[0], issuer.issuerBaseUrl, "authorization_servers[0]");
    expectEqual(metadata.resource, `${server.publicBaseUrl}/mcp`, "protected resource resource");
    expectTruthy(Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.includes("mcp"), "scopes_supported");

    const pathSpecificMetadataResponse = await fetch(
      `${server.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expectEqual(pathSpecificMetadataResponse.status, 200, "path-specific protected resource metadata status");

    const initializeBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "oauth-http-test", version: "1.0.0" },
      },
    };

    const unauthorized = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeBody),
    });
    expectEqual(unauthorized.status, 401, "unauthorized /mcp status");
    expectIncludes(
      unauthorized.headers.get("www-authenticate"),
      `resource_metadata="${server.publicBaseUrl}/.well-known/oauth-protected-resource"`,
      "WWW-Authenticate resource metadata",
    );

    const queryTokenRejected = await fetch(`${server.mcpUrl}?token=legacy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeBody),
    });
    expectEqual(queryTokenRejected.status, 400, "query token rejection status");

    const expiredToken = await issuer.mintToken({ expiresInSeconds: -60 });
    const expiredResponse = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${expiredToken}`,
      },
      body: JSON.stringify(initializeBody),
    });
    expectEqual(expiredResponse.status, 401, "expired token status");

    const insufficientScopeToken = await issuer.mintToken({ scope: "profile" });
    const insufficientScopeResponse = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${insufficientScopeToken}`,
      },
      body: JSON.stringify(initializeBody),
    });
    expectEqual(insufficientScopeResponse.status, 403, "insufficient scope status");

    const validToken = await issuer.mintToken({ scope: "mcp" });
    const client = new Client({ name: "oauth-http-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      },
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map(tool => tool.name);
      if (toolNames.includes("sign_in")) {
        throw new Error("sign_in should not be exposed in oauth mode");
      }

      const currentUser = parseContent(await client.callTool({ name: "current_user", arguments: {} }));
      expectEqual(currentUser?.email, EMAIL, "current_user via oauth mode");
    } finally {
      await transport.close();
    }

    console.log();
    console.log("=== OAuth HTTP integration test passed ===");
  } finally {
    if (server) {
      await server.close();
    }
    await issuer.close();
  }
}

main().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
