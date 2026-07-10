const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

const DEFAULT_BODY_LIMIT_BYTES = 4 * MEBIBYTE;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10 * 1000;

export type HttpRuntimeConfig = {
  bodyLimitBytes: number;
  maxSessions: number;
  sessionIdleTimeoutMs: number;
  sessionSweepIntervalMs: number;
  shutdownTimeoutMs: number;
};

function parseIntegerInRange(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}. Received: ${raw}`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}. Received: ${raw}`);
  }
  return parsed;
}

export function parseBodyLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BODY_LIMIT_BYTES;

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(
      `AFFINE_MCP_HTTP_BODY_LIMIT must be a byte size such as "4096", "512kb", or "4mb". Received: ${raw}`,
    );
  }

  const value = Number(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  const multiplier = unit === "mb" ? MEBIBYTE : unit === "kb" ? KIBIBYTE : 1;
  const bytes = Math.floor(value * multiplier);

  if (!Number.isSafeInteger(bytes) || bytes < KIBIBYTE || bytes > 64 * MEBIBYTE) {
    throw new Error(
      `AFFINE_MCP_HTTP_BODY_LIMIT must resolve to a value between 1kb and 64mb. Received: ${raw}`,
    );
  }
  return bytes;
}

export function loadHttpRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpRuntimeConfig {
  const bodyLimitBytes = parseBodyLimit(env.AFFINE_MCP_HTTP_BODY_LIMIT);
  const maxSessions = parseIntegerInRange(
    "AFFINE_MCP_HTTP_MAX_SESSIONS",
    env.AFFINE_MCP_HTTP_MAX_SESSIONS,
    DEFAULT_MAX_SESSIONS,
    1,
    10_000,
  );
  const sessionIdleTimeoutMs = parseIntegerInRange(
    "AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS",
    env.AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS,
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    100,
    24 * 60 * 60 * 1000,
  );
  const shutdownTimeoutMs = parseIntegerInRange(
    "AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS",
    env.AFFINE_MCP_HTTP_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    100,
    2 * 60 * 1000,
  );

  return {
    bodyLimitBytes,
    maxSessions,
    sessionIdleTimeoutMs,
    sessionSweepIntervalMs: Math.max(
      25,
      Math.min(Math.floor(sessionIdleTimeoutMs / 4), 30_000),
    ),
    shutdownTimeoutMs,
  };
}
