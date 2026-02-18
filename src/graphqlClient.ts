import { fetch } from "undici";

const debug = !!process.env.AFFINE_DEBUG;

function log(...args: any[]) {
  if (debug) console.error("[affine-debug]", ...args);
}

export class GraphQLClient {
  private _headers: Record<string, string>;
  private authenticated: boolean = false;

  constructor(private opts: { endpoint: string; headers?: Record<string, string>; bearer?: string }) {
    this._headers = { ...(opts.headers || {}) };

    // Set authentication in priority order
    if (opts.bearer) {
      this._headers["Authorization"] = `Bearer ${opts.bearer}`;
      this.authenticated = true;
      console.error("Using Bearer token authentication");
    } else if (this._headers.Cookie) {
      this.authenticated = true;
      console.error("Using Cookie authentication");
    }
  }

  /** The GraphQL endpoint URL */
  get endpoint(): string {
    return this.opts.endpoint;
  }

  /** Current request headers (including auth) */
  get headers(): Record<string, string> {
    return { ...this._headers };
  }

  /** Cookie header value, if set */
  get cookie(): string {
    return this._headers["Cookie"] || "";
  }

  /** Bearer token, if set */
  get bearer(): string {
    const auth = this._headers["Authorization"] || "";
    return auth.startsWith("Bearer ") ? auth.slice(7) : "";
  }

  setHeaders(next: Record<string, string>) {
    this._headers = { ...this._headers, ...next };
  }

  setCookie(cookieHeader: string) {
    this._headers["Cookie"] = cookieHeader;
    this.authenticated = true;
    console.error("Session cookies set from email/password login");
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async request<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "affine-mcp-server/1.5.0",
      ...this._headers,
    };

    log("POST", this.opts.endpoint);
    log("Headers:", Object.keys(headers).join(", "));

    const res = await fetch(this.opts.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });

    log("Status:", res.status, res.statusText);

    // Handle redirects (undici may follow them but strip auth headers)
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      throw new Error(
        `GraphQL endpoint returned redirect ${res.status} -> ${location || "(no location)"}. ` +
        `Check AFFINE_BASE_URL.`
      );
    }

    const contentType = res.headers.get("content-type") || "";

    // Guard against non-JSON responses (Cloudflare challenges, HTML error pages)
    if (!contentType.includes("application/json") && !contentType.includes("application/graphql")) {
      const body = await res.text();
      const snippet = body.slice(0, 300).replace(/\n/g, " ");
      throw new Error(
        `GraphQL endpoint returned non-JSON response (${res.status} ${res.statusText}, ` +
        `Content-Type: ${contentType || "(none)"}). Body: ${snippet}`
      );
    }

    if (!res.ok) {
      // Try to parse error body as JSON
      let body: string;
      try {
        const json = await res.json() as any;
        body = json.errors?.map((e: any) => e.message).join("; ") || JSON.stringify(json);
      } catch {
        body = await res.text().catch(() => "(unreadable body)");
      }
      throw new Error(`GraphQL HTTP ${res.status}: ${body}`);
    }

    const json = await res.json() as any;
    if (json.errors) {
      const msg = json.errors.map((e: any) => e.message).join("; ");
      throw new Error(`GraphQL error: ${msg}`);
    }
    return json.data as T;
  }
}
