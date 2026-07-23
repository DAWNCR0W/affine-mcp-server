import { fetch } from "undici";

import type { AuthSnapshot } from "./authSession.js";
import { VERSION, AFFINE_CLIENT_VERSION } from "./config.js";

const GQL_FETCH_TIMEOUT_MS = 30_000;

export type ConnectionAuth = {
  bearer: string;
  cookie: string;
  endpoint: string;
  headers: Record<string, string>;
};

type GraphQLClientOptions = {
  authProvider?: () => Promise<AuthSnapshot>;
  bearer?: string;
  endpoint: string;
  headers?: Record<string, string>;
};

function isAuthenticationHeader(name: string): boolean {
  return /^(authorization|cookie)$/i.test(name);
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  let found: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) found = value;
  }
  return found;
}

function withoutAuthenticationHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isAuthenticationHeader(name)),
  );
}

function bearerFromHeader(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("Authorization header contains illegal CR/LF characters");
  }
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) throw new Error("Authorization header must use the Bearer scheme");
  return match[1];
}

function validateAuthSnapshot(snapshot: AuthSnapshot): AuthSnapshot {
  if (snapshot.kind === "bearer") {
    if (/[\r\n]/.test(snapshot.token)) {
      throw new Error("Bearer token contains illegal CR/LF characters");
    }
    if (!snapshot.token.trim()) throw new Error("Bearer token must not be empty");
  }
  if (snapshot.kind === "cookie") {
    if (/[\r\n]/.test(snapshot.cookie)) {
      throw new Error("Cookie header contains illegal CR/LF characters");
    }
    if (!snapshot.cookie.trim()) throw new Error("Cookie header must not be empty");
  }
  return snapshot;
}

function authHeaders(snapshot: AuthSnapshot): Record<string, string> {
  if (snapshot.kind === "bearer") {
    return { Authorization: `Bearer ${snapshot.token}` };
  }
  if (snapshot.kind === "cookie") {
    return { Cookie: snapshot.cookie };
  }
  return {};
}

/** Strip HTML tags and truncate to a safe length for error messages. */
function sanitizeErrorBody(s: string, max = 200): string {
  const stripped = s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return stripped.length > max ? stripped.slice(0, max) + "..." : stripped;
}

export class GraphQLClient {
  private readonly baseHeaders: Record<string, string>;
  private readonly authProvider?: () => Promise<AuthSnapshot>;
  private authResolution?: Promise<AuthSnapshot>;
  private resolvedAuth: AuthSnapshot = { kind: "none" };
  private authOverride?: AuthSnapshot;

  constructor(private readonly opts: GraphQLClientOptions) {
    const sourceHeaders = { ...(opts.headers || {}) };
    this.baseHeaders = withoutAuthenticationHeaders(sourceHeaders);
    this.authProvider = opts.authProvider;

    const authorization = findHeader(sourceHeaders, "authorization");
    const cookie = findHeader(sourceHeaders, "cookie");
    if (opts.bearer) {
      this.resolvedAuth = validateAuthSnapshot({ kind: "bearer", token: opts.bearer });
    } else if (authorization !== undefined) {
      this.resolvedAuth = validateAuthSnapshot({
        kind: "bearer",
        token: bearerFromHeader(authorization),
      });
    } else if (cookie !== undefined) {
      this.resolvedAuth = validateAuthSnapshot({ kind: "cookie", cookie });
    }
  }

  /** The GraphQL endpoint URL. */
  get endpoint(): string {
    return this.opts.endpoint;
  }

  /** Synchronous snapshot for compatibility. Async consumers must use getConnectionAuth(). */
  get headers(): Record<string, string> {
    const snapshot = this.authOverride || this.resolvedAuth;
    return { ...this.baseHeaders, ...authHeaders(snapshot) };
  }

  get cookie(): string {
    const snapshot = this.authOverride || this.resolvedAuth;
    return snapshot.kind === "cookie" ? snapshot.cookie : "";
  }

