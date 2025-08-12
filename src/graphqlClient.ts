import { fetch } from "undici";

export class GraphQLClient {
  private headers: Record<string, string>;
  private authenticated: boolean = false;
  
  constructor(private opts: { endpoint: string; headers?: Record<string, string>; bearer?: string }) {
    this.headers = { ...(opts.headers || {}) };
    
    // Set authentication in priority order
    if (opts.bearer) {
      this.headers["Authorization"] = `Bearer ${opts.bearer}`;
      this.authenticated = true;
      console.error("Using Bearer token authentication");
    } else if (this.headers.Cookie) {
      this.authenticated = true;
      console.error("Using Cookie authentication");
    }
  }

  setHeaders(next: Record<string, string>) {
    this.headers = { ...this.headers, ...next };
  }

  setCookie(cookieHeader: string) {
    this.headers["Cookie"] = cookieHeader;
    this.authenticated = true;
    console.error("Session cookies set from email/password login");
  }
  
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async request<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...this.headers };
    const res = await fetch(this.opts.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json() as any;
    if (!res.ok || json.errors) {
      const msg = json.errors?.map((e: any) => e.message).join("; ") || res.statusText;
      throw new Error(`GraphQL error: ${msg}`);
    }
    return json.data as T;
  }
}
