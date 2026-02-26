import { randomUUID } from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export async function startHttpMcpServer(
  createMcpServer: () => Promise<McpServer>,
  port: number,
) {
  // --- HTTP host binding ---
  // AFFINE_MCP_HTTP_HOST: network interface to bind (default: "127.0.0.1" — loopback only).
  // Set to "0.0.0.0" for Docker / remote deployments (Render, Railway, etc.).
  const host = (process.env.AFFINE_MCP_HTTP_HOST || "127.0.0.1").trim();

  // --- Bearer Token guard (AFFINE_MCP_HTTP_TOKEN) ---
  // When set, all requests to /mcp, /sse and /messages must include:
  //   Authorization: Bearer <token>   OR   ?token=<token> (fallback for limited clients)
  // When the server is bound to 0.0.0.0 without a token, a startup warning is emitted.
  const httpAuthToken = process.env.AFFINE_MCP_HTTP_TOKEN?.trim();
  if (!httpAuthToken && host === "0.0.0.0") {
    console.warn(
      "[affine-mcp] WARNING: HTTP MCP server is bound to 0.0.0.0 without AFFINE_MCP_HTTP_TOKEN. " +
        "The endpoint is unprotected. Set AFFINE_MCP_HTTP_TOKEN for public deployments.",
    );
  }

  // Use a plain Express app here so it can fully control JSON parser ordering/limits.
  // `createMcpExpressApp()` installs its own JSON parser first, which can enforce
  // a smaller default limit before the intended 50mb parser runs on /mcp.
  const app = express();
  const jsonBody = express.json({ limit: "50mb" });

  // --- CORS origin allowlist ---
  // AFFINE_MCP_HTTP_ALLOWED_ORIGINS: comma-separated list, e.g. "https://app.example.com,http://localhost:3000".
  // AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS=true: explicit opt-in to allow any origin (use with caution).
  // Default (no env set): only loopback addresses (localhost / 127.0.0.1 / ::1) are allowed.
  //
  // CORS is applied per-route (/mcp, /sse, /messages) — not globally — to minimise attack surface.
  const allowAnyOrigin =
    process.env.AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS === "true";
  const allowedOrigins = (process.env.AFFINE_MCP_HTTP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

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
      if (allowAnyOrigin) return callback(null, true);
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

  // Validates the Bearer token on all non-preflight requests.
  // The auth scheme match is case-insensitive for client compatibility.
  // OPTIONS is allowed through so CORS preflight can complete before auth is checked.
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    if (!httpAuthToken) return next();

    const authHeader = req.headers["authorization"];
    const queryToken =
      typeof req.query.token === "string" ? req.query.token : undefined;
    let token: string | undefined;

    if (authHeader !== undefined) {
      // Normalize string | string[] to string (HTTP spec allows duplicate headers).
      const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const bearerMatch = /^Bearer\s+(.+)$/i.exec(raw);
      if (bearerMatch) {
        token = bearerMatch[1];
      } else {
        // Strictly reject non-Bearer schemes to avoid accidentally accepting Basic / Digest.
        console.warn(
          "[affine-mcp] Authorization header is not Bearer scheme. " +
            "Expected: 'Authorization: Bearer <token>'.",
        );
        res
          .status(401)
          .send("Unauthorized: Use 'Authorization: Bearer <token>'");
        return;
      }
    } else if (queryToken !== undefined) {
      token = queryToken;
    }

    if (token !== httpAuthToken) {
      res.status(401).send("Unauthorized: Invalid or missing token");
      return;
    }
    next();
  };

  // Explicit preflight handlers for the legacy SSE routes.
  app.options("/sse", corsMiddleware);
  app.options("/messages", corsMiddleware);

  const transports: Record<
    string,
    StreamableHTTPServerTransport | SSEServerTransport
  > = {};

  // ===========================================================================
  // STREAMABLE HTTP TRANSPORT — MCP protocol 2025-03-26
  // Single endpoint /mcp (GET / POST / DELETE) replaces the old two-endpoint SSE
  // pattern. Use this for all new integrations.
  // ===========================================================================
  app.all("/mcp", corsMiddleware, authMiddleware, async (req, res) => {
    console.error(`[affine-mcp] Received ${req.method} request to /mcp`);
    try {
      // mcp-session-id header can technically be string | string[]; normalise.
      const sidHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;

      let transport: StreamableHTTPServerTransport;
      const existing = sessionId ? transports[sessionId] : undefined;

      if (existing instanceof StreamableHTTPServerTransport) {
        transport = existing;
      } else if (!sessionId && req.method === "POST") {
        // Parse body only for the initialize POST (lazy — avoids consuming the stream early).
        await new Promise<void>((resolve, reject) => {
          jsonBody(req, res, (err) => (err ? reject(err) : resolve()));
        });

        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Not an initialize request",
            },
            id: null,
          });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            console.error(
              `[affine-mcp] StreamableHTTP session initialized: ${sid}`,
            );
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            console.error(`[affine-mcp] StreamableHTTP session closed: ${sid}`);
            delete transports[sid];
          }
        };

        const server = await createMcpServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Bad Request: No valid session ID or not an initialize request",
          },
          id: null,
        });
        return;
      }

      // Ensure JSON body is available for subsequent POST requests within the session.
      if (req.method === "POST" && req.body === undefined) {
        await new Promise<void>((resolve, reject) => {
          jsonBody(req, res, (err) => (err ? reject(err) : resolve()));
        });
      }

      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[affine-mcp] Error handling /mcp request:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // ===========================================================================
  // LEGACY HTTP+SSE TRANSPORT — MCP protocol 2024-11-05
  // Kept for backward compatibility with older MCP clients that have not yet
  // migrated to the Streamable HTTP transport above.
  // @deprecated — SSEServerTransport is deprecated by the SDK; use /mcp for new clients.
  // ===========================================================================
  app.get("/sse", corsMiddleware, authMiddleware, async (req, res) => {
    try {
      // @ts-ignore — intentional: SSEServerTransport retained for backward compat only
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      transports[sessionId] = transport;

      res.on("close", () => {
        console.error(`[affine-mcp] Legacy SSE session closed: ${sessionId}`);
        delete transports[sessionId];
      });

      const server = await createMcpServer();
      await server.connect(transport);
      console.error(
        `[affine-mcp] Legacy SSE session established: ${sessionId}`,
      );
    } catch (e) {
      console.error("[affine-mcp] Error establishing legacy SSE stream:", e);
      if (!res.headersSent)
        res.status(500).send("Error establishing SSE stream");
    }
  });

  app.post(
    "/messages",
    corsMiddleware,
    authMiddleware,
    jsonBody,
    async (req, res) => {
      const sessionId =
        typeof req.query.sessionId === "string"
          ? req.query.sessionId
          : undefined;
      if (!sessionId) {
        res.status(400).send("Missing sessionId parameter");
        return;
      }

      const transport = transports[sessionId];
      if (!(transport instanceof SSEServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Session uses a different transport protocol",
          },
          id: null,
        });
        return;
      }

      try {
        // @ts-ignore — intentional: SSEServerTransport retained for backward compat only
        await transport.handlePostMessage(req, res, req.body);
      } catch (e) {
        console.error("[affine-mcp] Error handling legacy SSE message:", e);
        if (!res.headersSent)
          res.status(500).send("Error handling POST message");
      }
    },
  );

  const server = app.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.error(`[affine-mcp] MCP server listening on ${host}:${port}`);
    console.error(
      `[affine-mcp] Streamable HTTP (2025-03-26): http://${displayHost}:${port}/mcp`,
    );
    console.error(
      `[affine-mcp] Legacy SSE     (2024-11-05): http://${displayHost}:${port}/sse`,
    );
  });

  // Graceful shutdown: stop accepting new connections, then close active transports.
  const shutdown = async (signal: string) => {
    console.error(`[affine-mcp] ${signal} received - shutting down gracefully`);
    server.close(() => {
      void (async () => {
        for (const sessionId in transports) {
          try {
            await transports[sessionId].close();
          } catch {}
          delete transports[sessionId];
        }
        process.exit(0);
      })();
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
