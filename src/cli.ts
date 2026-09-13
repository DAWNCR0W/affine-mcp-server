import { fetch } from "undici";
import * as fs from "fs";
import * as readline from "readline";

import {
  AFFINE_CLIENT_VERSION,
  buildGraphqlEndpoint,
  CONFIG_FILE,
  loadConfig,
  loadConfigFile,
  type ServerConfig,
  validateBaseUrl,
  validateGraphqlPath,
  VERSION,
  writeConfigFile,
} from "./config.js";
import { loginWithPassword } from "./auth.js";
import { probeOAuthReadiness, validateOAuthConfig } from "./oauth.js";
import { parseBooleanFlag } from "./networkSecurity.js";
import { connectWorkspaceSocket, wsUrlFromGraphQLEndpoint, type WorkspaceSocket } from "./ws.js";
import { readWorkspaceProfile } from "./workspaceProfile.js";
import { createToolFilter } from "./toolSurface.js";
import { assertOAuthServiceWritePolicy, createToolFilterEnvironment } from "./oauthServicePolicy.js";
import {
  hasAuthenticationHeader,
  resolveConfiguredAuth,
  type ConfiguredAuthKind,
  type ConfiguredAuthSource,
  withoutAuthenticationHeaders,
} from "./util/configuredAuth.js";
import { fetchResponseBody } from "./util/httpResponse.js";

const CLI_FETCH_TIMEOUT_MS = 30_000;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

type CliCommandHandler = (args: string[]) => Promise<void> | void;
type CliCommandDefinition = {
  summary: string;
  usage: string;
  handler: CliCommandHandler;
};

type ConnectionInspection = {
  userName: string;
  userEmail: string;
  workspaceCount: number;
};

type WorkspaceRecord = {
  id: string;
  createdAt?: string | null;
  memberCount?: number | null;
  owner?: { name?: string | null } | null;
  name?: string | null;
  avatar?: string | null;
  profileStatus?: "available" | "unavailable" | "skipped";
  profileError?: string;
};

type WorkspaceDiscovery = {
  workspaces: WorkspaceRecord[];
  profileError?: string;
};

type WorkspaceSelection = WorkspaceRecord & {
  displayName: string;
  url: string;
};

type CliAuth = {
  token?: string;
  cookie?: string;
  headers?: Record<string, string>;
};

type LoginResult = {
  token?: string;
  cookie?: string;
  workspaceId: string;
  workspaceName: string;
  workspaceUrl: string;
};

type PendingInputLine = {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
};

let nonInteractiveReader: readline.Interface | undefined;
let nonInteractiveLines: string[] = [];
let nonInteractiveWaiters: PendingInputLine[] = [];
let nonInteractiveEnded = false;
let nonInteractiveAborted = false;

function inputEndedError(): CliError {
  return new CliError("Input ended. Re-run the command interactively to continue.");
}

function ensureNonInteractiveReader(): void {
  if (nonInteractiveReader) return;
  nonInteractiveReader = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });
  nonInteractiveReader.on("line", (line) => {
    const waiter = nonInteractiveWaiters.shift();
    if (waiter) {
      waiter.resolve(line);
    } else {
      nonInteractiveLines.push(line);
    }
  });
  nonInteractiveReader.on("close", () => {
    nonInteractiveEnded = true;
    const waiters = nonInteractiveWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(inputEndedError());
  });
  nonInteractiveReader.on("SIGINT", () => {
    nonInteractiveAborted = true;
    const waiters = nonInteractiveWaiters.splice(0);
    const error = new CliError("Aborted.");
    for (const waiter of waiters) waiter.reject(error);
    nonInteractiveReader?.close();
  });
}

function closeNonInteractiveReader(): void {
  const reader = nonInteractiveReader;
  nonInteractiveReader = undefined;
  nonInteractiveEnded = false;
  nonInteractiveAborted = false;
  nonInteractiveLines = [];
  const waiters = nonInteractiveWaiters.splice(0);
  for (const waiter of waiters) waiter.reject(inputEndedError());
  reader?.close();
}

function askNonInteractive(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  if (!nonInteractiveReader && process.stdin.readableEnded) {
    return Promise.reject(inputEndedError());
  }
  if (nonInteractiveAborted) return Promise.reject(new CliError("Aborted."));
  ensureNonInteractiveReader();
  if (nonInteractiveLines.length > 0) {
    return Promise.resolve(nonInteractiveLines.shift()!.trim());
  }
  if (nonInteractiveEnded) return Promise.reject(inputEndedError());
  return new Promise((resolve, reject) => {
    nonInteractiveWaiters.push({
      resolve: (line) => resolve(line.trim()),
      reject,
    });
  });
}

function ask(prompt: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) return askNonInteractive(prompt);
  if (hidden) return readHidden(prompt);
  if (process.stdin.readableEnded) return Promise.reject(inputEndedError());
  return new Promise((resolve, reject) => {
    const reader = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      reader.close();
      callback();
    };
    reader.once("close", () => finish(() => reject(inputEndedError())));
    reader.once("SIGINT", () => finish(() => reject(new CliError("Aborted."))));
    reader.question(prompt, (line) => finish(() => resolve(line.trim())));
  });
}

