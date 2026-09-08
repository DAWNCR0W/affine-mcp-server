export type ConfiguredAuthKind = "none" | "api-token" | "cookie" | "email-password";
export type ConfiguredAuthSource = "env" | "config" | "unset";

export type ConfiguredAuthInput = {
  apiToken?: string;
  cookie?: string;
  email?: string;
  password?: string;
  headers?: Record<string, string>;
  source?: ConfiguredAuthSource;
};

export type ConfiguredAuth = {
  kind: ConfiguredAuthKind;
  source: ConfiguredAuthSource;
  apiToken?: string;
  cookie?: string;
  email?: string;
  password?: string;
  headers?: Record<string, string>;
};

export function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  let value: string | undefined;
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === lowerName) value = headerValue;
  }
  return value;
}

export function hasAuthenticationHeader(headers: Record<string, string> | undefined): boolean {
  return getHeaderCaseInsensitive(headers, "authorization") !== undefined
    || getHeaderCaseInsensitive(headers, "cookie") !== undefined;
}

export function withoutAuthenticationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !/^(authorization|cookie)$/i.test(name)),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function validateCredential(value: string, label: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} contains illegal CR/LF characters.`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  return trimmed;
}

export function parseBearerAuthorizationHeader(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("Authorization header contains illegal CR/LF characters.");
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match) throw new Error("Authorization header must use the Bearer scheme.");
  return validateCredential(match[1], "Bearer token");
}

export function resolveConfiguredAuth(input: ConfiguredAuthInput): ConfiguredAuth {
  const authorization = getHeaderCaseInsensitive(input.headers, "authorization");
  const headerCookie = getHeaderCaseInsensitive(input.headers, "cookie");
  const headers = withoutAuthenticationHeaders(input.headers);
  let resolvedToken: string | undefined;
  let resolvedCookie: string | undefined;
  let kind: ConfiguredAuthKind = "none";

  if (input.apiToken) {
    resolvedToken = validateCredential(input.apiToken, "API token");
    kind = "api-token";
  } else if (input.cookie) {
    resolvedCookie = validateCredential(input.cookie, "Cookie");
    kind = "cookie";
  } else if (authorization !== undefined) {
    resolvedToken = parseBearerAuthorizationHeader(authorization);
    kind = "api-token";
  } else if (headerCookie !== undefined) {
    resolvedCookie = validateCredential(headerCookie, "Cookie header");
    kind = "cookie";
  } else if (input.email && input.password) {
    kind = "email-password";
  }

  const hasConfiguredValue = Boolean(
    input.apiToken
      || input.cookie
      || input.email
      || input.password
      || authorization !== undefined
      || headerCookie !== undefined,
  );
  const normalizedHeaders = kind === "cookie"
    ? { ...(headers || {}), Cookie: resolvedCookie! }
    : headers;

  // Expose only the selected authentication mode to callers. This keeps
  // summaries and operations aligned with the credential that will be sent,
  // while preserving partial email/password values when no complete method is
  // selected so configuration warnings remain possible.
  const selectedEmail = kind === "none" || kind === "email-password" ? input.email || undefined : undefined;
  const selectedPassword = kind === "none" || kind === "email-password" ? input.password || undefined : undefined;

  return {
    kind,
    source: hasConfiguredValue ? input.source || "unset" : "unset",
    apiToken: resolvedToken,
    cookie: kind === "cookie" ? resolvedCookie : undefined,
    email: selectedEmail,
    password: selectedPassword,
    headers: normalizedHeaders,
  };
}
