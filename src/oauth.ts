import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";

export type OAuthConfig = {
  publicBaseUrl: string;
  issuerUrl: string;
  scopes: string[];
  clockSkewSeconds: number;
};

export type OAuthAccessTokenInfo = {
  clientId: string | null;
  expiresAt: number;
  scopes: string[];
  subject: string | null;
};

type AuthorizationServerMetadata = {
  issuer: string;
  jwks_uri?: string;
};

const ALLOWED_JWT_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

const metadataCache = new Map<string, Promise<AuthorizationServerMetadata>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function getOAuthResourceUrl(publicBaseUrl: string): string {
  const normalized = publicBaseUrl.replace(/\/$/, "");
  return normalized.endsWith("/mcp") ? normalized : `${normalized}/mcp`;
}

export function getOAuthProtectedResourceMetadataUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
}

export function getOAuthProtectedResourceMetadataPaths(publicBaseUrl: string): string[] {
  const primaryPath = new URL(getOAuthProtectedResourceMetadataUrl(publicBaseUrl)).pathname;
  const resourcePath = new URL(getOAuthResourceUrl(publicBaseUrl)).pathname;
  const aliasPath = `/.well-known/oauth-protected-resource${resourcePath === "/" ? "" : resourcePath}`;
  return [...new Set([primaryPath, aliasPath])];
}

export function buildOAuthProtectedResourceMetadata(config: OAuthConfig) {
  return {
    resource: getOAuthResourceUrl(config.publicBaseUrl),
    authorization_servers: [config.issuerUrl],
    scopes_supported: config.scopes,
  };
}

export function validateOAuthConfig(config: OAuthConfig, opts: { allowAnyOrigin: boolean; httpAuthToken?: string }) {
  if (opts.allowAnyOrigin) {
    throw new Error("AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS=true is not allowed when AFFINE_MCP_AUTH_MODE=oauth.");
  }
  if (opts.httpAuthToken) {
    throw new Error("AFFINE_MCP_HTTP_TOKEN is not allowed when AFFINE_MCP_AUTH_MODE=oauth.");
  }

  const publicUrl = new URL(config.publicBaseUrl);
  const issuerUrl = new URL(config.issuerUrl);

  if (publicUrl.protocol !== "https:" && !isLoopbackHostname(publicUrl.hostname)) {
    throw new Error("AFFINE_MCP_PUBLIC_BASE_URL must use HTTPS for non-local OAuth deployments.");
  }
  if (issuerUrl.protocol !== "https:" && !isLoopbackHostname(issuerUrl.hostname)) {
    throw new Error("AFFINE_OAUTH_ISSUER_URL must use HTTPS for non-local OAuth deployments.");
  }
}

function buildAudienceList(config: OAuthConfig): string[] {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/$/, "");
  const resourceUrl = getOAuthResourceUrl(config.publicBaseUrl);
  return [...new Set([publicBaseUrl, resourceUrl])];
}

function getScopesFromPayload(payload: JWTPayload): string[] {
  const scopes = new Set<string>();
  if (typeof payload.scope === "string") {
    for (const scope of payload.scope.split(/\s+/).map((entry) => entry.trim()).filter(Boolean)) {
      scopes.add(scope);
    }
  }
  const scp = payload.scp;
  if (typeof scp === "string") {
    for (const scope of scp.split(/\s+/).map((entry) => entry.trim()).filter(Boolean)) {
      scopes.add(scope);
    }
  } else if (Array.isArray(scp)) {
    for (const scope of scp) {
      if (typeof scope === "string" && scope.trim()) {
        scopes.add(scope.trim());
      }
    }
  }
  return [...scopes];
}

async function loadAuthorizationServerMetadata(issuerUrl: string): Promise<AuthorizationServerMetadata> {
  let pending = metadataCache.get(issuerUrl);
  if (!pending) {
    pending = (async () => {
      const discovered = await discoverAuthorizationServerMetadata(new URL(issuerUrl));
      if (!discovered?.issuer || typeof discovered.issuer !== "string") {
        throw new Error(`Could not discover authorization server metadata from ${issuerUrl}`);
      }
      if (!("jwks_uri" in discovered) || typeof discovered.jwks_uri !== "string" || !discovered.jwks_uri) {
        throw new Error(`Authorization server metadata from ${issuerUrl} did not provide jwks_uri`);
      }
      return {
        issuer: discovered.issuer,
        jwks_uri: discovered.jwks_uri,
      };
    })();
    metadataCache.set(issuerUrl, pending);
  }
  return pending;
}

export async function probeOAuthReadiness(config: OAuthConfig): Promise<{ issuer: string; jwksUri: string }> {
  const metadata = await loadAuthorizationServerMetadata(config.issuerUrl);
  if (!metadata.jwks_uri) {
    throw new Error("Authorization server metadata is missing jwks_uri");
  }
  return {
    issuer: metadata.issuer,
    jwksUri: metadata.jwks_uri,
  };
}

function getJwks(metadata: AuthorizationServerMetadata) {
  if (!metadata.jwks_uri) {
    throw new Error("Authorization server metadata is missing jwks_uri");
  }
  let jwks = jwksCache.get(metadata.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    jwksCache.set(metadata.jwks_uri, jwks);
  }
  return jwks;
}

export async function verifyOAuthAccessToken(token: string, config: OAuthConfig): Promise<OAuthAccessTokenInfo> {
  const metadata = await loadAuthorizationServerMetadata(config.issuerUrl);
  const { payload } = await jwtVerify(token, getJwks(metadata), {
    issuer: metadata.issuer,
    audience: buildAudienceList(config),
    algorithms: [...ALLOWED_JWT_ALGORITHMS],
    clockTolerance: config.clockSkewSeconds,
  });

  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Token does not include a valid exp claim");
  }

  const scopes = getScopesFromPayload(payload);
  return {
    clientId:
      typeof payload.client_id === "string"
        ? payload.client_id
        : typeof payload.azp === "string"
          ? payload.azp
          : null,
    expiresAt: payload.exp,
    scopes,
    subject: typeof payload.sub === "string" ? payload.sub : null,
  };
}