/** Read a line with echo disabled using raw-mode stdin (no private API hacks). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const buf: string[] = [];
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      ask(prompt).then(resolve, reject);
      return;
    }
    let settled = false;
    const onSigint = () => finish(() => reject(new CliError("Aborted.")));
    const onEnd = () => finish(() => reject(new CliError("Input ended. Re-run the command interactively to continue.")));
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("close", onEnd);
      process.stdin.removeListener("SIGINT", onSigint);
      callback();
    };
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (settled) return;
        switch (ch) {
          case "\r":
          case "\n":
            finish(() => {
              process.stderr.write("\n");
              resolve(buf.join(""));
            });
            break;
          case "\u0003":
            finish(() => {
              process.stderr.write("\n");
              reject(new CliError("Aborted."));
            });
            break;
          case "\u0004":
            finish(() => reject(new CliError("Input ended. Re-run the command interactively to continue.")));
            break;
          case "\u007F":
          case "\b":
            buf.pop();
            break;
          default:
            buf.push(ch);
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("close", onEnd);
    process.stdin.once("SIGINT", onSigint);
    process.stderr.write(prompt);
    process.stdin.resume();
  });
}

async function gql(
  graphqlEndpoint: string,
  auth: CliAuth,
  query: string,
  variables?: Record<string, any>,
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `affine-mcp-server/${VERSION}`,
    ...(auth.headers || {}),
  };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "x-affine-version")) {
    headers["x-affine-version"] = AFFINE_CLIENT_VERSION;
  }
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.Cookie = auth.cookie;
  const body: any = { query };
  if (variables) body.variables = variables;

  const { response: res, body: responseBody } = await fetchResponseBody(
    signal => fetch(graphqlEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    }),
    { label: "Request", timeoutMs: CLI_FETCH_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(responseBody) as any;
  if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json.data;
}

function parseFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function consumeOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for '${flag}'.`);
  }
  args.splice(index, 2);
  return value;
}

function consumeFlags(args: string[], ...flags: string[]): boolean {
  let found = false;
  for (const flag of flags) {
    let index = args.indexOf(flag);
    while (index !== -1) {
      args.splice(index, 1);
      found = true;
      index = args.indexOf(flag);
    }
  }
  return found;
}

function ensureNoUnexpectedArgs(args: string[], command: string): void {
  if (args.length > 0) {
    throw new CliError(`Unexpected arguments for '${command}': ${args.join(" ")}`);
  }
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function buildCodexEnvironmentArguments(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => `--env ${quotePosixShellArgument(`${key}=${value}`)}`)
    .join(" ");
}

function redactSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function getConfigValueSource(name: string, file: Record<string, string>, fallback?: string): "env" | "config" | "default" | "unset" {
  if (process.env[name]) return "env";
  if (file[name]) return "config";
  if (fallback !== undefined) return "default";
  return "unset";
}

function getEffectiveAuthValueSource(
  name: string,
  value: string | undefined,
  file: Record<string, string>,
  fallback?: ConfiguredAuthSource,
): "env" | "config" | "unset" {
  if (!value) return "unset";
  if (fallback === "env" || fallback === "config") return fallback;
  return process.env[name] ? "env" : file[name] ? "config" : "unset";
}

function buildEffectiveConfigSummary(effective: ServerConfig = loadConfig()) {
  const stored = loadConfigFile();
  const auth = resolveConfiguredAuth(effective);
  const authKind: ConfiguredAuthKind = auth.kind;

  return {
    configFile: CONFIG_FILE,
    configFileExists: fs.existsSync(CONFIG_FILE),
    baseUrl: effective.baseUrl,
    graphqlPath: effective.graphqlPath,
    graphqlEndpoint: effective.graphqlEndpoint,
    additionalHeadersConfigured: Boolean(process.env.AFFINE_HEADERS_JSON || stored.AFFINE_HEADERS_JSON),
    workspaceId: effective.defaultWorkspaceId || null,
    authMode: effective.authMode,
    authKind,
    apiToken: auth.apiToken ? redactSecret(auth.apiToken) : null,
    cookie: auth.cookie ? "(set)" : null,
    email: auth.email || null,
    publicBaseUrl: effective.publicBaseUrl || null,
    oauthIssuerUrl: effective.oauthIssuerUrl || null,
    oauthScopes: effective.oauthScopes,
    oauthClockSkewSeconds: effective.oauthClockSkewSeconds,
    transportMode: effective.transportMode,
    loginAtStart: effective.loginAtStart,
    http: {
      host: effective.http.host,
      port: effective.http.port,
      authToken: effective.http.authToken ? redactSecret(effective.http.authToken) : null,
      allowedOrigins: effective.http.allowedOrigins,
      allowAllOrigins: effective.http.allowAllOrigins,
    },
    sources: {
      baseUrl: getConfigValueSource("AFFINE_BASE_URL", stored, "http://localhost:3010"),
      graphqlPath: getConfigValueSource("AFFINE_GRAPHQL_PATH", stored, "/graphql"),
      additionalHeaders: getConfigValueSource("AFFINE_HEADERS_JSON", stored),
      apiToken: getEffectiveAuthValueSource("AFFINE_API_TOKEN", auth.apiToken, stored, effective.authSource),
      cookie: getEffectiveAuthValueSource("AFFINE_COOKIE", auth.cookie, stored, effective.authSource),
      email: getEffectiveAuthValueSource("AFFINE_EMAIL", auth.email, stored, effective.authSource),
      password: getEffectiveAuthValueSource("AFFINE_PASSWORD", auth.password, stored, effective.authSource),
      workspaceId: getConfigValueSource("AFFINE_WORKSPACE_ID", stored),
      authMode: getConfigValueSource("AFFINE_MCP_AUTH_MODE", stored, "bearer"),
      publicBaseUrl: getConfigValueSource("AFFINE_MCP_PUBLIC_BASE_URL", stored),
      oauthIssuerUrl: getConfigValueSource("AFFINE_OAUTH_ISSUER_URL", stored),
      oauthScopes: getConfigValueSource("AFFINE_OAUTH_SCOPES", stored, "mcp"),
      oauthClockSkewSeconds: getConfigValueSource("AFFINE_OAUTH_CLOCK_SKEW_SECONDS", stored, "60"),
      transportMode: getConfigValueSource("MCP_TRANSPORT", stored, "stdio"),
      loginAtStart: getConfigValueSource("AFFINE_LOGIN_AT_START", stored, "async"),
      httpHost: getConfigValueSource("AFFINE_MCP_HTTP_HOST", stored, "127.0.0.1"),
      httpPort: getConfigValueSource("PORT", stored, "3000"),
      httpAuthToken: getConfigValueSource("AFFINE_MCP_HTTP_TOKEN", stored),
      httpAllowedOrigins: getConfigValueSource("AFFINE_MCP_HTTP_ALLOWED_ORIGINS", stored),
      httpAllowAllOrigins: getConfigValueSource("AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS", stored, "false"),
    },
  };
}

function parseConfiguredHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") headers[name] = value;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  } catch {
    return undefined;
  }
}

function getEffectiveConfiguredHeaders(stored: Record<string, string>): Record<string, string> | undefined {
  return withoutAuthenticationHeaders(
    parseConfiguredHeaders(process.env.AFFINE_HEADERS_JSON || stored.AFFINE_HEADERS_JSON),
  );
}

function stripAuthenticationHeadersFromConfig(config: Record<string, string>): Record<string, string> {
  const headers = parseConfiguredHeaders(config.AFFINE_HEADERS_JSON);
  if (!headers || !hasAuthenticationHeader(headers)) return config;
  const retainedHeaders = withoutAuthenticationHeaders(headers);
  const sanitized = { ...config };
  if (retainedHeaders) {
    sanitized.AFFINE_HEADERS_JSON = JSON.stringify(retainedHeaders);
  } else {
    delete sanitized.AFFINE_HEADERS_JSON;
  }
  return sanitized;
}

function workspaceUrl(baseUrl: string, workspaceId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}`;
}

function workspaceDisplayName(workspace: WorkspaceRecord): string {
  const name = workspace.name?.trim();
  if (name) return name;
  return "Workspace name unavailable";
}

function formatWorkspaceMetadata(workspace: WorkspaceRecord): string {
  const metadata: string[] = [];
  if (workspace.owner?.name) metadata.push(`owner: ${workspace.owner.name}`);
  if (workspace.memberCount !== undefined && workspace.memberCount !== null) {
    metadata.push(`${workspace.memberCount} member${workspace.memberCount === 1 ? "" : "s"}`);
  }
  if (workspace.createdAt) {
    const date = new Date(workspace.createdAt);
    if (!Number.isNaN(date.valueOf())) metadata.push(`created ${date.toLocaleDateString()}`);
  }
  return metadata.length > 0 ? ` (${metadata.join(", ")})` : "";
}

function describeWorkspace(workspace: WorkspaceRecord, baseUrl: string): WorkspaceSelection {
  return {
    ...workspace,
    displayName: workspaceDisplayName(workspace),
    url: workspaceUrl(baseUrl, workspace.id),
  };
}

function serializeWorkspace(
  workspace: WorkspaceRecord,
  baseUrl: string,
  defaultWorkspaceId?: string,
) {
  const described = describeWorkspace(workspace, baseUrl);
  return {
    id: described.id,
    name: workspace.name || null,
    displayName: described.displayName,
    avatar: workspace.avatar || null,
    url: described.url,
    owner: workspace.owner?.name || null,
    memberCount: workspace.memberCount ?? null,
    createdAt: workspace.createdAt || null,
    profileStatus: workspace.profileStatus || "skipped",
    isDefault: Boolean(defaultWorkspaceId && workspace.id === defaultWorkspaceId),
  };
}

function actionableCliError(error: unknown, context: string): CliError {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message ? ` Details: ${message}` : "";
  if (/(?:http|status|sign-in failed|graphql http)\s*[: ]?\s*401\b|unauthenticated|authentication required|session expired|invalid token/i.test(message)) {
    return new CliError(
      `${context}: authentication was rejected. Run 'affine-mcp login' and restart or reconnect the MCP client. ` +
      `If the client copied AFFINE_COOKIE or another credential, remove or refresh that copied value.${detail}`,
    );
  }
  if (/(?:http|status|sign-in failed|graphql http)\s*[: ]?\s*403\b|forbidden|access denied|permission denied/i.test(message)) {
    return new CliError(
      `${context}: the authenticated account does not have access. Run 'affine-mcp workspaces' to confirm membership, ` +
      `then choose a workspace where the account has permission.${detail}`,
    );
  }
  if (/fetch failed|econnrefused|enotfound|timeout|timed out|(?:http|status|failed:)\s*5\d\d|upstream/i.test(message)) {
    return new CliError(
      `${context}: could not reach AFFiNE. Check the URL with 'affine-mcp show-config' and run 'affine-mcp doctor'. ` +
      `Details: ${message}`,
    );
  }
  return new CliError(`${context}: ${message}`);
}

async function discoverWorkspaces(
  graphqlEndpoint: string,
  auth: CliAuth,
  includeProfiles = true,
): Promise<WorkspaceDiscovery> {
  let data: any;
  try {
    data = await gql(graphqlEndpoint, auth, `query {
      workspaces {
        id createdAt memberCount
        owner { name }
      }
    }`);
  } catch (error) {
    throw actionableCliError(error, "Workspace discovery failed");
  }

  const workspaces: WorkspaceRecord[] = Array.isArray(data?.workspaces)
    ? data.workspaces.filter((workspace: any) => typeof workspace?.id === "string")
    : [];
  if (!includeProfiles || workspaces.length === 0) {
    return { workspaces: workspaces.map(workspace => ({ ...workspace, profileStatus: "skipped" })) };
  }

  let socket: WorkspaceSocket;
  try {
    socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(graphqlEndpoint), auth.cookie, auth.token);
  } catch (error) {
    return {
      workspaces: workspaces.map(workspace => ({ ...workspace, profileStatus: "unavailable" })),
      profileError: error instanceof Error ? error.message : String(error),
    };
  }

  const enriched: WorkspaceRecord[] = [];
  try {
    for (const workspace of workspaces) {
      try {
        const profile = await readWorkspaceProfile(socket, workspace.id);
        enriched.push({
          ...workspace,
          name: profile.name || workspace.name || null,
          avatar: profile.avatar || workspace.avatar || null,
          profileStatus: "available",
        });
      } catch {
        enriched.push({ ...workspace, profileStatus: "unavailable" });
      }
    }
  } finally {
    socket.disconnect();
  }
  return {
    workspaces: enriched,
    profileError: enriched.some(workspace => workspace.profileStatus !== "available")
      ? "Some workspace names could not be read from realtime metadata."
      : undefined,
  };
}

async function resolveCliAuth(effective: ServerConfig): Promise<{ auth: CliAuth; authKind: string }> {
  const configured = resolveConfiguredAuth(effective);
  if (configured.apiToken) {
    return {
      auth: { token: configured.apiToken, headers: configured.headers },
      authKind: "api-token",
    };
  }
  if (configured.cookie) {
    return {
      auth: { cookie: configured.cookie, headers: configured.headers },
      authKind: "cookie",
    };
  }
  if (configured.email && configured.password) {
    const { cookieHeader } = await loginWithPassword(
      effective.baseUrl,
      configured.email,
      configured.password,
      configured.headers,
    );
    return {
      auth: { cookie: cookieHeader, headers: configured.headers },
      authKind: "email-password",
    };
  }
  throw new CliError(
    "No authentication configured. Run 'affine-mcp login' or set AFFINE_EMAIL and AFFINE_PASSWORD, " +
    "AFFINE_COOKIE, or a compatible AFFINE_API_TOKEN.",
  );
}

async function inspectConnection(graphqlEndpoint: string, auth: CliAuth): Promise<ConnectionInspection> {
  const data = await gql(
    graphqlEndpoint,
    auth,
    "query { currentUser { name email } workspaces { id } }",
  );
  return {
    userName: data.currentUser.name,
    userEmail: data.currentUser.email,
    workspaceCount: data.workspaces.length,
  };
}

function printHelp(command?: string) {
  if (command) {
    const definition = COMMANDS[command];
    if (!definition) {
      throw new CliError(`Unknown command '${command}'.`);
    }
    console.log(`${definition.usage}\n`);
    console.log(definition.summary);
    return;
  }

  console.log(`affine-mcp ${VERSION}`);
  console.log("");
  console.log("Usage:");
  console.log("  affine-mcp                 Start the MCP server over stdio");
  console.log("  affine-mcp <command>       Run a CLI command");
  console.log("");
  console.log("Commands:");
  for (const [name, definition] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${definition.summary}`);
  }
  console.log("");
  console.log("Common examples:");
  console.log("  affine-mcp login");
  console.log("  affine-mcp workspaces");
  console.log("  affine-mcp workspace [workspace-id]");
  console.log("  affine-mcp status");
  console.log("  affine-mcp doctor");
  console.log("  affine-mcp show-config --json");
  console.log("  affine-mcp snippet claude");
  console.log("  affine-mcp --version");
  console.log("  affine-mcp --help");
}

async function detectWorkspace(
  graphqlEndpoint: string,
  baseUrl: string,
  auth: CliAuth,
  preferredWorkspaceId?: string,
): Promise<WorkspaceSelection> {
  console.error(preferredWorkspaceId ? "Validating workspace membership..." : "Discovering workspaces...");
  const discovery = await discoverWorkspaces(graphqlEndpoint, auth);
  const workspaces = discovery.workspaces;
  if (workspaces.length === 0) {
    throw new CliError(
      "No workspaces are available to this account. Credentials were not saved. " +
      "Confirm the account has workspace membership, then run 'affine-mcp login' again.",
    );
  }
  if (discovery.profileError) {
    console.error(`  Warning: ${discovery.profileError}`);
    console.error("  Continuing with workspace IDs and direct URLs as a fallback.");
  }

  if (preferredWorkspaceId) {
    const preferredWorkspace = workspaces.find(workspace => workspace.id === preferredWorkspaceId);
    if (!preferredWorkspace) {
      throw new CliError(`Workspace '${preferredWorkspaceId}' is not available to the authenticated account.`);
    }
    const selected = describeWorkspace(preferredWorkspace, baseUrl);
    console.error(`  Verified workspace: ${selected.displayName} (${selected.id})`);
    console.error(`  Open in AFFiNE: ${selected.url}`);
    return selected;
  }

  console.error(
    "The selected workspace becomes the default scope for MCP calls that omit workspaceId. " +
    "It does not remove access to your other workspaces.",
  );
  if (workspaces.length === 1) {
    const selected = describeWorkspace(workspaces[0], baseUrl);
    console.error(`  Found 1 workspace: ${selected.displayName} (${selected.id})`);
    console.error(`  Open in AFFiNE: ${selected.url}`);
    console.error("  Auto-selected because it is the only available workspace.");
    return selected;
  }

  console.error(`Found ${workspaces.length} workspaces:`);
  workspaces.forEach((workspace, index) => {
    const selected = describeWorkspace(workspace, baseUrl);
    console.error(
      `  ${index + 1}) ${selected.displayName} — ${selected.id}${formatWorkspaceMetadata(workspace)}`,
    );
    console.error(`     ${selected.url}`);
    if (!workspace.name) console.error("     Workspace name unavailable; use the URL or ID to identify it.");
  });

  while (true) {
    const choice = await ask(`\nSelect a workspace [1-${workspaces.length}, q to cancel]: `);
    if (/^q$/i.test(choice)) {
      throw new CliError("Workspace selection cancelled. Credentials were not saved.");
    }
    if (!/^\d+$/.test(choice)) {
      console.error(`Enter a number from 1 to ${workspaces.length}, or q to cancel.`);
      continue;
    }
    const index = Number(choice) - 1;
    if (index < 0 || index >= workspaces.length) {
      console.error(`Selection must be between 1 and ${workspaces.length}.`);
      continue;
    }
    return describeWorkspace(workspaces[index], baseUrl);
  }
}

async function askAuthMethod(prompt: string, choices: string[]): Promise<string> {
  while (true) {
    const choice = await ask(prompt);
    if (/^q$/i.test(choice)) throw new CliError("Authentication method selection cancelled. Credentials were not saved.");
    if (choices.includes(choice)) return choice;
    console.error(`Choose one of ${choices.join(", ")}, or q to cancel.`);
  }
}

function printEnvironmentOverrideWarnings(selectedBaseUrl: string, selectedWorkspaceId: string): void {
  const overridden: string[] = [];
  if (process.env.AFFINE_BASE_URL) {
    overridden.push(
      `AFFINE_BASE_URL is set, so the saved URL is not effective. Next step: unset AFFINE_BASE_URL ` +
      `or update it to ${selectedBaseUrl}, then restart or reconnect the MCP client.`,
    );
  }
  if (process.env.AFFINE_GRAPHQL_PATH) {
    overridden.push(
      `AFFINE_GRAPHQL_PATH is set, so the saved GraphQL path is not effective. Next step: unset AFFINE_GRAPHQL_PATH ` +
      "or set it to the path used during login, then restart or reconnect the MCP client.",
    );
  }
  if (process.env.AFFINE_WORKSPACE_ID) {
    overridden.push(
      `AFFINE_WORKSPACE_ID is set to ${process.env.AFFINE_WORKSPACE_ID}, so the saved workspace is not effective. ` +
      `Next step: unset AFFINE_WORKSPACE_ID, then run 'affine-mcp workspace ${selectedWorkspaceId}' and restart the MCP client.`,
    );
  }
  const authOverrides = [
    "AFFINE_API_TOKEN",
    "AFFINE_COOKIE",
    "AFFINE_EMAIL",
    "AFFINE_PASSWORD",
  ].filter(name => Boolean(process.env[name]));
  if (hasAuthenticationHeader(parseConfiguredHeaders(process.env.AFFINE_HEADERS_JSON))) {
    authOverrides.push("AFFINE_HEADERS_JSON");
  }
  if (authOverrides.length > 0) {
    overridden.push(
      `${authOverrides.join(", ")} override saved credentials. Next step: remove or refresh these environment values ` +
      "and restart or reconnect the MCP client after re-login.",
    );
  }
  if (overridden.length > 0) {
    console.error("\nWarning: saved login settings were written, but environment variables still take precedence:");
    overridden.forEach(message => console.error(`  - ${message}`));
  }
}

async function loginWithEmail(
  baseUrl: string,
  graphqlEndpoint: string,
  preferredWorkspaceId?: string,
  headers?: Record<string, string>,
): Promise<LoginResult> {
  const email = await ask("Email: ");
  const password = await ask("Password: ", true);
  if (!email || !password) {
    throw new CliError("Email and password are required.");
  }

  console.error("Signing in...");
  let cookieHeader: string;
  try {
    ({ cookieHeader } = await loginWithPassword(baseUrl, email, password, headers));
  } catch (err: any) {
    throw actionableCliError(err, "Sign-in failed");
  }

  const auth = { cookie: cookieHeader, headers };
  try {
    const data = await gql(graphqlEndpoint, auth, "query { currentUser { name email } }");
    console.error(`✓ Signed in as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw actionableCliError(err, "Session verification failed");
  }

  const workspace = await detectWorkspace(graphqlEndpoint, baseUrl, auth, preferredWorkspaceId);
  return {
    cookie: cookieHeader,
    workspaceId: workspace.id,
    workspaceName: workspace.displayName,
    workspaceUrl: workspace.url,
  };
}

async function loginWithToken(
  graphqlEndpoint: string,
  baseUrl: string,
  preferredWorkspaceId?: string,
  headers?: Record<string, string>,
): Promise<LoginResult> {
  console.error(
    "\nAFFiNE 0.27+ no longer provides legacy personal access tokens. " +
    "Only use this option when your target deployment still accepts a compatible GraphQL bearer token.\n",
  );

  const token = await ask("Compatible API token: ", true);
  if (!token) {
    throw new CliError("No token provided.");
  }

  console.error("Testing connection...");
  try {
    const data = await gql(graphqlEndpoint, { token, headers }, "query { currentUser { name email } }");
    console.error(`✓ Authenticated as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw actionableCliError(err, "Authentication failed");
  }

  const workspace = await detectWorkspace(graphqlEndpoint, baseUrl, { token, headers }, preferredWorkspaceId);
  return {
    token,
    workspaceId: workspace.id,
    workspaceName: workspace.displayName,
    workspaceUrl: workspace.url,
  };
}

async function loginWithCookie(
  baseUrl: string,
  graphqlEndpoint: string,
  preferredWorkspaceId?: string,
  headers?: Record<string, string>,
): Promise<LoginResult> {
  console.error("\nTo use an existing browser session:");
  console.error(`  1. Sign in to ${baseUrl}`);
  console.error("  2. Open browser developer tools and inspect a request to /graphql");
  console.error("  3. Copy the complete Cookie request header value\n");

  const cookie = await ask("Session cookie: ", true);
  if (!cookie) {
    throw new CliError("No session cookie provided.");
  }

  console.error("Testing connection...");
  try {
    const data = await gql(graphqlEndpoint, { cookie, headers }, "query { currentUser { name email } }");
    console.error(`✓ Authenticated as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw actionableCliError(err, "Authentication failed");
  }

  const workspace = await detectWorkspace(graphqlEndpoint, baseUrl, { cookie, headers }, preferredWorkspaceId);
  return {
    cookie,
    workspaceId: workspace.id,
    workspaceName: workspace.displayName,
    workspaceUrl: workspace.url,
  };
}

async function login(args: string[]) {
  if (args.some((arg) => arg === "--cookie" || arg.startsWith("--cookie="))) {
    throw new CliError(
      "The --cookie option is not accepted because command-line arguments may be visible to other processes. Use --cookie-stdin instead.",
    );
  }
  const parsedArgs = [...args];
  const providedUrl = consumeOption(parsedArgs, "--url");
  const providedGraphqlPath = consumeOption(parsedArgs, "--graphql-path");
  const providedToken = consumeOption(parsedArgs, "--token");
  const useCookieStdin = consumeFlags(parsedArgs, "--cookie-stdin");
  const providedWorkspaceId = consumeOption(parsedArgs, "--workspace-id");
  const force = consumeFlags(parsedArgs, "--force", "-f");
  ensureNoUnexpectedArgs(parsedArgs, "login");
  if (providedToken && useCookieStdin) {
    throw new CliError("Use either --token or --cookie-stdin, not both.");
  }
  const nonInteractiveCookieStdin = useCookieStdin && process.stdin.isTTY !== true;

  console.error("Affine MCP Server — Login\n");

  const existing = loadConfigFile();
  const configuredHeaders = getEffectiveConfiguredHeaders(existing);
  const hasExistingAuth = Boolean(
    existing.AFFINE_API_TOKEN ||
    existing.AFFINE_COOKIE ||
    (existing.AFFINE_EMAIL && existing.AFFINE_PASSWORD) ||
    hasAuthenticationHeader(parseConfiguredHeaders(existing.AFFINE_HEADERS_JSON)),
  );
  if (hasExistingAuth) {
    console.error(`Existing config: ${CONFIG_FILE}`);
    console.error(`  URL:       ${existing.AFFINE_BASE_URL || "(default)"}`);
    console.error("  Auth:      (set)");
    console.error(`  Workspace: ${existing.AFFINE_WORKSPACE_ID || "(none)"}\n`);
    if (!force) {
      if (nonInteractiveCookieStdin) {
        throw new CliError("--force is required when --cookie-stdin would overwrite existing credentials.");
      }
      const overwrite = await ask("Overwrite? [y/N] ");
      if (!/^[yY]$/.test(overwrite)) {
        console.error("Keeping existing config.");
        return;
      }
      console.error("");
    } else {
      console.error("Overwriting existing config (--force).\n");
    }
  }

  const pipedCookie = nonInteractiveCookieStdin ? await ask("", true) : undefined;
  const defaultUrl = "https://app.affine.pro";
  const configuredUrl = process.env.AFFINE_BASE_URL || existing.AFFINE_BASE_URL || defaultUrl;
  const rawUrl = providedUrl ?? (
    nonInteractiveCookieStdin
      ? configuredUrl
      : (await ask(`Affine URL [${configuredUrl}]: `)) || configuredUrl
  );
  const baseUrl = validateBaseUrl(rawUrl, {
    allowInsecureHttp: parseBooleanFlag(
      "AFFINE_ALLOW_INSECURE_HTTP",
      process.env.AFFINE_ALLOW_INSECURE_HTTP,
    ),
    insecureHttpOptInName: "AFFINE_ALLOW_INSECURE_HTTP",
    label: "AFFINE URL",
  });
  const graphqlPath = validateGraphqlPath(
    providedGraphqlPath || process.env.AFFINE_GRAPHQL_PATH || existing.AFFINE_GRAPHQL_PATH || "/graphql",
  );
  const graphqlEndpoint = buildGraphqlEndpoint(baseUrl, graphqlPath);
  const providedCookie = nonInteractiveCookieStdin
    ? pipedCookie
    : useCookieStdin
      ? await ask("Session cookie: ", true)
      : undefined;
  if (useCookieStdin && !providedCookie) {
    throw new CliError("No session cookie received on stdin.");
  }

  let result: LoginResult;

  if (providedToken) {
    console.error("Testing provided token...");
    try {
      const info = await inspectConnection(graphqlEndpoint, { token: providedToken, headers: configuredHeaders });
      console.error(`✓ Authenticated as: ${info.userName} <${info.userEmail}>\n`);
    } catch (err: any) {
      throw actionableCliError(err, "Authentication failed");
    }
    const auth = { token: providedToken, headers: configuredHeaders };
    const workspace = await detectWorkspace(graphqlEndpoint, baseUrl, auth, providedWorkspaceId);
    result = {
      token: providedToken,
      workspaceId: workspace.id,
      workspaceName: workspace.displayName,
      workspaceUrl: workspace.url,
    };
  } else if (providedCookie) {
    console.error("Testing provided session cookie...");
    try {
      const info = await inspectConnection(graphqlEndpoint, { cookie: providedCookie, headers: configuredHeaders });
      console.error(`✓ Authenticated as: ${info.userName} <${info.userEmail}>\n`);
    } catch (err: any) {
      throw actionableCliError(err, "Authentication failed");
    }
    const auth = { cookie: providedCookie, headers: configuredHeaders };
    const workspace = await detectWorkspace(graphqlEndpoint, baseUrl, auth, providedWorkspaceId);
    result = {
      cookie: providedCookie,
      workspaceId: workspace.id,
      workspaceName: workspace.displayName,
      workspaceUrl: workspace.url,
    };
  } else {
    const isSelfHosted = !baseUrl.includes("affine.pro");
    if (isSelfHosted) {
      const method = await askAuthMethod(
        "\nAuth method — [1] Email/password (recommended)  [2] Paste session cookie  [3] Compatible API token: ",
        ["1", "2", "3"],
      );
      const loginResult = method === "2"
        ? await loginWithCookie(baseUrl, graphqlEndpoint, providedWorkspaceId, configuredHeaders)
        : method === "3"
          ? await loginWithToken(graphqlEndpoint, baseUrl, providedWorkspaceId, configuredHeaders)
          : await loginWithEmail(baseUrl, graphqlEndpoint, providedWorkspaceId, configuredHeaders);
      result = loginResult;
    } else {
      const method = await askAuthMethod(
        "\nAuth method — [1] Paste session cookie (recommended)  [2] Compatible API token: ",
        ["1", "2"],
      );
      const loginResult = method === "2"
        ? await loginWithToken(graphqlEndpoint, baseUrl, providedWorkspaceId, configuredHeaders)
        : await loginWithCookie(baseUrl, graphqlEndpoint, providedWorkspaceId, configuredHeaders);
      result = loginResult;
    }
  }

  writeConfigFile(stripAuthenticationHeadersFromConfig({
    ...existing,
    AFFINE_BASE_URL: baseUrl,
    AFFINE_GRAPHQL_PATH: graphqlPath === "/graphql" ? "" : graphqlPath,
    AFFINE_API_TOKEN: result.token || "",
    AFFINE_COOKIE: result.cookie || "",
    AFFINE_EMAIL: "",
    AFFINE_PASSWORD: "",
    AFFINE_WORKSPACE_ID: result.workspaceId,
  }));

  console.error(`\n✓ Saved to ${CONFIG_FILE} (mode 600)`);
  console.error(`Selected workspace: ${result.workspaceName} (${result.workspaceId})`);
  console.error(`Open in AFFiNE: ${result.workspaceUrl}`);
  console.error("The selected workspace is the default scope when an MCP call omits workspaceId.");
  console.error("Next steps: run 'affine-mcp status' to verify the account, then 'affine-mcp doctor' to verify realtime access.");
  console.error("Generate client setup with 'affine-mcp snippet codex' (or claude/cursor), then apply it.");
  console.error("Restart or reconnect your MCP client so it reloads the saved credentials and workspace.");
  printEnvironmentOverrideWarnings(baseUrl, result.workspaceId);
}

async function listWorkspaces(args: string[]) {
  const parsedArgs = [...args];
  const asJson = consumeFlags(parsedArgs, "--json");
  ensureNoUnexpectedArgs(parsedArgs, "workspaces");

  const effective = loadConfig();
  let auth: CliAuth;
  try {
    ({ auth } = await resolveCliAuth(effective));
  } catch (error) {
    throw actionableCliError(error, "Workspace listing failed");
  }

  const discovery = await discoverWorkspaces(effective.graphqlEndpoint, auth);
  const items = discovery.workspaces.map(workspace => serializeWorkspace(
    workspace,
    effective.baseUrl,
    effective.defaultWorkspaceId,
  ));
  if (asJson) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  console.log(
    "The default workspace is used when an MCP call omits workspaceId. " +
    "It does not limit your account to that workspace.",
  );
  if (effective.defaultWorkspaceId) {
    const current = items.find(workspace => workspace.isDefault);
    console.log(
      current
        ? `Default workspace: ${current.displayName} (${current.id})`
        : `Default workspace: ${effective.defaultWorkspaceId} (not available to this account)`,
    );
  } else {
    console.log("Default workspace: (none selected)");
    console.log("Run 'affine-mcp workspace <id>' after this list to choose one.");
  }
  console.log("");
  if (items.length === 0) {
    console.log("No workspaces are available to this account.");
    return;
  }
  items.forEach((workspace, index) => {
    console.log(
      `${index + 1}) ${workspace.displayName}${workspace.isDefault ? " [default]" : ""} — ${workspace.id}`,
    );
    console.log(`   ${workspace.url}`);
    if (workspace.owner || workspace.memberCount !== null) {
      const metadata = [
        workspace.owner ? `owner: ${workspace.owner}` : "",
        workspace.memberCount === null ? "" : `${workspace.memberCount} member${workspace.memberCount === 1 ? "" : "s"}`,
      ].filter(Boolean).join(", ");
      if (metadata) console.log(`   ${metadata}`);
    }
    if (!workspace.name) console.log("   Workspace name unavailable; the ID and URL are the fallback identifiers.");
  });
  if (discovery.profileError) {
    console.error(`Warning: ${discovery.profileError}`);
    console.error("Workspace membership was verified through GraphQL; names may be fallback labels.");
  }
}

async function switchWorkspace(args: string[]) {
  const parsedArgs = [...args];
  const asJson = consumeFlags(parsedArgs, "--json");
  const workspaceId = parsedArgs.shift();
  ensureNoUnexpectedArgs(parsedArgs, "workspace");

  const effective = loadConfig();
  let auth: CliAuth;
  try {
    ({ auth } = await resolveCliAuth(effective));
  } catch (error) {
    throw actionableCliError(error, "Workspace switch failed");
  }

  let discovery: WorkspaceDiscovery | undefined;
  let selected: WorkspaceSelection;
  if (workspaceId) {
    discovery = await discoverWorkspaces(effective.graphqlEndpoint, auth);
    const match = discovery.workspaces.find(workspace => workspace.id === workspaceId);
    if (!match) {
      throw new CliError(
        `Workspace '${workspaceId}' is not available to the authenticated account. ` +
        "No config was changed.",
      );
    }
    selected = describeWorkspace(match, effective.baseUrl);
  } else {
    selected = await detectWorkspace(effective.graphqlEndpoint, effective.baseUrl, auth);
  }
  if (process.env.AFFINE_WORKSPACE_ID) {
    throw new CliError(
      `Workspace membership verified for ${selected.displayName} (${selected.id}), but AFFINE_WORKSPACE_ID ` +
      `is set to ${process.env.AFFINE_WORKSPACE_ID}, so it overrides saved config. ` +
      `Next step: unset AFFINE_WORKSPACE_ID, then run 'affine-mcp workspace ${selected.id}' again. No config was changed.`,
    );
  }

  const stored = loadConfigFile();
  const storedAuth = Boolean(
    stored.AFFINE_API_TOKEN
    || stored.AFFINE_COOKIE
    || stored.AFFINE_EMAIL
    || stored.AFFINE_PASSWORD
    || hasAuthenticationHeader(parseConfiguredHeaders(stored.AFFINE_HEADERS_JSON)),
  );
  if (stored.AFFINE_BASE_URL && stored.AFFINE_BASE_URL !== effective.baseUrl) {
    throw new CliError(
      `Workspace membership was verified at ${effective.baseUrl}, but saved config targets ${stored.AFFINE_BASE_URL}. ` +
      "No config was changed. Next step: run 'affine-mcp login --url <url>' for the account you want to save, " +
      "or set AFFINE_WORKSPACE_ID in the MCP client's environment.",
    );
  }
  if (effective.authSource === "env" && storedAuth) {
    throw new CliError(
      "Workspace membership was verified with environment credentials, but saved config contains another credential source. " +
      "No config was changed. Next step: run 'affine-mcp login' after removing the environment credentials, " +
      "or set AFFINE_WORKSPACE_ID in the MCP client's environment.",
    );
  }
  writeConfigFile({ ...stored, AFFINE_WORKSPACE_ID: selected.id });
  if (asJson) {
    console.log(JSON.stringify({
      saved: true,
      workspace: serializeWorkspace(selected, effective.baseUrl, selected.id),
      configFile: CONFIG_FILE,
    }, null, 2));
  } else {
    console.error(`✓ Default workspace changed to ${selected.displayName} (${selected.id})`);
    console.error(`Open in AFFiNE: ${selected.url}`);
    console.error("Restart or reconnect your MCP client so it reloads the selected workspace.");
    if (discovery?.profileError) console.error(`Warning: ${discovery.profileError}`);
  }
}

async function status(args: string[]) {
  const parsedArgs = [...args];
  const asJson = consumeFlags(parsedArgs, "--json");
  ensureNoUnexpectedArgs(parsedArgs, "status");
  const effective = loadConfig();
  const summary = buildEffectiveConfigSummary(effective);
  try {
    const { auth, authKind } = await resolveCliAuth(effective);
    const inspection = await inspectConnection(effective.graphqlEndpoint, auth);
    let selectedWorkspace: WorkspaceSelection | undefined;
    let workspaceMembership: "member" | "missing" | "unknown" | null = null;
    let workspaceDiscoveryError: string | undefined;
    if (effective.defaultWorkspaceId) {
      try {
        const discovery = await discoverWorkspaces(effective.graphqlEndpoint, auth);
        const match = discovery.workspaces.find(workspace => workspace.id === effective.defaultWorkspaceId);
        if (match) {
          selectedWorkspace = describeWorkspace(match, effective.baseUrl);
          workspaceMembership = "member";
        } else {
          workspaceMembership = "missing";
        }
        workspaceDiscoveryError = discovery.profileError;
      } catch (error) {
        workspaceMembership = "unknown";
        workspaceDiscoveryError = error instanceof Error ? error.message : String(error);
      }
    }
    if (asJson) {
      console.log(JSON.stringify({
        configFile: CONFIG_FILE,
        configFileExists: summary.configFileExists,
        baseUrl: effective.baseUrl,
        baseUrlSource: summary.sources.baseUrl,
        graphqlEndpoint: effective.graphqlEndpoint,
        workspaceId: effective.defaultWorkspaceId || null,
        workspaceIdSource: summary.sources.workspaceId,
        authKind,
        userName: inspection.userName,
        userEmail: inspection.userEmail,
        workspaceCount: inspection.workspaceCount,
        workspaceName: selectedWorkspace?.displayName || null,
        workspaceUrl: selectedWorkspace?.url || null,
        workspaceMembership,
        workspaceDiscoveryError: workspaceDiscoveryError || null,
      }, null, 2));
      return;
    }

    console.error(`Config: ${CONFIG_FILE} (${summary.configFileExists ? "found" : "not used"})`);
    console.error(`URL:       ${effective.baseUrl} (${summary.sources.baseUrl})`);
    console.error(`GraphQL:   ${effective.graphqlEndpoint}`);
    console.error(`Auth:      ${authKind}`);
    if (selectedWorkspace) {
      console.error(`Workspace: ${selectedWorkspace.displayName} (${selectedWorkspace.id})`);
      console.error(`Workspace URL: ${selectedWorkspace.url}`);
    } else {
      console.error(`Workspace: ${effective.defaultWorkspaceId || "(none)"}`);
    }
    console.error(`Workspace membership: ${workspaceMembership || "not selected"}`);
    if (summary.sources.workspaceId === "env") {
      console.error("Workspace source: environment override. Next step: unset AFFINE_WORKSPACE_ID to use saved config.");
    }
    if (workspaceDiscoveryError) console.error(`Workspace metadata: ${workspaceDiscoveryError}`);
    console.error("");
    console.error(`User: ${inspection.userName} <${inspection.userEmail}>`);
    console.error(`Workspaces: ${inspection.workspaceCount}`);
  } catch (err: any) {
    throw actionableCliError(err, "Connection failed");
  }
}

function logout(args: string[]) {
  ensureNoUnexpectedArgs(args, "logout");
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("No config file found.");
    return;
  }

  const stored = loadConfigFile();
  const credentialKeys = ["AFFINE_API_TOKEN", "AFFINE_COOKIE", "AFFINE_EMAIL", "AFFINE_PASSWORD"];
  let removed = credentialKeys.some((key) => Boolean(stored[key]));
  for (const key of credentialKeys) delete stored[key];

  const rawHeaders = stored.AFFINE_HEADERS_JSON;
  if (rawHeaders) {
    try {
      const parsedHeaders = JSON.parse(rawHeaders);
      if (parsedHeaders && typeof parsedHeaders === "object" && !Array.isArray(parsedHeaders)) {
        const headerEntries = Object.entries(parsedHeaders as Record<string, unknown>);
        const retainedHeaders = headerEntries.filter(
          ([name]) => !/^(authorization|cookie)$/i.test(name),
        );
        if (retainedHeaders.length !== headerEntries.length) {
          removed = true;
          if (retainedHeaders.length > 0) {
            stored.AFFINE_HEADERS_JSON = JSON.stringify(Object.fromEntries(retainedHeaders));
          } else {
            delete stored.AFFINE_HEADERS_JSON;
          }
        }
      }
    } catch {
      // Invalid header JSON is ignored by runtime config and is not an active credential source.
    }
  }

  if (!removed) {
    console.error("No saved credentials found.");
    return;
  }
  if (Object.keys(stored).length > 0) {
    writeConfigFile(stored);
    console.error(`Removed saved credentials; preserved runtime settings in ${CONFIG_FILE}`);
    return;
  }
  fs.unlinkSync(CONFIG_FILE);
  console.error(`Removed ${CONFIG_FILE}`);
}

function configPath(args: string[]) {
  ensureNoUnexpectedArgs(args, "config-path");
  console.log(CONFIG_FILE);
}

function showConfig(args: string[]) {
  const parsedArgs = [...args];
  const asJson = consumeFlags(parsedArgs, "--json");
  ensureNoUnexpectedArgs(parsedArgs, "show-config");

  const summary = buildEffectiveConfigSummary();
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Config file: ${summary.configFile} (${summary.configFileExists ? "found" : "missing"})`);
  console.log(`Base URL: ${summary.baseUrl} (${summary.sources.baseUrl})`);
  console.log(`GraphQL path: ${summary.graphqlPath} (${summary.sources.graphqlPath})`);
  console.log(`GraphQL endpoint: ${summary.graphqlEndpoint}`);
  console.log(
    `Additional headers: ${summary.additionalHeadersConfigured ? "configured" : "(unset)"} ` +
    `(${summary.sources.additionalHeaders})`,
  );
  console.log(`Auth mode: ${summary.authMode} (${summary.sources.authMode})`);
  console.log(`Auth kind: ${summary.authKind}`);
  console.log(`Workspace: ${summary.workspaceId || "(none)"} (${summary.sources.workspaceId})`);
  if (summary.apiToken) console.log(`API token: ${summary.apiToken} (${summary.sources.apiToken})`);
  if (summary.cookie) console.log(`Cookie: ${summary.cookie} (${summary.sources.cookie})`);
  if (summary.email) console.log(`Email: ${summary.email} (${summary.sources.email})`);
  if (summary.publicBaseUrl) console.log(`Public base URL: ${summary.publicBaseUrl} (${summary.sources.publicBaseUrl})`);
  if (summary.oauthIssuerUrl) console.log(`OAuth issuer URL: ${summary.oauthIssuerUrl} (${summary.sources.oauthIssuerUrl})`);
  if (summary.authMode === "oauth") {
    console.log(`OAuth scopes: ${summary.oauthScopes.join(", ")} (${summary.sources.oauthScopes})`);
    console.log(
      `OAuth clock skew: ${summary.oauthClockSkewSeconds}s (${summary.sources.oauthClockSkewSeconds})`,
    );
  }
  console.log(`Transport: ${summary.transportMode} (${summary.sources.transportMode})`);
  console.log(`Login at start: ${summary.loginAtStart} (${summary.sources.loginAtStart})`);
  console.log(`HTTP bind: ${summary.http.host}:${summary.http.port} (${summary.sources.httpHost}/${summary.sources.httpPort})`);
  console.log(`HTTP auth token: ${summary.http.authToken || "(unset)"} (${summary.sources.httpAuthToken})`);
  console.log(
    `HTTP allowed origins: ${summary.http.allowedOrigins.join(", ") || "loopback only"} ` +
    `(${summary.sources.httpAllowedOrigins})`,
  );
  console.log(
    `HTTP allow all origins: ${summary.http.allowAllOrigins} (${summary.sources.httpAllowAllOrigins})`,
  );
}

async function doctor(args: string[]) {
  const parsedArgs = [...args];
  const asJson = consumeFlags(parsedArgs, "--json");
  ensureNoUnexpectedArgs(parsedArgs, "doctor");

  const effective = loadConfig();
  const summary = buildEffectiveConfigSummary(effective);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({
    name: "config-source",
    ok: true,
    detail: summary.configFileExists
      ? `Environment overrides and ${summary.configFile}`
      : "Environment variables and built-in defaults (saved config is optional)",
  });

  const healthController = new AbortController();
  const healthTimer = setTimeout(() => healthController.abort(), CLI_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(summary.baseUrl, { signal: healthController.signal });
    await response.body?.cancel();
    checks.push({
      name: "base-url",
      ok: true,
      detail: `Reachable (HTTP ${response.status})`,
    });
  } catch (err: any) {
    checks.push({
      name: "base-url",
      ok: false,
      detail: err?.message || "Could not reach base URL",
    });
  } finally {
    clearTimeout(healthTimer);
  }

  let authKind = "none";
  let doctorAuth: CliAuth | undefined;
  try {
    const { auth, authKind: resolvedAuthKind } = await resolveCliAuth(effective);
    doctorAuth = auth;
    authKind = resolvedAuthKind;
    checks.push({
      name: "auth-configured",
      ok: true,
      detail: `Using ${resolvedAuthKind}`,
    });

    try {
      const data = await inspectConnection(effective.graphqlEndpoint, auth);
      checks.push({
        name: "graphql-auth",
        ok: true,
        detail: `${data.userEmail} (${data.workspaceCount} workspace(s))`,
      });
    } catch (err: any) {
      checks.push({
        name: "graphql-auth",
        ok: false,
        detail: err?.message || "GraphQL auth failed",
      });
    }
  } catch (err: any) {
    checks.push({
      name: "auth-configured",
      ok: false,
      detail: err?.message || "No authentication configured",
    });
  }

  if (!effective.defaultWorkspaceId) {
    checks.push({
      name: "workspace-membership",
      ok: true,
      detail: "Skipped because no default workspace is selected. Run affine-mcp workspaces, then affine-mcp workspace <id>.",
    });
    checks.push({
      name: "realtime-root-read",
      ok: true,
      detail: "Skipped because no default workspace is selected.",
    });
  } else if (doctorAuth) {
    try {
      const discovery = await discoverWorkspaces(effective.graphqlEndpoint, doctorAuth);
      const selected = discovery.workspaces.find(workspace => workspace.id === effective.defaultWorkspaceId);
      checks.push({
        name: "workspace-membership",
        ok: Boolean(selected),
        detail: selected
          ? `${workspaceDisplayName(selected)} (${selected.id}) is available to the authenticated account`
          : `Workspace '${effective.defaultWorkspaceId}' is not available to the authenticated account. Run affine-mcp workspaces.`,
      });
      const realtimeReadable = selected?.profileStatus === "available";
      checks.push({
        name: "realtime-root-read",
        ok: realtimeReadable,
        detail: realtimeReadable && selected
          ? `Read workspace root metadata for ${workspaceDisplayName(selected)} (${selected.id})`
          : "Could not read workspace root metadata over realtime. Check the workspace URL, membership, and session, then retry.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name: "workspace-membership",
        ok: false,
        detail: message,
      });
      checks.push({
        name: "realtime-root-read",
        ok: false,
        detail: "Skipped because workspace membership could not be confirmed.",
      });
    }
  } else {
    checks.push({
      name: "workspace-membership",
      ok: false,
      detail: "Skipped because authentication did not resolve.",
    });
    checks.push({
      name: "realtime-root-read",
      ok: false,
      detail: "Skipped because authentication did not resolve.",
    });
  }

  let filterSummary: {
    profile: string | null;
    disabledGroups: string[];
    disabledTools: string[];
    enabledToolCount: number | null;
    totalToolCount: number | null;
  } = {
    profile: null,
    disabledGroups: [],
    disabledTools: [],
    enabledToolCount: null,
    totalToolCount: null,
  };
  try {
    const filter = createToolFilter(createToolFilterEnvironment(effective.authMode, process.env));
    assertOAuthServiceWritePolicy({
      authMode: effective.authMode,
      allowServiceWrites: effective.oauthAllowServiceWrites,
      enabledWriteTools: filter.enabledWriteTools,
    });
    filterSummary = {
      profile: filter.profile,
      disabledGroups: [...filter.disabledGroups].sort(),
      disabledTools: [...filter.disabledTools].sort(),
      enabledToolCount: filter.enabledTools.length,
      totalToolCount: filter.totalToolCount,
    };
    checks.push({
      name: "tool-filter",
      ok: true,
      detail: `profile=${filter.profile}; enabled=${filter.enabledTools.length}/${filter.totalToolCount}; ` +
        `disabled groups=${filterSummary.disabledGroups.join(",") || "(none)"}; ` +
        `disabled tools=${filterSummary.disabledTools.join(",") || "(none)"}`,
    });
  } catch (error) {
    checks.push({
      name: "tool-filter",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (effective.transportMode === "http") {
    const loopbackHost = ["localhost", "127.0.0.1", "::1"].includes(effective.http.host);
    const protectedHttp = effective.authMode === "oauth" || Boolean(effective.http.authToken);
    checks.push({
      name: "http-exposure",
      ok: loopbackHost || protectedHttp,
      detail: loopbackHost
        ? `Loopback bind on ${effective.http.host}:${effective.http.port}`
        : protectedHttp
          ? `Protected bind on ${effective.http.host}:${effective.http.port}`
          : "Non-loopback bearer deployments require AFFINE_MCP_HTTP_TOKEN",
    });
  }

  if (summary.authMode === "oauth") {
    checks.push({
      name: "oauth-transport",
      ok: effective.transportMode === "http",
      detail: effective.transportMode === "http"
        ? "HTTP transport enabled"
        : "OAuth mode requires MCP_TRANSPORT=http",
    });
    const oauthReady = Boolean(summary.publicBaseUrl && summary.oauthIssuerUrl && summary.oauthScopes.length > 0);
    if (!oauthReady || !effective.publicBaseUrl || !effective.oauthIssuerUrl) {
      checks.push({
        name: "oauth-config",
        ok: false,
        detail: "OAuth mode requires AFFINE_MCP_PUBLIC_BASE_URL and AFFINE_OAUTH_ISSUER_URL",
      });
    } else {
      const oauthConfig = {
        publicBaseUrl: effective.publicBaseUrl,
        issuerUrl: effective.oauthIssuerUrl,
        scopes: effective.oauthScopes,
        clockSkewSeconds: effective.oauthClockSkewSeconds,
      };
      try {
        validateOAuthConfig(oauthConfig, {
          allowAnyOrigin: effective.http.allowAllOrigins,
          httpAuthToken: effective.http.authToken,
        });
        checks.push({
          name: "oauth-config",
          ok: true,
          detail: `${summary.publicBaseUrl} -> ${summary.oauthIssuerUrl}`,
        });
        try {
          const readiness = await probeOAuthReadiness(oauthConfig);
          checks.push({
            name: "oauth-discovery",
            ok: true,
            detail: `${readiness.issuer} (${readiness.jwksUri})`,
          });
        } catch (err: any) {
          checks.push({
            name: "oauth-discovery",
            ok: false,
            detail: err?.message || "OAuth discovery or JWKS probe failed",
          });
        }
      } catch (err: any) {
        checks.push({
          name: "oauth-config",
          ok: false,
          detail: err?.message || "OAuth configuration is invalid",
        });
      }
    }
  }

  const ok = checks.every((check) => check.ok);

  if (asJson) {
    console.log(JSON.stringify({
      ok,
      config: summary,
      checks,
      authKind,
      filter: filterSummary,
    }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  console.log(`Doctor: ${ok ? "OK" : "FAILED"}`);
  console.log(`Base URL: ${summary.baseUrl}`);
  console.log(`GraphQL endpoint: ${summary.graphqlEndpoint}`);
  console.log(`Auth mode: ${summary.authMode}`);
  console.log(
    `Tool filter: ${filterSummary.profile || "invalid"} ` +
    `(${filterSummary.enabledToolCount ?? "?"}/${filterSummary.totalToolCount ?? "?"} enabled)`,
  );
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  if (!ok) {
    throw new CliError("Doctor checks failed.");
  }
}

function getSnippetEnv(): Record<string, string> {
  const effective = loadConfig();
  const stored = loadConfigFile();
  const env: Record<string, string> = {};
  if (effective.baseUrl) env.AFFINE_BASE_URL = effective.baseUrl;
  if (effective.graphqlPath !== "/graphql") env.AFFINE_GRAPHQL_PATH = effective.graphqlPath;
  const headers = withoutAuthenticationHeaders(
    parseConfiguredHeaders(process.env.AFFINE_HEADERS_JSON || stored.AFFINE_HEADERS_JSON),
  );
  if (headers) env.AFFINE_HEADERS_JSON = JSON.stringify(headers);
  if (effective.apiToken) {
    env.AFFINE_API_TOKEN = effective.apiToken;
  } else if (effective.cookie) {
    env.AFFINE_COOKIE = effective.cookie;
  } else if (effective.email && effective.password) {
    env.AFFINE_EMAIL = effective.email;
    env.AFFINE_PASSWORD = effective.password;
    if (effective.loginAtStart !== "async") env.AFFINE_LOGIN_AT_START = effective.loginAtStart;
  }
  if (effective.defaultWorkspaceId) env.AFFINE_WORKSPACE_ID = effective.defaultWorkspaceId;
  if (effective.authMode === "oauth") {
    env.AFFINE_MCP_AUTH_MODE = "oauth";
    if (effective.publicBaseUrl) env.AFFINE_MCP_PUBLIC_BASE_URL = effective.publicBaseUrl;
    if (effective.oauthIssuerUrl) env.AFFINE_OAUTH_ISSUER_URL = effective.oauthIssuerUrl;
    if (effective.oauthScopes.length > 0) env.AFFINE_OAUTH_SCOPES = effective.oauthScopes.join(" ");
  }
  return env;
}

function snippet(args: string[]) {
  const parsedArgs = [...args];
  const includeEnv = consumeFlags(parsedArgs, "--env");
  const target = parsedArgs[0];
  if (!target) {
    throw new CliError("Usage: affine-mcp snippet <claude|cursor|codex> [--env]");
  }
  ensureNoUnexpectedArgs(parsedArgs.slice(1), "snippet");
  const env = includeEnv ? getSnippetEnv() : undefined;
  if (includeEnv) {
    console.error(
      "Warning: --env copies credentials, custom headers, and the current default workspace into the snippet. " +
      "The values are a snapshot; remove and regenerate this snippet after re-login or workspace changes.",
    );
  } else {
    console.error("Recommended: omit --env so the MCP client reads the current saved login settings.");
  }

  if (target === "all") {
    const payload = {
      claude: {
        mcpServers: {
          affine: {
            command: "affine-mcp",
            ...(env && Object.keys(env).length > 0 ? { env } : {}),
          },
        },
      },
      cursor: {
        mcpServers: {
          affine: {
            command: "affine-mcp",
            ...(env && Object.keys(env).length > 0 ? { env } : {}),
          },
        },
      },
      codex: env && Object.keys(env).length > 0
        ? `codex mcp add affine ${buildCodexEnvironmentArguments(env)} -- affine-mcp`
        : "codex mcp add affine -- affine-mcp",
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (target === "claude" || target === "cursor") {
    const payload = {
      mcpServers: {
        affine: {
          command: "affine-mcp",
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
        },
      },
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (target === "codex") {
    if (!env || Object.keys(env).length === 0) {
      console.log("codex mcp add affine -- affine-mcp");
      return;
    }
    const envArgs = buildCodexEnvironmentArguments(env);
    console.log(`codex mcp add affine ${envArgs} -- affine-mcp`);
    return;
  }

  throw new CliError(`Unknown snippet target '${target}'. Expected claude, cursor, codex, or all.`);
}

function help(args: string[]) {
  if (args.length > 1) {
    throw new CliError("Usage: affine-mcp help [command]");
  }
  printHelp(args[0]);
}

const COMMANDS: Record<string, CliCommandDefinition> = {
  help: {
    summary: "Show CLI help",
    usage: "affine-mcp help [command]",
    handler: help,
  },
  login: {
    summary: "Interactive login and config bootstrap",
    usage: "affine-mcp login [--url <url>] [--graphql-path <path>] [--token <token> | --cookie-stdin] [--workspace-id <id>] [--force]",
    handler: login,
  },
  workspaces: {
    summary: "List account workspaces without changing config",
    usage: "affine-mcp workspaces [--json]",
    handler: listWorkspaces,
  },
  workspace: {
    summary: "Validate and set the default workspace",
    usage: "affine-mcp workspace [workspace-id] [--json]",
    handler: switchWorkspace,
  },
  status: {
    summary: "Test the effective config and print current user info",
    usage: "affine-mcp status [--json]",
    handler: status,
  },
  logout: {
    summary: "Remove saved credentials and preserve runtime settings",
    usage: "affine-mcp logout",
    handler: logout,
  },
  "config-path": {
    summary: "Print the config file path",
    usage: "affine-mcp config-path",
    handler: configPath,
  },
  "show-config": {
    summary: "Print the effective config (redacted)",
    usage: "affine-mcp show-config [--json]",
    handler: showConfig,
  },
  doctor: {
    summary: "Run local config and connectivity diagnostics",
    usage: "affine-mcp doctor [--json]",
    handler: doctor,
  },
  snippet: {
    summary: "Print ready-to-paste Claude/Cursor/Codex snippets",
    usage: "affine-mcp snippet <claude|cursor|codex|all> [--env]",
    handler: snippet,
  },
};

export async function runCli(command: string, args: string[] = []): Promise<boolean> {
  const normalizedCommand = command.trim().toLowerCase();
  const definition = COMMANDS[normalizedCommand];
  if (!definition) return false;
  try {
    await definition.handler(args);
  } catch (err: any) {
    if (err instanceof Error) {
      console.error(`✗ ${err.message}`);
      closeNonInteractiveReader();
      process.exit(1);
    }
    throw err;
  }
  closeNonInteractiveReader();
  return true;
}