  get bearer(): string {
    const snapshot = this.authOverride || this.resolvedAuth;
    return snapshot.kind === "bearer" ? snapshot.token : "";
  }

  setHeaders(next: Record<string, string>) {
    const authorization = findHeader(next, "authorization");
    const cookie = findHeader(next, "cookie");
    Object.assign(this.baseHeaders, withoutAuthenticationHeaders(next));

    if (authorization !== undefined) {
      this.setBearer(bearerFromHeader(authorization));
    } else if (cookie !== undefined) {
      this.setCookie(cookie);
    }
  }

  setCookie(cookieHeader: string) {
    this.authOverride = validateAuthSnapshot({ kind: "cookie", cookie: cookieHeader });
    console.error("Session cookies set from email/password login");
  }

  setBearer(token: string) {
    this.authOverride = validateAuthSnapshot({ kind: "bearer", token });
    console.error("Using Bearer token authentication");
  }

  isAuthenticated(): boolean {
    return (this.authOverride || this.resolvedAuth).kind !== "none";
  }

  private resolveAuth(): Promise<AuthSnapshot> {
    if (this.authOverride) return Promise.resolve(this.authOverride);
    if (!this.authProvider) return Promise.resolve(this.resolvedAuth);
    if (!this.authResolution) {
      this.authResolution = this.authProvider().then((snapshot) => {
        const provided = validateAuthSnapshot(snapshot);
        if (provided.kind !== "none" || this.resolvedAuth.kind === "none") {
          this.resolvedAuth = provided;
        }
        return this.resolvedAuth;
      });
    }
    return this.authResolution;
  }

  /** Await authentication and return one normalized credential set for HTTP or WebSocket consumers. */
  async getConnectionAuth(): Promise<ConnectionAuth> {
    const snapshot = this.authOverride || await this.resolveAuth();
    // `x-affine-version` first so an explicit AFFINE_HEADERS_JSON override (in
    // baseHeaders) still wins. Injecting it here covers every consumer —
    // request() below and the direct multipart/blob uploads in tools/.
    const headers = {
      "x-affine-version": AFFINE_CLIENT_VERSION,
      ...this.baseHeaders,
      ...authHeaders(snapshot),
    };
    return {
      bearer: snapshot.kind === "bearer" ? snapshot.token : "",
      cookie: snapshot.kind === "cookie" ? snapshot.cookie : "",
      endpoint: this.opts.endpoint,
      headers,
    };
  }

  async request<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const connection = await this.getConnectionAuth();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `affine-mcp-server/${VERSION}`,
      ...connection.headers,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GQL_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(this.opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`GraphQL request timed out after ${GQL_FETCH_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      throw new Error(
        `GraphQL endpoint returned redirect ${res.status} -> ${location || "(no location)"}. ` +
        "Check AFFINE_BASE_URL.",
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json") && !contentType.includes("application/graphql")) {
      const body = await res.text();
      const snippet = sanitizeErrorBody(body);
      throw new Error(
        `GraphQL endpoint returned non-JSON response (${res.status} ${res.statusText}, ` +
        `Content-Type: ${contentType || "(none)"}). Body: ${snippet}`,
      );
    }

    if (!res.ok) {
      let body: string;
      try {
        const json = await res.json() as any;
        body = json.errors?.map((e: any) => e.message).join("; ") || JSON.stringify(json);
      } catch {
        body = await res.text().catch(() => "(unreadable body)");
      }
      throw new Error(`GraphQL HTTP ${res.status}: ${sanitizeErrorBody(body)}`);
    }

    const json = await res.json() as any;
    if (json.errors) {
      const msg = json.errors.map((e: any) => e.message).join("; ");
      throw new Error(`GraphQL error: ${sanitizeErrorBody(msg)}`);
    }
    return json.data as T;
  }
}
