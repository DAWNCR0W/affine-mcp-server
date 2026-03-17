import type express from "express";
import type { NextFunction, Request, Response } from "express";

import type { ServerConfig } from "./config.js";
import type { HttpAuthState } from "./httpAuth.js";
import { getOAuthResourceUrl, probeOAuthReadiness } from "./oauth.js";

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
    if (config.authMode === "oauth" && authState.oauthConfig) {
      try {
        const readiness = await probeOAuthReadiness(authState.oauthConfig);
        res.json({
          status: "ok",
          authMode: "oauth",
          issuer: readiness.issuer,
          jwksUri: readiness.jwksUri,
          resource: getOAuthResourceUrl(authState.oauthConfig.publicBaseUrl),
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "OAuth readiness check failed.";
        res.status(503).json({
          status: "not_ready",
          authMode: "oauth",
          error: message,
        });
        return;
      }
    }

    res.json({
      status: "ok",
      authMode: config.authMode,
    });
  });
}
