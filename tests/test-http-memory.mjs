#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";

// Test-only preload: measure the actual HTTP server after full garbage collection.
if (process.env.AFFINE_HTTP_MEMORY_PROBE === "1") {
  process.on("message", async () => {
    global.gc();
    await delay(20);
    global.gc();
    process.send({
      heapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
      rssMiB: process.memoryUsage().rss / 1024 ** 2,
      metadataSchemas: z.globalRegistry._map.size,
    });
  });
} else {
  await main();
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const configDir = await mkdtemp(path.join(tmpdir(), "affine-http-memory-"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AFFINE_") || key === "NODE_OPTIONS") delete env[key];
  }
  Object.assign(env, {
    AFFINE_HTTP_MEMORY_PROBE: "1",
    AFFINE_BASE_URL: "http://127.0.0.1:1",
    AFFINE_API_TOKEN: "unused-local-backend-token",
    AFFINE_MCP_AUTH_MODE: "bearer",
    AFFINE_MCP_HTTP_HOST: "127.0.0.1",
    AFFINE_MCP_HTTP_TOKEN: "local-memory-test",
    AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "1000",
    XDG_CONFIG_HOME: configDir,
    MCP_TRANSPORT: "http",
    PORT: String(port),
  });
  const child = spawn(process.execPath, [
    "--expose-gc", "--max-old-space-size=768", "--import", import.meta.url,
    path.join(root, "dist/index.js"),
  ], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let logs = "";
  child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-8000); });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer local-memory-test",
  };
  const url = `http://127.0.0.1:${port}`;
  let id = 0;
  async function request(body, session, method = "POST") {
    const response = await fetch(`${url}/mcp`, {
      method, headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
      ...(body ? { body: JSON.stringify({ jsonrpc: "2.0", id: ++id, ...body }) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    const data = raw.startsWith("event:") || raw.startsWith("data:")
      ? raw.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim()
      : raw;
    return { response, result: data ? JSON.parse(data) : null };
  }
  async function session(mode) {
    const initialized = await request({ method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "memory-regression", version: "1.0.0" },
    } });
    assert.equal(initialized.response.status, 200, logs);
    const sid = initialized.response.headers.get("mcp-session-id");
    assert.ok(sid);
    const notified = await request({ id: undefined, method: "notifications/initialized" }, sid);
    assert.equal(notified.response.status, 202);
    const listed = await request({ method: "tools/list" }, sid);
    assert.ok(listed.result?.result?.tools.some(tool => tool.name === "get_capabilities"));
    const called = await request({ method: "tools/call", params: { name: "get_capabilities", arguments: {} } }, sid);
    assert.equal(called.result?.result?.isError, undefined);
    assert.ok(called.result?.result?.structuredContent?.server);
    if (mode === "delete") assert.equal((await request(null, sid, "DELETE")).response.status, 200);
    return sid;
  }
  async function sample(label) {
    const pending = once(child, "message", { signal: AbortSignal.timeout(10_000) });
    child.send("sample");
    const [metrics] = await pending;
    console.log(JSON.stringify({ label, ...metrics }));
    return metrics;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(child.exitCode, null, logs);
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for the isolated listener. */ }
      await delay(100);
    }
    assert.ok(ready, logs);
    for (let warmup = 0; warmup < 4; warmup++) await session("delete");
    await delay(100);
    const baseline = await sample("warmup");
    for (const mode of ["delete", "idle"]) {
      for (let batch = 0; batch < 3; batch++) {
        const sessions = [];
        for (let i = 0; i < 4; i++) sessions.push(await session(mode));
        await delay(mode === "idle" ? 1500 : 100);
        for (const sid of sessions) {
          assert.equal((await request({ method: "ping" }, sid)).response.status, 404, `${mode} must remove the session`);
        }
        const current = await sample(`${mode}-${batch + 1}`);
        assert.equal(current.metadataSchemas, baseline.metadataSchemas, `${mode}: session churn retained output schemas`);
        assert.ok(current.heapMiB < baseline.heapMiB + 20, `${mode}: collected heap grew by >=20 MiB`);
      }
    }
    console.log("HTTP memory regression passed (28 sessions, explicit deletion and idle expiry).");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(configDir, { recursive: true, force: true });
  }
}
