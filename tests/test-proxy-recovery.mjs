#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";

const requests = [];
let generation = 1;
let writes = 0;
let failInitialize = false;
const server = createServer(async (req, res) => {
  if (req.method === "DELETE") {
    res.writeHead(204).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  requests.push(message.method);
  if (message.method === "initialize") {
    if (failInitialize) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `s${generation}` });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "test", version: "1" },
    } }));
    return;
  }
  if (req.headers["mcp-session-id"] !== `s${generation}`) {
    res.writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { code: -32001, message: "Session not found" } }));
    return;
  }
  if (message.method === "notifications/initialized") {
    res.writeHead(202).end();
    return;
  }
  if (message.params?.name === "write") writes++;
  if (message.params?.name === "ambiguous") {
    writes++;
    req.socket.destroy();
    return;
  }
  if (message.params?.name === "ordinary404") {
    res.writeHead(404).end("Not found");
    return;
  }
  if (message.params?.name === "hang") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message\n");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const child = spawn(process.execPath, ["bin/affine-mcp-http-proxy"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    AFFINE_MCP_HTTP_TOKEN: "test",
    AFFINE_MCP_HTTP_PROXY_URL: `http://127.0.0.1:${server.address().port}/mcp`,
    AFFINE_MCP_HTTP_PROXY_TIMEOUT_MS: "300",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let id = 0;
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
createInterface({ input: child.stdout }).on("line", line => {
  const response = JSON.parse(line);
  pending.get(response.id)?.(response);
  pending.delete(response.id);
});
function call(method, params) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`test response timeout: ${stderr}`));
    }, 3000);
    pending.set(requestId, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
}
try {
  assert((await call("initialize", {
    protocolVersion: "2025-03-26", clientInfo: { name: "test", version: "1" }, capabilities: {},
  })).result);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  generation++;
  assert((await call("tools/call", { name: "write", arguments: {} })).result);
  assert.equal(writes, 1, "expired session recovery executes a write exactly once");
  assert.equal(requests.filter(method => method === "initialize").length, 2);
  assert((await call("tools/call", { name: "ambiguous", arguments: {} })).error);
  assert.equal(writes, 2, "ambiguous write must not be replayed");
  assert((await call("tools/call", { name: "ordinary404", arguments: {} })).error);
  assert.equal(requests.filter(method => method === "initialize").length, 2, "ordinary 404 is not replayed");
  const hung = await call("tools/call", { name: "hang", arguments: {} });
  assert.match(hung.error.message, /timed out/, "timeout covers the response body, not just headers");
  assert((await call("tools/list", {})).result, "queue remains usable after a body timeout");
  generation++;
  failInitialize = true;
  assert((await call("tools/call", { name: "write", arguments: {} })).error);
  assert.equal(writes, 2, "failed initialization never dispatches the write");
  failInitialize = false;
  assert((await call("tools/call", { name: "write", arguments: {} })).result);
  assert.equal(writes, 3, "a later request can recover after failed initialization");
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "EOF cleans up after recovery");
  console.log("proxy recovery tests passed");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
