import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
export const VERSION: string = pkg.version;

export type TransportMode = "stdio" | "http";
export type LoginAtStartMode = "async" | "sync";

export type HttpServerConfig = {
  host: string;
  port: number;
  authToken?: string;
  allowedOrigins: string[];
  allowAllOrigins: boolean;
};

export type ServerConfig = {
  baseUrl: string;
  graphqlEndpoint: string;
  apiToken?: string;
  cookie?: string;
  headers?: Record<string, string>;
  graphqlPath: string;
  email?: string;
  password?: string;
  defaultWorkspaceId?: string;
  authMode: "bearer" | "oauth";
  publicBaseUrl?: string;
  oauthIssuerUrl?: string;
  oauthScopes: string[];
  oauthClockSkewSeconds: number;
  transportMode: TransportMode;
  loginAtStart: LoginAtStartMode;
  http: HttpServerConfig;
  oauthAllowServiceWrites: boolean;
};

/** Config file location: ~/.config/affine-mcp/config */
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "affine-mcp"
);
export const CONFIG_FILE = path.join(CONFIG_DIR, "config");

/** Read key=value config file, returns empty object if missing */
export function loadConfigFile(): Record<string, string> {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  const content = fs.readFileSync(CONFIG_FILE, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

/** Write config file atomically with 600 permissions (temp + rename). */
export function writeConfigFile(vars: Record<string, string>) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const lines = [
    "# AFFiNE MCP Server configuration",
    "# Managed by the affine-mcp CLI",
    `# ${new Date().toISOString()}`,
  ];
  for (const [key, value] of Object.entries(vars)) {
    if (value) lines.push(`${key}=${value}`);
  }
  lines.push("");
  // Atomic write: write to temp file then rename to prevent partial reads
  const tmpFile = path.join(CONFIG_DIR, `.config.tmp.${process.pid}`);
  try {
    fs.writeFileSync(tmpFile, lines.join("\n"), { mode: 0o600 });
    fs.renameSync(tmpFile, CONFIG_FILE);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpFile); } catch {}
    throw err;
  }
}

/** Validate and sanitize a base URL. Throws on invalid or dangerous URLs. */
export function validateBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  // Reject credentials embedded in URL (SSRF vector)
  if (parsed.username || parsed.password) {
    throw new Error("URL must not contain embedded credentials (user:pass@host)");
  }
  // Only allow http and https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol} (only http/https allowed)`);
  }
  // Warn (but allow) plain HTTP for non-local targets
  const host = parsed.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  if (parsed.protocol === "http:" && !isLocal) {
    console.error("WARNING: Using plain HTTP for a non-localhost URL. Consider HTTPS for security.");
  }
  // Return normalized URL without trailing slash
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/** Validate a same-origin GraphQL path and normalize its leading slash. */
export function validateGraphqlPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("AFFINE_GRAPHQL_PATH must not be empty.");
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("AFFINE_GRAPHQL_PATH must not include a query string or fragment.");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    throw new Error("AFFINE_GRAPHQL_PATH must be a path, not an absolute URL.");
  }
  return `/${trimmed.replace(/^\/+/, "")}`.replace(/\/$/, "") || "/";
}

/** Build the exact GraphQL endpoint used by the CLI and runtime. */
export function buildGraphqlEndpoint(baseUrl: string, graphqlPath: string): string {
  return `${validateBaseUrl(baseUrl)}${validateGraphqlPath(graphqlPath)}`;
}

/**
 * Helper: read env var with config file fallback.
 * Environment variables always take priority over the config file.
 */
function env(name: string, file: Record<string, string>, fallback?: string): string | undefined {
  return process.env[name] || file[name] || fallback;
}

function parseHeadersJson(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("Failed to parse AFFINE_HEADERS_JSON; expected a JSON object of string headers.");
      return undefined;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") {
        console.warn(`Ignoring non-string AFFINE_HEADERS_JSON value for header '${key}'.`);
        continue;
      }
      headers[key] = value;
    }
    const sensitiveKeys = Object.keys(headers).filter((k) => /^(authorization|cookie)$/i.test(k));
    if (sensitiveKeys.length) {
      console.warn(
        `WARNING: AFFINE_HEADERS_JSON contains sensitive key(s): ${sensitiveKeys.join(", ")}. ` +
        `Built-in token/cookie auth overrides these values when configured.`
      );
    }
    return headers;
  } catch {
    console.warn("Failed to parse AFFINE_HEADERS_JSON; ignoring.");
    return undefined;
  }
}

function removeHeadersCaseInsensitive(
  headers: Record<string, string> | undefined,
  names: string[],
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  const filtered = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function parseAuthMode(raw: string | undefined): "bearer" | "oauth" {
  if (!raw) return "bearer";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "bearer" || normalized === "oauth") {
    return normalized;
  }
  throw new Error(`Invalid AFFINE_MCP_AUTH_MODE: ${raw}. Expected 'bearer' or 'oauth'.`);
}

function parseOAuthScopes(raw: string | undefined): string[] {
  const scopes = (raw || "mcp")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : ["mcp"];
}

function parsePositiveIntegerEnv(name: string, raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  return parsed;
}

