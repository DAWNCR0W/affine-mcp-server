import { fetch } from "undici";

import { AFFINE_CLIENT_VERSION } from "./config.js";
import { fetchResponseBody } from "./util/httpResponse.js";

const AUTH_FETCH_TIMEOUT_MS = 30_000;

function extractCookiePairs(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const sc of setCookies) {
    const first = sc.split(";")[0];
    if (first) pairs.push(first.trim());
  }
  return pairs.join("; ");
}

/** Reject cookie values containing CR/LF to prevent header injection. */
function assertNoCRLF(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} contains illegal CR/LF characters`);
  }
}

/**
 * Drop authentication headers a sign-in must never carry — it establishes the
 * session cookie itself, so any inherited `Authorization`/`Cookie` is stale.
 */
function sanitizeSignInHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !/^(authorization|cookie)$/i.test(name)),
  );
}

/** Case-insensitive presence check — HTTP header names are case-insensitive. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Exchange email/password for a session cookie.
 *
 * `configuredHeaders` (typically `config.headers` from `AFFINE_HEADERS_JSON`)
 * is merged after the defaults so an explicit `x-affine-version` override wins,
 * matching how the GraphQL/REST paths honor the same override.
 */
export async function loginWithPassword(
  baseUrl: string,
  email: string,
  password: string,
  configuredHeaders?: Record<string, string>,
): Promise<{ cookieHeader: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/auth/sign-in`;
  // Configured headers first so an explicit override wins; only supply the
  // default version when the caller did not set one in any casing, so Fetch
  // can't coalesce two `x-affine-version` casings into one comma-joined value.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...sanitizeSignInHeaders(configuredHeaders),
  };
  if (!hasHeader(headers, "x-affine-version")) {
    headers["x-affine-version"] = AFFINE_CLIENT_VERSION;
  }
  const { response: res, body } = await fetchResponseBody(
    signal => fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
      signal,
    }),
    { label: "Sign-in request", timeoutMs: AUTH_FETCH_TIMEOUT_MS },
  );
  if (!res.ok) {
    const sanitized = body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const truncated = sanitized.length > 200 ? sanitized.slice(0, 200) + "..." : sanitized;
    throw new Error(`Sign-in failed: ${res.status} ${truncated}`);
  }
  const anyHeaders = res.headers as any;
  let setCookies: string[] = [];
  if (typeof anyHeaders.getSetCookie === "function") {
    setCookies = anyHeaders.getSetCookie();
  } else {
    const sc = res.headers.get("set-cookie");
    if (sc) setCookies = [sc];
  }
  if (!setCookies.length) {
    throw new Error("Sign-in succeeded but no Set-Cookie received");
  }
  const cookieHeader = extractCookiePairs(setCookies);
  assertNoCRLF(cookieHeader, "Cookie header from sign-in");
  return { cookieHeader };
}
