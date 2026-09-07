import { fetch } from "undici";

import type { AuthSnapshot } from "./authSession.js";
import { VERSION, AFFINE_CLIENT_VERSION } from "./config.js";
import { fetchResponseBody } from "./util/httpResponse.js";

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

  /**
   * Build the outgoing header set for a snapshot. `x-affine-version` goes first
   * so an explicit override in `baseHeaders` (from `AFFINE_HEADERS_JSON`) wins,
   * and auth headers last so they are never shadowed. Shared by the `headers`
   * getter and `getConnectionAuth()` so every request path stays consistent.
   */
  private composeHeaders(snapshot: AuthSnapshot): Record<string, string> {
    const headers: Record<string, string> = { ...this.baseHeaders };
    // Only supply the default when baseHeaders (AFFINE_HEADERS_JSON) has no
    // `x-affine-version` in any casing, so Fetch can't coalesce two casings
    // into one comma-joined value.
    if (findHeader(headers, "x-affine-version") === undefined) {
      headers["x-affine-version"] = AFFINE_CLIENT_VERSION;
    }
    return { ...headers, ...authHeaders(snapshot) };
  }

  /** Synchronous snapshot for compatibility. Async consumers must use getConnectionAuth(). */
  get headers(): Record<string, string> {
    const snapshot = this.authOverride || this.resolvedAuth;
    return this.composeHeaders(snapshot);
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
    // Injected here (not only in request()) so it also covers the direct
    // multipart/blob uploads in tools/ that build their own fetch from this.
    const headers = this.composeHeaders(snapshot);
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

    const { response: res, body } = await fetchResponseBody(
      signal => fetch(this.opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal,
      }),
      { label: "GraphQL request", timeoutMs: GQL_FETCH_TIMEOUT_MS },
    );

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      throw new Error(
        `GraphQL endpoint returned redirect ${res.status} -> ${location || "(no location)"}. ` +
        "Check AFFINE_BASE_URL.",
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json") && !contentType.includes("application/graphql")) {
      const snippet = sanitizeErrorBody(body);
      throw new Error(
        `GraphQL endpoint returned non-JSON response (${res.status} ${res.statusText}, ` +
        `Content-Type: ${contentType || "(none)"}). Body: ${snippet}`,
      );
    }

    if (!res.ok) {
      let detail = body;
      try {
        const json = JSON.parse(body) as any;
        detail = json.errors?.map((e: any) => e.message).join("; ") || JSON.stringify(json);
      } catch {}
      throw new Error(`GraphQL HTTP ${res.status}: ${sanitizeErrorBody(detail)}`);
    }

    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error("GraphQL endpoint returned invalid JSON.");
    }
    if (json.errors) {
      const msg = json.errors.map((e: any) => e.message).join("; ");
      throw new Error(`GraphQL error: ${sanitizeErrorBody(msg)}`);
    }
    return json.data as T;
  }
}
