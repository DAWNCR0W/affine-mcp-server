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

  constructor(options: AuthSessionOptions) {
    const hasImmediateAuth = Boolean(options.bearer || options.cookie);
    if (!hasImmediateAuth && Boolean(options.email) !== Boolean(options.password)) {
      throw new Error("AFFINE_EMAIL and AFFINE_PASSWORD must be configured together.");
    }

    this.baseUrl = options.baseUrl;
    this.login = options.login || loginWithPassword;
    this.headers = options.headers;
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
      // The shared promise remains rejected so every backend consumer receives the failure.
    });
  }

  /** Resolve the single shared authentication attempt. Rejections are never downgraded to anonymous access. */
  ready(): Promise<AuthSnapshot> {
    if (this.pending) return this.pending;
    if (this.immediate.kind !== "none" || !this.requiresLogin) {
      return Promise.resolve(this.immediate);
    }

    const email = this.email!;
    const password = this.password!;
    this.email = undefined;
    this.password = undefined;
    console.error("[affine-mcp] Authenticating with email/password...");

    this.pending = Promise.resolve()
      .then(() => this.login(this.baseUrl, email, password, this.headers))
      .then(({ cookieHeader }) => {
        this.immediate = { kind: "cookie", cookie: cookieHeader };
        console.error("[affine-mcp] Email/password authentication succeeded");
        return this.immediate;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[affine-mcp] Email/password authentication failed: ${message}`);
        throw new Error(`Email/password authentication failed: ${message}`, { cause: error });
      });

    // Attach a handler immediately so an asynchronously started login cannot emit an unhandled rejection.
    void this.pending.catch(() => {});
    return this.pending;
  }
}