function parseTransportMode(raw: string | undefined): TransportMode {
  const normalized = (raw || "stdio").trim().toLowerCase();
  if (normalized === "stdio") return "stdio";
  if (normalized === "http" || normalized === "streamable" || normalized === "sse") return "http";
  throw new Error(
    `Invalid MCP_TRANSPORT: ${raw}. Expected 'stdio', 'http', 'streamable', or 'sse'.`,
  );
}

function parseLoginAtStart(raw: string | undefined): LoginAtStartMode {
  const normalized = (raw || "async").trim().toLowerCase();
  if (normalized === "async" || normalized === "sync") return normalized;
  throw new Error(`Invalid AFFINE_LOGIN_AT_START: ${raw}. Expected 'async' or 'sync'.`);
}

function parseBooleanEnv(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be 'true' or 'false'. Received: ${raw}`);
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`PORT must be an integer from 0 through 65535. Received: ${raw}`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 through 65535. Received: ${raw}`);
  }
  return port;
}

function parseHttpHost(raw: string | undefined): string {
  const host = (raw || "127.0.0.1").trim();
  if (!host) throw new Error("AFFINE_MCP_HTTP_HOST must not be empty.");
  if (host.includes("://") || /[/?#]/.test(host)) {
    throw new Error("AFFINE_MCP_HTTP_HOST must be a host name or IP address, not a URL.");
  }
  return host;
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`Invalid origin in AFFINE_MCP_HTTP_ALLOWED_ORIGINS: ${origin}`);
      }
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) {
        throw new Error(
          `AFFINE_MCP_HTTP_ALLOWED_ORIGINS entries must be http(s) origins without paths: ${origin}`,
        );
      }
      return parsed.origin;
    });
}

export function loadConfig(): ServerConfig {
  const file = loadConfigFile();
  const baseUrl = validateBaseUrl(env("AFFINE_BASE_URL", file, "http://localhost:3010")!);
  const authMode = parseAuthMode(env("AFFINE_MCP_AUTH_MODE", file, "bearer"));
  const apiToken = env("AFFINE_API_TOKEN", file);
  const cookie = env("AFFINE_COOKIE", file);
  const email = env("AFFINE_EMAIL", file);
  const password = env("AFFINE_PASSWORD", file);
  let headers: Record<string, string> | undefined = parseHeadersJson(env("AFFINE_HEADERS_JSON", file));
  if (apiToken) {
    headers = removeHeadersCaseInsensitive(headers, ["authorization", "cookie"]);
  } else if (cookie) {
    headers = {
      ...(removeHeadersCaseInsensitive(headers, ["authorization", "cookie"]) || {}),
      Cookie: cookie,
    };
  }
  const graphqlPath = validateGraphqlPath(env("AFFINE_GRAPHQL_PATH", file, "/graphql")!);
  const graphqlEndpoint = `${baseUrl}${graphqlPath}`;
  const defaultWorkspaceId = env("AFFINE_WORKSPACE_ID", file);
  const publicBaseUrlRaw = env("AFFINE_MCP_PUBLIC_BASE_URL", file);
  const oauthIssuerUrlRaw = env("AFFINE_OAUTH_ISSUER_URL", file);
  const publicBaseUrl = publicBaseUrlRaw ? validateBaseUrl(publicBaseUrlRaw) : undefined;
  const oauthIssuerUrl = oauthIssuerUrlRaw ? validateBaseUrl(oauthIssuerUrlRaw) : undefined;
  const oauthScopes = parseOAuthScopes(env("AFFINE_OAUTH_SCOPES", file, "mcp"));
  const oauthClockSkewSeconds = parsePositiveIntegerEnv(
    "AFFINE_OAUTH_CLOCK_SKEW_SECONDS",
    env("AFFINE_OAUTH_CLOCK_SKEW_SECONDS", file),
    60,
  );
  const transportMode = parseTransportMode(env("MCP_TRANSPORT", file, "stdio"));
  const loginAtStart = parseLoginAtStart(env("AFFINE_LOGIN_AT_START", file, "async"));
  const http: HttpServerConfig = {
    host: parseHttpHost(env("AFFINE_MCP_HTTP_HOST", file, "127.0.0.1")),
    port: parsePort(env("PORT", file, "3000")),
    authToken: env("AFFINE_MCP_HTTP_TOKEN", file)?.trim() || undefined,
    allowedOrigins: parseAllowedOrigins(env("AFFINE_MCP_HTTP_ALLOWED_ORIGINS", file)),
    allowAllOrigins: parseBooleanEnv(
      "AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS",
      env("AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS", file, "false"),
      false,
    ),
  };
  const oauthAllowServiceWrites = parseBooleanEnv(
    "AFFINE_OAUTH_ALLOW_SERVICE_WRITES",
    env("AFFINE_OAUTH_ALLOW_SERVICE_WRITES", file),
    false,
  );

  return {
    baseUrl,
    graphqlEndpoint,
    apiToken,
    cookie,
    headers,
    graphqlPath,
    email,
    password,
    defaultWorkspaceId,
    authMode,
    publicBaseUrl,
    oauthIssuerUrl,
    oauthScopes,
    oauthClockSkewSeconds,
    transportMode,
    loginAtStart,
    http,
    oauthAllowServiceWrites,
  };
}
