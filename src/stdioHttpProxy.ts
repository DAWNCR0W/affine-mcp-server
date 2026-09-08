import { createInterface } from "node:readline";
import process from "node:process";
import { fetchResponseBody } from "./util/httpResponse.js";

const DEFAULT_ENDPOINT = `http://127.0.0.1:${process.env.PORT || "3000"}/mcp`;
const REQUEST_TIMEOUT_MS = Number(process.env.AFFINE_MCP_HTTP_PROXY_TIMEOUT_MS || 60_000);
const CLOSE_TIMEOUT_MS = 5_000;
const SIGNAL_SHUTDOWN_TIMEOUT_MS = CLOSE_TIMEOUT_MS;

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
  id?: JsonRpcId;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
};

function requireHttpToken(): string {
  const token = process.env.AFFINE_MCP_HTTP_TOKEN?.trim();
  if (!token) {
    throw new Error("AFFINE_MCP_HTTP_TOKEN is required for the stdio HTTP proxy");
  }
  return token;
}

function loadEndpoint(): string {
  const raw = process.env.AFFINE_MCP_HTTP_PROXY_URL || DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AFFINE_MCP_HTTP_PROXY_URL must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AFFINE_MCP_HTTP_PROXY_URL must use http or https");
  }
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname)) {
    throw new Error("AFFINE_MCP_HTTP_PROXY_URL must target a loopback listener");
  }
  return url.toString();
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function shutdownDeadline(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SIGNAL_SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
}

function protocolError(id: JsonRpcId | undefined, message: string): void {
  if (id === undefined) return;
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message },
  });
}

function parseJsonRpcMessages(body: string, contentType: string): unknown[] {
  if (!body.trim()) return [];
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const messages: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  return messages;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: string }> {
  return fetchResponseBody(
    signal => fetch(input, { ...init, signal }),
    { label: "MCP HTTP request", timeoutMs },
  );
}

class StdioHttpProxy {
  private sessionId: string | undefined;
  private initializeMessage: JsonRpcMessage | undefined;
  private closing = false;
  private queue = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  forward(message: JsonRpcMessage): void {
    if (this.closing) {
      protocolError(message.id, "MCP stdio proxy is closing");
      return;
    }
    this.queue = this.queue
      .then(() => this.forwardOne(message))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : "MCP HTTP proxy request failed";
        protocolError(message.id, detail);
      });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.queue;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    if (!sessionId) return;

    try {
      await fetchWithTimeout(
        this.endpoint,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "mcp-session-id": sessionId,
          },
        },
        CLOSE_TIMEOUT_MS,
      );
    } catch {
      // The parent stdio process is already closing; the server idle timeout is
      // the fallback if its session DELETE cannot be delivered.
    }
  }

  private async exchange(message: JsonRpcMessage) {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return fetchWithTimeout(this.endpoint, {
      method: "POST", headers, body: JSON.stringify(message),
    }, REQUEST_TIMEOUT_MS);
  }

  private async restoreSession(): Promise<void> {
    this.sessionId = undefined;
    if (!this.initializeMessage) throw new Error("MCP session is not initialized");
    await this.forwardOne(this.initializeMessage, false, false);
    const { response } = await this.exchange({
      jsonrpc: "2.0", method: "notifications/initialized",
    });
    if (!response.ok) {
      this.sessionId = undefined;
      throw new Error(`MCP reinitialization failed with status ${response.status}`);
    }
  }

  private async forwardOne(message: JsonRpcMessage, emit = true, recover = true): Promise<void> {
    const isInitialize = message.method === "initialize";
    if (isInitialize && this.sessionId) {
      throw new Error("MCP session is already initialized");
    }
    if (!isInitialize && !this.sessionId) {
      await this.restoreSession();
    }
    const { response, body: responseBody } = await this.exchange(message);
    // This listener rejects unknown session IDs before dispatching the tool.
    // Only that explicit rejection is safe to replay, including for writes.
    // Network failures/timeouts are ambiguous and must never replay a write.
    let sessionMissing = false;
    if (response.status === 404) {
      try { sessionMissing = JSON.parse(responseBody)?.error?.code === -32001; } catch { /* not an MCP session rejection */ }
    }
    if (sessionMissing && !isInitialize && recover) {
      await this.restoreSession();
      return this.forwardOne(message, emit, false);
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP request failed with status ${response.status}`);
    }

    const messages = parseJsonRpcMessages(responseBody, response.headers.get("content-type") || "");
    if (isInitialize) {
      const result = messages.find((value: any) => value?.id === message.id) as any;
      if (!result?.result || result.error) throw new Error("MCP initialization did not succeed");
      const sessionId = response.headers.get("mcp-session-id");
      if (!sessionId) throw new Error("MCP initialize response did not include mcp-session-id");
      this.sessionId = sessionId;
      this.initializeMessage = message;
    }
    if (emit) {
      for (const responseMessage of messages) writeMessage(responseMessage);
    }
  }
}

async function main(): Promise<void> {
  if (!Number.isSafeInteger(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 100 || REQUEST_TIMEOUT_MS > 300_000) {
    throw new Error("AFFINE_MCP_HTTP_PROXY_TIMEOUT_MS must be an integer between 100 and 300000");
  }
  const proxy = new StdioHttpProxy(loadEndpoint(), requireHttpToken());
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) closing = proxy.close();
    return closing;
  };

  input.on("line", (line) => {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("MCP stdio message must be a JSON object");
      }
      message = parsed as JsonRpcMessage;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid JSON";
      protocolError(undefined, detail);
      return;
    }
    proxy.forward(message);
  });

  input.once("close", () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      input.close();
      void Promise.race([close().catch(() => undefined), shutdownDeadline()]).finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    });
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : "stdio HTTP proxy failed";
  console.error(`[affine-mcp] ${detail}`);
  process.exitCode = 1;
});
