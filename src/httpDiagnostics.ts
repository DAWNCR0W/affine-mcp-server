import type express from "express";
import type { NextFunction, Request, Response } from "express";
import { fetch } from "undici";

import { VERSION, type ServerConfig } from "./config.js";
import type { HttpAuthState } from "./httpAuth.js";
import { getOAuthResourceUrl, probeOAuthReadiness } from "./oauth.js";

const READINESS_TIMEOUT_MS = 5_000;

async function probeAffineGraphql(config: ServerConfig): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `affine-mcp-server/${VERSION}`,
    ...(config.headers || {}),
  };
  if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    const response = await fetch(config.graphqlEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "query AffineMcpReadiness { __typename }" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AFFiNE GraphQL returned HTTP ${response.status}.`);
    }
    const payload = await response.json() as {
      data?: { __typename?: unknown };
      errors?: Array<{ message?: unknown }>;
    };
    if (payload.errors?.length) {
      const message = payload.errors
        .map((error) => typeof error.message === "string" ? error.message : "Unknown GraphQL error")
        .join("; ");
      throw new Error(`AFFiNE GraphQL readiness query failed: ${message}`);
    }
    if (typeof payload.data?.__typename !== "string") {
      throw new Error("AFFiNE GraphQL returned an unexpected readiness response.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`AFFiNE GraphQL readiness timed out after ${READINESS_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function registerHttpDiagnosticsRoutes(
  app: express.Express,
  config: ServerConfig,
  authState: HttpAuthState,
  corsMiddleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  app.get("/healthz", corsMiddleware, (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      authMode: config.authMode,
      protected: config.authMode === "oauth" || Boolean(authState.httpAuthToken),
    });
  });

  app.get("/readyz", corsMiddleware, async (_req: Request, res: Response) => {
    let oauthReadiness: Awaited<ReturnType<typeof probeOAuthReadiness>> | null = null;
    if (config.authMode === "oauth" && authState.oauthConfig) {
      try {
        oauthReadiness = await probeOAuthReadiness(authState.oauthConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : "OAuth readiness check failed.";
        res.status(503).json({
          status: "not_ready",
          authMode: "oauth",
          component: "oauth",
          error: message,
        });
        return;
      }
    }

    try {
      await probeAffineGraphql(config);
      res.json({
        status: "ok",
        authMode: config.authMode,
        upstream: "affine-graphql",
        graphqlPath: config.graphqlPath,
        ...(oauthReadiness && authState.oauthConfig
          ? {
              issuer: oauthReadiness.issuer,
              jwksUri: oauthReadiness.jwksUri,
              resource: getOAuthResourceUrl(authState.oauthConfig.publicBaseUrl),
            }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AFFiNE GraphQL readiness check failed.";
      res.status(503).json({
        status: "not_ready",
        authMode: config.authMode,
        component: "affine-graphql",
        error: message,
      });
    }
  });
}
