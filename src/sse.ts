import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "./config.js";
import { registerHttpDiagnosticsRoutes } from "./httpDiagnostics.js";
import { createHttpAuthState, registerHttpAuthRoutes } from "./httpAuth.js";
import {
  isLoopbackHostname,
  parseBooleanFlag,
} from "./networkSecurity.js";
import {
  loadHttpRuntimeConfig,
  type HttpRuntimeConfig,
} from "./httpRuntimeConfig.js";

type HttpTransport = StreamableHTTPServerTransport | SSEServerTransport;

type TrackedSession = {
  activeRequests: number;
  kind: "streamable" | "legacy-sse";
  lastActivityAt: number;
  transport: HttpTransport;
};

export type HttpMcpServerHandle = {
  close: (reason?: string) => Promise<void>;
  host: string;
  port: number;
  sessionCount: () => number;
};

type BodyParserError = Error & {
  status?: number;
  type?: string;
};

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

async function listen(app: express.Express, port: number, host: string): Promise<HttpServer> {
  return await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

export async function startHttpMcpServer(
  createMcpServer: () => Promise<McpServer>,
  config: ServerConfig,
): Promise<HttpMcpServerHandle> {
  const runtimeConfig: HttpRuntimeConfig = loadHttpRuntimeConfig();
  const { host, port, authToken: httpAuthToken, allowedOrigins, allowAllOrigins } = config.http;

  // --- Bearer Token guard (AFFINE_MCP_HTTP_TOKEN) ---
  // When set, all requests to /mcp, /sse and /messages must include:
  //   Authorization: Bearer <token>
  // Query-string token authentication is disabled unless explicitly enabled for legacy clients.
  const allowUnauthenticated = parseBooleanFlag(
    "AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED",
    process.env.AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED,
  );
  const allowQueryToken = parseBooleanFlag(
    "AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN",
    process.env.AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN,
  );

  if (config.authMode === "oauth" && allowUnauthenticated) {
    throw new Error(
      "AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED is not valid when AFFINE_MCP_AUTH_MODE=oauth.",
    );
  }
  if (config.authMode === "oauth" && allowQueryToken) {
    throw new Error(
      "AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN is not valid when AFFINE_MCP_AUTH_MODE=oauth.",
    );
  }

  const remoteBind = !isLoopbackHostname(host);
  if (
    config.authMode === "bearer" &&
    remoteBind &&
    !httpAuthToken &&
    !allowUnauthenticated
  ) {
    throw new Error(
      `Refusing to bind the HTTP MCP server to non-loopback host "${host}" without authentication. ` +
        "Set AFFINE_MCP_HTTP_TOKEN, use OAuth, or explicitly set " +
        "AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED=true only for a trusted private network.",
    );
  }
  if (config.authMode === "bearer" && remoteBind && !httpAuthToken) {
    console.warn(
      `[affine-mcp] WARNING: HTTP MCP server is bound to non-loopback host "${host}" without authentication ` +
        "because AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED=true. Do not expose this listener to an untrusted network.",
    );
  }
  if (config.authMode === "bearer" && allowQueryToken) {
    console.warn(
      "[affine-mcp] WARNING: Query-string bearer tokens are enabled by " +
        "AFFINE_MCP_HTTP_ALLOW_QUERY_TOKEN=true. This legacy mode can leak credentials through URLs and logs.",
    );
  }

  // Use a plain Express app here so it can fully control JSON parser ordering/limits.
  // `createMcpExpressApp()` installs its own JSON parser before route-specific policy.
  const app = express();
  const jsonBody = express.json({ limit: runtimeConfig.bodyLimitBytes });

  const parseJsonBody = async (req: Request, res: Response): Promise<boolean> => {
    try {
      await new Promise<void>((resolve, reject) => {
        jsonBody(req, res, (error) => (error ? reject(error) : resolve()));
      });
      return true;
    } catch (error) {
      const parserError = error as BodyParserError;
      if (parserError.status === 413 || parserError.type === "entity.too.large") {
        sendJsonRpcError(res, 413, -32001, "Request body exceeds the configured HTTP body limit");
        return false;
      }
      if (
        parserError.status === 400 ||
        parserError.type === "entity.parse.failed" ||
        error instanceof SyntaxError
      ) {
        sendJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON request body");
        return false;
      }
      throw error;
    }
  };

  // --- CORS origin allowlist ---
  // AFFINE_MCP_HTTP_ALLOWED_ORIGINS: comma-separated list, e.g. "https://app.example.com,http://localhost:3000".
  // AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS=true: explicit opt-in to allow any origin (use with caution).
  // Default (no env set): only loopback addresses (localhost / 127.0.0.1 / ::1) are allowed.
  //
  // CORS is applied per-route (/mcp, /sse, /messages) — not globally — to minimise attack surface.
  // Returns true if origin is a loopback address (http or https, any port).
  const isLoopbackOrigin = (origin: string): boolean => {
    try {
      const { protocol, hostname } = new URL(origin);
      if (protocol !== "http:" && protocol !== "https:") return false;
      return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1"
      );
    } catch {
      return false;
    }
  };

  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      // Non-browser clients (curl, MCP Inspector, server-to-server) send no Origin header.
      // CORS is a browser mechanism only; the token guard covers programmatic access.
      if (!origin) return callback(null, true);
      if (allowAllOrigins) return callback(null, true);
      const allowed =
        allowedOrigins.length > 0
          ? allowedOrigins.includes(origin)
          : isLoopbackOrigin(origin);
      return allowed
        ? callback(null, true)
        : callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
    exposedHeaders: ["mcp-session-id"],
  };

  // Wraps cors() to return an explicit 403 on rejected origins (rather than silently
  // withholding CORS headers, which still lets the request reach the handler).
  const corsMiddleware = (req: Request, res: Response, next: NextFunction) => {
    cors(corsOptions)(req, res, (err) => {
      if (err) {
        if (!res.headersSent)
          res.status(403).send("Forbidden: Origin not allowed");
        return;
      }
      if (res.headersSent || res.writableEnded) return;
      next();
    });
  };

  const authState = createHttpAuthState(config, {
    allowAnyOrigin: allowAllOrigins,
    allowQueryToken,
    httpAuthToken,
  });

  // Validates the Bearer token on all non-preflight requests.
  // The auth scheme match is case-insensitive for client compatibility.
  // OPTIONS is allowed through so CORS preflight can complete before auth is checked.
  const { authMiddleware } = authState;
  registerHttpAuthRoutes(app, authState, corsMiddleware);
  registerHttpDiagnosticsRoutes(app, config, authState, corsMiddleware);

  // Explicit preflight handlers for the legacy SSE routes.
  app.options("/sse", corsMiddleware);
  app.options("/messages", corsMiddleware);

  const sessions = new Map<string, TrackedSession>();
  let pendingSessionCount = 0;
  let shutdownPromise: Promise<void> | null = null;
  let idleSweepTimer: NodeJS.Timeout | undefined;

  const hasSessionCapacity = () =>
    sessions.size + pendingSessionCount < runtimeConfig.maxSessions;

  const rejectUnavailable = (res: Response, message: string) => {
    res.set("Retry-After", "1");
    sendJsonRpcError(res, 503, -32002, message);
  };

  const reserveSessionSlot = (): (() => void) | null => {
    if (!hasSessionCapacity()) return null;
    pendingSessionCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingSessionCount = Math.max(0, pendingSessionCount - 1);
    };
  };

  const registerSession = (
    sessionId: string,
    transport: HttpTransport,
    kind: TrackedSession["kind"],
  ) => {
    sessions.set(sessionId, {
      activeRequests: 0,
      kind,
      lastActivityAt: Date.now(),
      transport,
    });
  };

  const removeSession = (sessionId: string, transport: HttpTransport) => {
    const current = sessions.get(sessionId);
    if (current?.transport === transport) sessions.delete(sessionId);
  };

  const beginSessionRequest = (sessionId: string, method: string) => {
    const session = sessions.get(sessionId);
    if (!session) return () => {};
    session.lastActivityAt = Date.now();
    const tracksInFlightWork = method !== "GET";
    if (tracksInFlightWork) session.activeRequests += 1;

    return () => {
      const current = sessions.get(sessionId);
      if (!current || current.transport !== session.transport) return;
      if (tracksInFlightWork) {
        current.activeRequests = Math.max(0, current.activeRequests - 1);
      }
      current.lastActivityAt = Date.now();
    };
  };

  const closeSession = async (sessionId: string, reason: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    console.error(`[affine-mcp] Closing ${session.kind} session ${sessionId}: ${reason}`);
    try {
      await session.transport.close();
    } catch (error) {
      console.error(`[affine-mcp] Failed to close session ${sessionId}:`, error);
    }
  };

  const sweepIdleSessions = async () => {
    const cutoff = Date.now() - runtimeConfig.sessionIdleTimeoutMs;
    const expired = [...sessions.entries()]
      .filter(([, session]) =>
        session.activeRequests === 0 && session.lastActivityAt <= cutoff
      )
      .map(([sessionId]) => sessionId);
    await Promise.all(expired.map((sessionId) => closeSession(sessionId, "idle timeout")));
  };

  // ===========================================================================
  // STREAMABLE HTTP TRANSPORT — MCP protocol 2025-03-26
  // Single endpoint /mcp (GET / POST / DELETE) replaces the old two-endpoint SSE
  // pattern. Use this for all new integrations.
  // ===========================================================================
  app.all("/mcp", corsMiddleware, authMiddleware, async (req, res) => {
    console.error(`[affine-mcp] Received ${req.method} request to /mcp`);
    let newTransport: StreamableHTTPServerTransport | undefined;
    let releaseReservation: (() => void) | undefined;
    let initializedSessionId: string | undefined;
    let endSessionRequest: (() => void) | undefined;
    try {
      if (shutdownPromise) {
        rejectUnavailable(res, "Server is shutting down");
        return;
      }

      // mcp-session-id header can technically be string | string[]; normalise.
      const sidHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;

      let transport: StreamableHTTPServerTransport;
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (existing?.transport instanceof StreamableHTTPServerTransport) {
        transport = existing.transport;
        endSessionRequest = beginSessionRequest(sessionId!, req.method);
      } else if (!sessionId && req.method === "POST") {
        // Parse body only for the initialize POST (lazy — avoids consuming the stream early).
        if (!(await parseJsonBody(req, res))) return;

        if (!isInitializeRequest(req.body)) {
          sendJsonRpcError(res, 400, -32000, "Bad Request: Not an initialize request");
          return;
        }

        releaseReservation = reserveSessionSlot() || undefined;
        if (!releaseReservation) {
          rejectUnavailable(res, "Server busy: maximum HTTP MCP session capacity reached");
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            initializedSessionId = sid;
            releaseReservation?.();
            console.error(
              `[affine-mcp] StreamableHTTP session initialized: ${sid}`,
            );
            registerSession(sid, transport, "streamable");
            endSessionRequest = beginSessionRequest(sid, req.method);
          },
        });
        newTransport = transport;

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            console.error(`[affine-mcp] StreamableHTTP session closed: ${sid}`);
            removeSession(sid, transport);
          }
        };

        const mcpServer = await createMcpServer();
        await mcpServer.connect(transport);
      } else {
        sendJsonRpcError(
          res,
          400,
          -32000,
          "Bad Request: No valid session ID or not an initialize request",
        );
        return;
      }

      // Ensure JSON body is available for subsequent POST requests within the session.
      if (req.method === "POST" && req.body === undefined) {
        if (!(await parseJsonBody(req, res))) return;
      }

      await transport.handleRequest(req, res, req.body);
      if (newTransport && !initializedSessionId) {
        releaseReservation?.();
        await newTransport.close();
      }
    } catch (e) {
      releaseReservation?.();
      if (newTransport && !initializedSessionId) {
        try {
          await newTransport.close();
        } catch {}
      }
      console.error("[affine-mcp] Error handling /mcp request:", e);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    } finally {
      endSessionRequest?.();
      releaseReservation?.();
    }
  });

  // ===========================================================================
  // LEGACY HTTP+SSE TRANSPORT — MCP protocol 2024-11-05
  // Kept for backward compatibility with older MCP clients that have not yet
  // migrated to the Streamable HTTP transport above.
  // @deprecated — SSEServerTransport is deprecated by the SDK; use /mcp for new clients.
  // ===========================================================================
  app.get("/sse", corsMiddleware, authMiddleware, async (req, res) => {
    let transport: SSEServerTransport | undefined;
    try {
      if (shutdownPromise) {
        rejectUnavailable(res, "Server is shutting down");
        return;
      }
      if (!hasSessionCapacity()) {
        rejectUnavailable(res, "Server busy: maximum HTTP MCP session capacity reached");
        return;
      }

      // @ts-ignore — intentional: SSEServerTransport retained for backward compat only
      transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      registerSession(sessionId, transport, "legacy-sse");

      res.on("close", () => {
        console.error(`[affine-mcp] Legacy SSE session closed: ${sessionId}`);
        removeSession(sessionId, transport!);
      });

      const mcpServer = await createMcpServer();
      await mcpServer.connect(transport);
      console.error(
        `[affine-mcp] Legacy SSE session established: ${sessionId}`,
      );
    } catch (e) {
      if (transport) {
        removeSession(transport.sessionId, transport);
        try {
          await transport.close();
        } catch {}
      }
      console.error("[affine-mcp] Error establishing legacy SSE stream:", e);
      if (!res.headersSent)
        res.status(500).send("Error establishing SSE stream");
    }
  });

  app.post(
    "/messages",
    corsMiddleware,
    authMiddleware,
    async (req, res) => {
      if (shutdownPromise) {
        rejectUnavailable(res, "Server is shutting down");
        return;
      }
      if (!(await parseJsonBody(req, res))) return;

      const sessionId =
        typeof req.query.sessionId === "string"
          ? req.query.sessionId
          : undefined;
      if (!sessionId) {
        res.status(400).send("Missing sessionId parameter");
        return;
      }

      const session = sessions.get(sessionId);
      if (!(session?.transport instanceof SSEServerTransport)) {
        sendJsonRpcError(
          res,
          400,
          -32000,
          "Bad Request: Session uses a different transport protocol",
        );
        return;
      }
      const endSessionRequest = beginSessionRequest(sessionId, req.method);

      try {
        // @ts-ignore — intentional: SSEServerTransport retained for backward compat only
        await session.transport.handlePostMessage(req, res, req.body);
      } catch (e) {
        console.error("[affine-mcp] Error handling legacy SSE message:", e);
        if (!res.headersSent)
          res.status(500).send("Error handling POST message");
      } finally {
        endSessionRequest();
      }
    },
  );

  const server = await listen(app, port, host);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.closeAllConnections?.();
    throw new Error("HTTP MCP server did not expose a TCP listening address");
  }
  const boundPort = address.port;
  const displayHost = host === "0.0.0.0"
    ? "localhost"
    : host.includes(":") && !host.startsWith("[")
      ? `[${host}]`
      : host;

  console.error(`[affine-mcp] MCP server listening on ${host}:${boundPort}`);
  console.error(
    `[affine-mcp] Streamable HTTP (2025-03-26): http://${displayHost}:${boundPort}/mcp`,
  );
  console.error(
    `[affine-mcp] Legacy SSE     (2024-11-05): http://${displayHost}:${boundPort}/sse`,
  );
  console.error(`[affine-mcp] Diagnostics: http://${displayHost}:${boundPort}/healthz`);
  console.error(`[affine-mcp] Readiness:   http://${displayHost}:${boundPort}/readyz`);
  console.error(
    `[affine-mcp] HTTP runtime limits: body=${runtimeConfig.bodyLimitBytes} bytes, ` +
      `sessions=${runtimeConfig.maxSessions}, idle=${runtimeConfig.sessionIdleTimeoutMs}ms, ` +
      `shutdown=${runtimeConfig.shutdownTimeoutMs}ms`,
  );
  if (authState.protectedResourceMetadataUrl) {
    console.error(`[affine-mcp] Protected resource metadata: ${authState.protectedResourceMetadataUrl}`);
  }

  idleSweepTimer = setInterval(() => {
    void sweepIdleSessions().catch((error) => {
      console.error("[affine-mcp] Idle session cleanup failed:", error);
    });
  }, runtimeConfig.sessionSweepIntervalMs);
  idleSweepTimer.unref();

  let sigintHandler: (() => void) | undefined;
  let sigtermHandler: (() => void) | undefined;

  const removeSignalHandlers = () => {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    if (sigtermHandler) process.off("SIGTERM", sigtermHandler);
  };

  const performShutdown = async (reason: string) => {
    console.error(`[affine-mcp] ${reason} received - shutting down gracefully`);
    if (idleSweepTimer) {
      clearInterval(idleSweepTimer);
      idleSweepTimer = undefined;
    }
    pendingSessionCount = 0;

    const closeSessionsPromise = Promise.all(
      [...sessions.keys()].map((sessionId) => closeSession(sessionId, "server shutdown")),
    ).then(() => undefined);
    const closeServerPromise = closeHttpServer(server);
    const gracefulClose = Promise.all([closeSessionsPromise, closeServerPromise]).then(() => undefined);

    const outcome = await Promise.race([
      gracefulClose.then(
        () => ({ completed: true as const }),
        (error) => ({ completed: true as const, error }),
      ),
      delay(runtimeConfig.shutdownTimeoutMs, undefined, { ref: false }).then(
        () => ({ completed: false as const }),
      ),
    ]);

    if (!outcome.completed) {
      console.error(
        `[affine-mcp] Graceful shutdown exceeded ${runtimeConfig.shutdownTimeoutMs}ms; forcing remaining HTTP connections closed`,
      );
      server.closeAllConnections?.();
      void gracefulClose.catch((error) => {
        console.error("[affine-mcp] Shutdown cleanup failed after the deadline:", error);
      });
      await delay(25);
      return;
    }
    if ("error" in outcome) throw outcome.error;
  };

  const shutdown = (reason = "Manual shutdown"): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = performShutdown(reason).finally(removeSignalHandlers);
    }
    return shutdownPromise;
  };

  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    void shutdown(signal)
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error) => {
        console.error("[affine-mcp] Graceful shutdown failed:", error);
        server.closeAllConnections?.();
        process.exitCode = 1;
      });
  };
  sigintHandler = () => handleSignal("SIGINT");
  sigtermHandler = () => handleSignal("SIGTERM");
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  return {
    close: shutdown,
    host,
    port: boundPort,
    sessionCount: () => sessions.size,
  };
}
