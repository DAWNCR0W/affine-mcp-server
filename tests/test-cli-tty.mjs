#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = process.env.AFFINE_CLI_TEST_ENTRY || path.join(ROOT, "dist", "index.js");
const PYTHON = existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
const PYTHON_PTY_HELPER = [
  "import os,pty,sys",
  "def master_read(fd):",
  "    data=os.read(fd,1024)",
  "    if not data:",
  "        raise OSError('PTY closed')",
  "    return data",
  "status=pty.spawn(sys.argv[1:],master_read=master_read)",
  "sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128+os.WTERMSIG(status))",
].join("\n");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "affine-mcp-cli-tty-"));

function expect(condition, message) {
  assert.ok(condition, message);
}

function cleanOutput(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r", "");
}

function promptMatches(pattern, output) {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(output);
  }
  return output.includes(pattern);
}

function runPty(args, env, steps, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ["-c", PYTHON_PTY_HELPER, process.execPath, ENTRY, ...args], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let promptError;
    const promptWaiters = [];
    const observations = [];
    const killTree = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const currentOutput = () => cleanOutput(`${stdout}${stderr}`);
    const append = (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      const output = currentOutput();
      for (let index = promptWaiters.length - 1; index >= 0; index -= 1) {
        if (promptMatches(promptWaiters[index].pattern, output)) {
          const waiter = promptWaiters.splice(index, 1)[0];
          waiter.resolve(output);
        }
      }
    };
    const waitForPrompt = (pattern) => {
      const output = currentOutput();
      if (promptMatches(pattern, output)) return Promise.resolve(output);
      return new Promise((resolvePrompt, rejectPrompt) => {
        promptWaiters.push({ pattern, resolve: resolvePrompt, reject: rejectPrompt });
      });
    };
    child.stdout.on("data", (chunk) => { append("stdout", chunk); });
    child.stderr.on("data", (chunk) => { append("stderr", chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      promptError = error;
      killTree();
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const error = promptError || new Error("PTY process closed before the expected prompt.");
      for (const waiter of promptWaiters.splice(0)) waiter.reject(error);
      resolve({
        code,
        signal,
        timedOut,
        output: currentOutput(),
        observations,
        promptError,
      });
    });
    (async () => {
      try {
        for (const step of steps) {
          const output = await waitForPrompt(step.prompt);
          if (step.waitMs) await new Promise((resolveWait) => setTimeout(resolveWait, step.waitMs));
          observations.push(step.beforeWrite ? step.beforeWrite(currentOutput(), output) : undefined);
          child.stdin.write(step.input);
        }
      } catch (error) {
        promptError = error;
        killTree();
      }
    })();
  });
}

function configPath(xdgConfigHome) {
  return path.join(xdgConfigHome, "affine-mcp", "config");
}

function testEnvironment(xdgConfigHome) {
  const env = { ...process.env, XDG_CONFIG_HOME: xdgConfigHome };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AFFINE_") || key === "MCP_TRANSPORT" || key === "PORT") delete env[key];
  }
  return {
    ...env,
    AFFINE_ALLOW_INSECURE_HTTP: "true",
    AFFINE_WS_CONNECT_TIMEOUT_MS: "50",
    TERM: "xterm-256color",
  };
}

if (process.platform === "win32") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "PTY regression requires a POSIX PTY helper." }));
  process.exit(0);
}

const workspaces = [
  { id: "workspace-one", createdAt: null, memberCount: null, owner: null },
  { id: "workspace-two", createdAt: null, memberCount: null, owner: null },
];
let signInPassword;

const upstream = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/auth/sign-in") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    signInPassword = body.password;
    if (signInPassword !== "2") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "PTY regression received the wrong password" }));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "affine_session=tty-cookie; Path=/",
    });
    response.end("{}");
    return;
  }
  if (request.method !== "POST" || request.url !== "/graphql") {
    response.writeHead(404);
    response.end();
    return;
  }
  for await (const _chunk of request) {}
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    data: {
      currentUser: { name: "TTY User", email: "tty@example.test" },
      workspaces,
    },
  }));
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});

const address = upstream.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const successHome = path.join(tempRoot, "success");
  const successEnv = testEnvironment(successHome);
  const login = await runPty(["login"], successEnv, [
    { prompt: /Affine URL \[/, input: `${baseUrl}\n` },
    { prompt: /Auth method .*Email\/password/, input: "1\n" },
    { prompt: /Email:/, input: "tty@example.test\n" },
    { prompt: /Password:/, input: "2\n" },
    {
      prompt: /Select a workspace \[1-2, q to cancel\]:/,
      waitMs: 100,
      beforeWrite: output => output.includes("Saved to"),
      input: "1\n",
    },
  ]);
  expect(!login.timedOut, `TTY login timed out; output:\n${login.output}`);
  expect(login.code === 0, `TTY login failed (code ${login.code}); output:\n${login.output}`);
  expect(login.promptError === undefined, `TTY login prompt flow failed: ${login.promptError?.message}`);
  expect(login.observations.at(-1) === false, `TTY login saved before explicit workspace selection; output:\n${login.output}`);
  expect(signInPassword === "2", `PTY mock received an unexpected password: ${String(signInPassword)}`);
  expect(!/Password:[^\r\n]*2/.test(login.output), `TTY password was echoed; output:\n${login.output}`);

  const savedConfig = readFileSync(configPath(successHome), "utf8");
  expect(savedConfig.includes("AFFINE_WORKSPACE_ID=workspace-one"), "TTY login did not save the explicit workspace selection");
  expect(!savedConfig.includes("AFFINE_PASSWORD=2"), "TTY login persisted the password");

  const cancelHome = path.join(tempRoot, "cancel");
  mkdirSync(path.dirname(configPath(cancelHome)), { recursive: true });
  copyFileSync(configPath(successHome), configPath(cancelHome));
  const cancelBefore = readFileSync(configPath(cancelHome), "utf8");

  const eof = await runPty(["login"], testEnvironment(cancelHome), [
    { prompt: /Overwrite\? \[y\/N\]/, input: "\u0004" },
  ]);
  expect(!eof.timedOut && eof.code !== 0, `TTY Ctrl-D should fail cleanly; output:\n${eof.output}`);
  expect(eof.output.includes("Input ended"), `TTY Ctrl-D message was unclear; output:\n${eof.output}`);
  expect(readFileSync(configPath(cancelHome), "utf8") === cancelBefore, "TTY Ctrl-D changed saved config");

  const interrupt = await runPty(["login"], testEnvironment(cancelHome), [
    { prompt: /Overwrite\? \[y\/N\]/, input: "\u0003" },
  ]);
  expect(!interrupt.timedOut && interrupt.code !== 0, `TTY Ctrl-C should fail cleanly; output:\n${interrupt.output}`);
  expect(interrupt.output.includes("Aborted"), `TTY Ctrl-C message was unclear; output:\n${interrupt.output}`);
  expect(readFileSync(configPath(cancelHome), "utf8") === cancelBefore, "TTY Ctrl-C changed saved config");

  console.log(JSON.stringify({
    ok: true,
    cases: [
      "TTY login drives visible and hidden prompts without losing input",
      "numeric password does not select a workspace",
      "TTY Ctrl-D and Ctrl-C preserve saved config",
    ],
  }, null, 2));
} finally {
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
}
