import { loginWithPassword } from "./auth.js";

export type AuthSnapshot =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "cookie"; cookie: string };

export type LoginMode = "async" | "sync";

type LoginFunction = typeof loginWithPassword;

type AuthSessionOptions = {
  baseUrl: string;
  bearer?: string;
  cookie?: string;
  email?: string;
  password?: string;
  /** Extra headers (e.g. from AFFINE_HEADERS_JSON) forwarded to email/password sign-in. */
  headers?: Record<string, string>;
  login?: LoginFunction;
  retryDelayMs?: number;
  now?: () => number;
};

export function parseLoginMode(raw: string | undefined): LoginMode {
  if (raw === undefined || raw.trim() === "") return "async";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "async" || normalized === "sync") return normalized;
  throw new Error(`AFFINE_LOGIN_AT_START must be "async" or "sync". Received: ${raw}`);
}

/** Process-scoped authentication state shared by every MCP transport session. */
export class AuthSession {
  private readonly baseUrl: string;
  private readonly login: LoginFunction;
  private readonly headers?: Record<string, string>;
  private email?: string;
  private password?: string;
  private immediate: AuthSnapshot;
  private pending?: Promise<AuthSnapshot>;
  private failedAt = 0;
  private lastError?: Error;
  private refreshAt = Infinity;
  private readonly retryDelayMs: number;
  private readonly now: () => number;

  constructor(options: AuthSessionOptions) {
    const hasImmediateAuth = Boolean(options.bearer || options.cookie);
    if (!hasImmediateAuth && Boolean(options.email) !== Boolean(options.password)) {
      throw new Error("AFFINE_EMAIL and AFFINE_PASSWORD must be configured together.");
    }

    this.baseUrl = options.baseUrl;
    this.login = options.login || loginWithPassword;
    this.headers = options.headers;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.email = hasImmediateAuth ? undefined : options.email;
    this.password = hasImmediateAuth ? undefined : options.password;

    if (options.bearer) {
      this.immediate = { kind: "bearer", token: options.bearer };
    } else if (options.cookie) {
      this.immediate = { kind: "cookie", cookie: options.cookie };
    } else {
      this.immediate = { kind: "none" };
    }
  }

  get hasConfiguredAuth(): boolean {
    return this.immediate.kind !== "none" || this.requiresLogin;
  }

  get requiresLogin(): boolean {
    return this.immediate.kind === "none" && Boolean(this.pending || (this.email && this.password));
  }

  get source(): "bearer" | "cookie" | "email-password" | "none" {
    if (this.immediate.kind === "bearer") return "bearer";
    if (this.immediate.kind === "cookie") return "cookie";
    return this.requiresLogin ? "email-password" : "none";
  }

  /** Begin authentication without delaying transport startup. */
  start(): void {
    void this.ready().catch(() => {
      // Consumers receive the error; a later request can retry after cooldown.
    });
  }

  /** Share each attempt and retry failures after a cooldown, never as anonymous. */
  ready(): Promise<AuthSnapshot> {
    if (this.pending) return this.pending;
    if (this.immediate.kind === "cookie" && this.email && this.password && this.now() >= this.refreshAt) {
      this.immediate = { kind: "none" };
    }
    if (this.immediate.kind !== "none" || !this.requiresLogin) {
      return Promise.resolve(this.immediate);
    }
    if (this.lastError && this.now() - this.failedAt < this.retryDelayMs) {
      return Promise.reject(this.lastError);
    }

    const email = this.email!;
    const password = this.password!;
    console.error("[affine-mcp] Authenticating with email/password...");

    this.pending = Promise.resolve()
      .then(() => this.login(this.baseUrl, email, password, this.headers))
      .then(({ cookieHeader, expiresAt }) => {
        this.immediate = { kind: "cookie", cookie: cookieHeader };
        const now = this.now();
        const lifetime = expiresAt === undefined ? 12 * 60 * 60 * 1000 : Math.max(0, expiresAt - now);
        this.refreshAt = now + Math.min(12 * 60 * 60 * 1000, lifetime - Math.min(60_000, lifetime / 2));
        this.lastError = undefined;
        console.error("[affine-mcp] Email/password authentication succeeded");
        return this.immediate;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[affine-mcp] Email/password authentication failed: ${message}`);
        this.failedAt = this.now();
        this.lastError = new Error(`Email/password authentication failed: ${message}`, { cause: error });
        throw this.lastError;
      })
      .finally(() => {
        this.pending = undefined;
      });

    // Attach a handler immediately so an asynchronously started login cannot emit an unhandled rejection.
    void this.pending.catch(() => {});
    return this.pending;
  }
}
