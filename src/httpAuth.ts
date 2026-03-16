import type express from "express";
import type { NextFunction, Request, Response } from "express";

import type { ServerConfig } from "./config.js";
import type { OAuthConfig } from "./oauth.js";
import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataPaths,
  getOAuthProtectedResourceMetadataUrl,
  validateOAuthConfig,
  verifyOAuthAccessToken,
} from "./oauth.js";

export type HttpAuthState = {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  httpAuthToken?: string;
  oauthConfig: OAuthConfig | null;
  protectedResourceMetadataUrl: string | null;
  protectedResourceMetadataPaths: string[];
};

function buildOAuthErrorResponse(error: string, description: string) {
  return {
    error,
    error_description: description,
  };
}

function buildWwwAuthenticateHeader(
  protectedResourceMetadataUrl: string | null,
  opts?: {
    error?: string;
    errorDescription?: string;
    scope?: string;
  },
) {
  const params: string[] = [];
  if (opts?.error) {
    params.push(`error="${opts.error}"`);
  }
  if (opts?.errorDescription) {
    params.push(`error_description="${opts.errorDescription.replace(/"/g, "'")}"`);
  }
  if (opts?.scope) {
    params.push(`scope="${opts.scope}"`);
  }
  if (protectedResourceMetadataUrl) {
    params.push(`resource_metadata="${protectedResourceMetadataUrl}"`);
  }
  return params.length > 0 ? `Bearer ${params.join(", ")}` : "Bearer";
}

export function createHttpAuthState(
  config: ServerConfig,
  opts: { allowAnyOrigin: boolean; httpAuthToken?: string },
): HttpAuthState {
  let oauthConfig: OAuthConfig | null = null;
  let protectedResourceMetadataUrl: string | null = null;
  let protectedResourceMetadataPaths: string[] = [];

  if (config.authMode === "oauth") {
    if (!config.publicBaseUrl) {
      throw new Error("AFFINE_MCP_PUBLIC_BASE_URL is required when AFFINE_MCP_AUTH_MODE=oauth.");
    }
    if (!config.oauthIssuerUrl) {
      throw new Error("AFFINE_OAUTH_ISSUER_URL is required when AFFINE_MCP_AUTH_MODE=oauth.");
    }
    oauthConfig = {
      publicBaseUrl: config.publicBaseUrl,
      issuerUrl: config.oauthIssuerUrl,
      scopes: config.oauthScopes,
      clockSkewSeconds: config.oauthClockSkewSeconds,
    };
    validateOAuthConfig(oauthConfig, opts);
    protectedResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(oauthConfig.publicBaseUrl);
    protectedResourceMetadataPaths = getOAuthProtectedResourceMetadataPaths(oauthConfig.publicBaseUrl);
  }

  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();

    if (config.authMode === "oauth") {
      if (!oauthConfig) {
        res.status(500).json(buildOAuthErrorResponse("server_error", "OAuth configuration was not initialized."));
        return;
      }

      if (typeof req.query.token === "string") {
        res.set("WWW-Authenticate", buildWwwAuthenticateHeader(protectedResourceMetadataUrl, {
          error: "invalid_request",
          errorDescription: "Query parameter token is not allowed in oauth mode.",
        }));
        res.status(400).json(buildOAuthErrorResponse("invalid_request", "Query parameter token is not allowed in oauth mode."));
        return;
      }

      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.set("WWW-Authenticate", buildWwwAuthenticateHeader(protectedResourceMetadataUrl));
        res.status(401).json(buildOAuthErrorResponse("invalid_token", "Missing Authorization header."));
        return;
      }

      const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const bearerMatch = /^Bearer\s+(.+)$/i.exec(raw);
      if (!bearerMatch) {
        res.set("WWW-Authenticate", buildWwwAuthenticateHeader(protectedResourceMetadataUrl, {
          error: "invalid_request",
          errorDescription: "Use 'Authorization: Bearer <token>'.",
        }));
        res.status(401).json(buildOAuthErrorResponse("invalid_request", "Use 'Authorization: Bearer <token>'."));
        return;
      }

      void verifyOAuthAccessToken(bearerMatch[1], oauthConfig)
        .then((authInfo) => {
          const requiredScopes = oauthConfig?.scopes || [];
          const hasAllScopes = requiredScopes.every((scope) => authInfo.scopes.includes(scope));
          if (!hasAllScopes) {
            res.set("WWW-Authenticate", buildWwwAuthenticateHeader(protectedResourceMetadataUrl, {
              error: "insufficient_scope",
              errorDescription: "The access token does not include the required scope.",
              scope: requiredScopes.join(" "),
            }));
            res.status(403).json(
              buildOAuthErrorResponse("insufficient_scope", "The access token does not include the required scope."),
            );
            return;
          }
          next();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Access token validation failed.";
          res.set("WWW-Authenticate", buildWwwAuthenticateHeader(protectedResourceMetadataUrl, {
            error: "invalid_token",
            errorDescription: message,
          }));
          res.status(401).json(buildOAuthErrorResponse("invalid_token", message));
        });
      return;
    }

    const httpAuthToken = opts.httpAuthToken;
    if (!httpAuthToken) return next();

    const authHeader = req.headers.authorization;
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    let token: string | undefined;

    if (authHeader !== undefined) {
      const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const bearerMatch = /^Bearer\s+(.+)$/i.exec(raw);
      if (bearerMatch) {
        token = bearerMatch[1];
      } else {
        res.status(401).send("Unauthorized: Use 'Authorization: Bearer <token>'");
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

  return {
    authMiddleware,
    httpAuthToken: opts.httpAuthToken,
    oauthConfig,
    protectedResourceMetadataUrl,
    protectedResourceMetadataPaths,
  };
}

export function registerHttpAuthRoutes(
  app: express.Express,
  state: HttpAuthState,
  corsMiddleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  if (!state.oauthConfig || state.protectedResourceMetadataPaths.length === 0) {
    return;
  }

  const metadata = buildOAuthProtectedResourceMetadata(state.oauthConfig);
  const metadataHandler = (_req: Request, res: Response) => {
    res.json(metadata);
  };

  for (const path of state.protectedResourceMetadataPaths) {
    app.get(path, corsMiddleware, metadataHandler);
  }
}
