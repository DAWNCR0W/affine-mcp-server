#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const PROXY_PATH = path.join(PROJECT_DIR, "bin", "affine-mcp-http-proxy");
const SERVER_PATH = path.join(PROJECT_DIR, "dist", "index.js");
assert.ok(existsSync(SERVER_PATH), "dist/index.js is missing; run npm run build before test:fast");
const TOKEN = "test-proxy-token";
const SESSION_ID = "session-for-test";

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

function sse(response, message, headers = {}) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    ...headers,
  });
  response.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

async function startServer() {
  const requests = [];
  let deleteCount = 0;
  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    assert.equal(authorization, `Bearer ${TOKEN}`, "proxy must keep the bearer token in the HTTP boundary");

    if (request.method === "DELETE") {
      assert.equal(request.headers["mcp-session-id"], SESSION_ID, "proxy must close its own HTTP session");
      deleteCount += 1;
      response.writeHead(204).end();
      return;
    }

    assert.equal(request.method, "POST", "proxy must use POST for MCP messages");
    const message = JSON.parse(await readBody(request));
    requests.push(message);
    if (message.method === "initialize") {
      sse(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "stub", version: "1.0.0" } },
      }, { "mcp-session-id": SESSION_ID });
      return;
    }
    if (message.method === "notifications/initialized") {
      assert.equal(request.headers["mcp-session-id"], SESSION_ID, "initialized notification must use the HTTP session");
      response.writeHead(202).end();
      return;
    }
    if (message.method === "tools/list") {
      assert.equal(request.headers["mcp-session-id"], SESSION_ID, "tool request must use the HTTP session");
      sse(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "example" }] },
      });
      return;
    }
    response.writeHead(400).end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object", "test HTTP server address");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    deleteCount: () => deleteCount,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function waitFor(predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for proxy output")), timeoutMs);
    const poll = () => {
      if (predicate()) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function main() {
  const stub = await startServer();
  const child = spawn("node", [PROXY_PATH], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      AFFINE_MCP_HTTP_PROXY_URL: stub.endpoint,
      AFFINE_MCP_HTTP_TOKEN: TOKEN,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = [];
  let stderr = "";
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  try {
    await waitFor(() => responses.length === 2);
    assert.deepEqual(responses.map((response) => response.id), [1, 2], "proxy must preserve JSON-RPC response ids");
    assert.equal(responses[1].result.tools[0].name, "example", "proxy must parse streamable HTTP SSE responses");

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0, `proxy exit: ${stderr}`);
    assert.equal(stub.deleteCount(), 1, "proxy must delete its HTTP MCP session on stdio EOF");
    assert.deepEqual(
      stub.requests.map((message) => message.method),
      ["initialize", "notifications/initialized", "tools/list"],
      "proxy must forward the complete stdio MCP exchange",
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await stub.close();
  }
}

async function testNativeStdioEof() {
  const child = spawn("node", [SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      AFFINE_BASE_URL: "http://127.0.0.1:9",
      AFFINE_API_TOKEN: "test-affine-api-token",
      AFFINE_MCP_AUTH_MODE: "bearer",
      XDG_CONFIG_HOME: `/tmp/affine-mcp-stdio-eof-${process.pid}`,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => stderr.includes("Enabled tools:"));
    child.stdin.end();
    const result = await Promise.race([
      once(child, "exit").then(([code, signal]) => ({ code, signal })),
      new Promise((resolve) => setTimeout(() => resolve(null), 4_000)),
    ]);
    assert.ok(result, `native stdio server did not exit after EOF: ${stderr}`);
    assert.equal(result.code, 0, `native stdio EOF exit code: ${stderr}`);
    assert.equal(result.signal, null, `native stdio EOF exit signal: ${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

await main();
await testNativeStdioEof();
console.log("stdio HTTP proxy tests passed");
