import { fetch } from "undici";

export class GraphQLClient {
  private headers: Record<string, string>;
  constructor(private opts: { endpoint: string; headers?: Record<string, string>; bearer?: string }) {
    this.headers = { ...(opts.headers || {}) };
    if (opts.bearer) this.headers["Authorization"] = `Bearer ${opts.bearer}`;
    if (this.headers.Cookie) {
      // keep as is
    }
  }

  setHeaders(next: Record<string, string>) {
    this.headers = { ...this.headers, ...next };
  }

  setCookie(cookieHeader: string) {
    this.headers["Cookie"] = cookieHeader;
    // remove bearer if both present? Keep both; server prefers cookie session.
  }

  async request<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...this.headers };
    const res = await fetch(this.opts.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json();
    if (!res.ok || json.errors) {
      const msg = json.errors?.map((e: any) => e.message).join("; ") || res.statusText;
      throw new Error(`GraphQL error: ${msg}`);
    }
    return json.data as T;
  }
}
