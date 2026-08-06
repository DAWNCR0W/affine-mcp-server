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

type CliAuth = {
  token?: string;
  cookie?: string;
  headers?: Record<string, string>;
};

type LoginResult = {
  token?: string;
  cookie?: string;
  workspaceId: string;
};

function ask(prompt: string, hidden = false): Promise<string> {
  if (hidden && process.stdin.isTTY) {
    return readHidden(prompt);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: process.stdin.isTTY ?? false,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    });
  });
}

/** Read a line with echo disabled using raw-mode stdin (no private API hacks). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const buf: string[] = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      switch (ch) {
        case "\r":
        case "\n":
          cleanup();
          process.stderr.write("\n");
          resolve(buf.join(""));
          break;
        case "\u0003":
          cleanup();
          process.stderr.write("\n");
          reject(new CliError("Aborted."));
          break;
        case "\u007F":
        case "\b":
          buf.pop();
          break;
        default:
          buf.push(ch);
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    process.stdin.on("data", onData);
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLI_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(graphqlEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${CLI_FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as any;
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
): "env" | "config" | "unset" {
  if (!value) return "unset";
  return process.env[name] ? "env" : file[name] ? "config" : "unset";
}

function buildEffectiveConfigSummary(effective: ServerConfig = loadConfig()) {
  const stored = loadConfigFile();
  const authKind = effective.apiToken
    ? "api-token"
    : effective.cookie
      ? "cookie"
      : effective.email && effective.password
        ? "email-password"
        : "none";

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
    apiToken: effective.apiToken ? redactSecret(effective.apiToken) : null,
    cookie: effective.cookie ? "(set)" : null,
    email: effective.email || null,
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
      apiToken: getEffectiveAuthValueSource("AFFINE_API_TOKEN", effective.apiToken, stored),
      cookie: getEffectiveAuthValueSource("AFFINE_COOKIE", effective.cookie, stored),
      email: getEffectiveAuthValueSource("AFFINE_EMAIL", effective.email, stored),
      password: getEffectiveAuthValueSource("AFFINE_PASSWORD", effective.password, stored),
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

async function resolveCliAuth(effective: ServerConfig): Promise<{ auth: CliAuth; authKind: string }> {
  if (effective.apiToken) {
    return {
      auth: { token: effective.apiToken, headers: effective.headers },
      authKind: "api-token",
    };
  }
  if (effective.cookie) {
    return {
      auth: { cookie: effective.cookie, headers: effective.headers },
      authKind: "cookie",
    };
  }
  if (effective.email && effective.password) {
    const { cookieHeader } = await loginWithPassword(effective.baseUrl, effective.email, effective.password, effective.headers);
    return {
      auth: { cookie: cookieHeader, headers: effective.headers },
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
  console.log("  affine-mcp status");
  console.log("  affine-mcp doctor");
  console.log("  affine-mcp show-config --json");
  console.log("  affine-mcp snippet claude --env");
  console.log("  affine-mcp --version");
  console.log("  affine-mcp --help");
}

async function detectWorkspace(
  graphqlEndpoint: string,
  auth: CliAuth,
  preferredWorkspaceId?: string,
): Promise<string> {
  console.error(preferredWorkspaceId ? "Validating workspace override..." : "Detecting workspaces...");
  let data: any;
  try {
    data = await gql(graphqlEndpoint, auth, `query {
      workspaces {
        id createdAt memberCount
        owner { name }
      }
    }`);
  } catch (err: any) {
    if (preferredWorkspaceId) {
      throw new CliError(`Could not validate workspace '${preferredWorkspaceId}': ${err.message}`);
    }
    console.error(`  Could not list workspaces: ${err.message}`);
    return "";
  }

  const workspaces: any[] = Array.isArray(data?.workspaces) ? data.workspaces : [];
  if (preferredWorkspaceId) {
    const preferredWorkspace = workspaces.find((workspace) => workspace?.id === preferredWorkspaceId);
    if (!preferredWorkspace) {
      throw new CliError(`Workspace '${preferredWorkspaceId}' is not available to the authenticated account.`);
    }
    console.error(`  Verified workspace: ${preferredWorkspaceId}`);
    return preferredWorkspaceId;
  }

  try {
    if (workspaces.length === 0) {
      console.error("  No workspaces found.");
      return "";
    }
    const formatWs = (w: any) => {
      const owner = w.owner?.name || "unknown";
      const members = w.memberCount ?? 0;
      const date = w.createdAt ? new Date(w.createdAt).toLocaleDateString() : "";
      const membersStr = members === 1 ? "1 member" : `${members} members`;
      return `${w.id}  (by ${owner}, ${membersStr}, ${date})`;
    };
    if (workspaces.length === 1) {
      console.error(`  Found 1 workspace: ${formatWs(workspaces[0])}`);
      console.error("  Auto-selected.");
      return workspaces[0].id;
    }
    console.error(`  Found ${workspaces.length} workspaces:`);
    workspaces.forEach((w, i) => console.error(`    ${i + 1}) ${formatWs(w)}`));
    const choice = (await ask(`\nSelect [1]: `)) || "1";
    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || idx >= workspaces.length) {
      throw new CliError("Invalid selection.");
    }
    return workspaces[idx].id;
  } catch (err: any) {
    if (err instanceof CliError) throw err;
    console.error(`  Could not list workspaces: ${err.message}`);
    return "";
  }
}

async function loginWithEmail(
  baseUrl: string,
  graphqlEndpoint: string,
  preferredWorkspaceId?: string,
): Promise<LoginResult> {
  const email = await ask("Email: ");
  const password = await ask("Password: ", true);
  if (!email || !password) {
    throw new CliError("Email and password are required.");
  }

  console.error("Signing in...");
  let cookieHeader: string;
  try {
    ({ cookieHeader } = await loginWithPassword(baseUrl, email, password));
  } catch (err: any) {
    throw new CliError(`Sign-in failed: ${err.message}`);
  }

  const auth = { cookie: cookieHeader };
  try {
    const data = await gql(graphqlEndpoint, auth, "query { currentUser { name email } }");
    console.error(`✓ Signed in as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw new CliError(`Session verification failed: ${err.message}`);
  }

  const workspaceId = await detectWorkspace(graphqlEndpoint, auth, preferredWorkspaceId);
  return { cookie: cookieHeader, workspaceId };
}

async function loginWithToken(
  graphqlEndpoint: string,
  preferredWorkspaceId?: string,
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
    const data = await gql(graphqlEndpoint, { token }, "query { currentUser { name email } }");
    console.error(`✓ Authenticated as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw new CliError(`Authentication failed: ${err.message}`);
  }

  const workspaceId = await detectWorkspace(graphqlEndpoint, { token }, preferredWorkspaceId);
  return { token, workspaceId };
}

async function loginWithCookie(
  baseUrl: string,
  graphqlEndpoint: string,
  preferredWorkspaceId?: string,
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
    const data = await gql(graphqlEndpoint, { cookie }, "query { currentUser { name email } }");
    console.error(`✓ Authenticated as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw new CliError(`Authentication failed: ${err.message}`);
  }

  const workspaceId = await detectWorkspace(graphqlEndpoint, { cookie }, preferredWorkspaceId);
  return { cookie, workspaceId };
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
  const hasExistingAuth = Boolean(
    existing.AFFINE_API_TOKEN ||
    existing.AFFINE_COOKIE ||
    (existing.AFFINE_EMAIL && existing.AFFINE_PASSWORD),
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
      : (await ask(`Affine URL [${defaultUrl}]: `)) || defaultUrl
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
      const info = await inspectConnection(graphqlEndpoint, { token: providedToken });
      console.error(`✓ Authenticated as: ${info.userName} <${info.userEmail}>\n`);
    } catch (err: any) {
      throw new CliError(`Authentication failed: ${err.message}`);
    }
    result = {
      token: providedToken,
      workspaceId: await detectWorkspace(graphqlEndpoint, { token: providedToken }, providedWorkspaceId),
    };
  } else if (providedCookie) {
    console.error("Testing provided session cookie...");
    try {
      const info = await inspectConnection(graphqlEndpoint, { cookie: providedCookie });
      console.error(`✓ Authenticated as: ${info.userName} <${info.userEmail}>\n`);
    } catch (err: any) {
      throw new CliError(`Authentication failed: ${err.message}`);
    }
    result = {
      cookie: providedCookie,
      workspaceId: await detectWorkspace(graphqlEndpoint, { cookie: providedCookie }, providedWorkspaceId),
    };
  } else {
    const isSelfHosted = !baseUrl.includes("affine.pro");
    if (isSelfHosted) {
      const method = await ask(
        "\nAuth method — [1] Email/password (recommended)  [2] Paste session cookie  [3] Compatible API token: ",
      );
      const loginResult = method === "2"
        ? await loginWithCookie(baseUrl, graphqlEndpoint, providedWorkspaceId)
        : method === "3"
          ? await loginWithToken(graphqlEndpoint, providedWorkspaceId)
          : await loginWithEmail(baseUrl, graphqlEndpoint, providedWorkspaceId);
      result = loginResult;
    } else {
      const method = await ask(
        "\nAuth method — [1] Paste session cookie (recommended)  [2] Compatible API token: ",
      );
      const loginResult = method === "2"
        ? await loginWithToken(graphqlEndpoint, providedWorkspaceId)
        : await loginWithCookie(baseUrl, graphqlEndpoint, providedWorkspaceId);
      result = loginResult;
    }
  }

  writeConfigFile({
    ...existing,
    AFFINE_BASE_URL: baseUrl,
    AFFINE_GRAPHQL_PATH: graphqlPath === "/graphql" ? "" : graphqlPath,
    AFFINE_API_TOKEN: result.token || "",
    AFFINE_COOKIE: result.cookie || "",
    AFFINE_EMAIL: "",
    AFFINE_PASSWORD: "",
    AFFINE_WORKSPACE_ID: result.workspaceId,
  });

  console.error(`\n✓ Saved to ${CONFIG_FILE} (mode 600)`);
  console.error("The MCP server will use these credentials automatically. Re-run login if the session expires.");
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
    if (asJson) {
      console.log(JSON.stringify({
        configFile: CONFIG_FILE,
        configFileExists: summary.configFileExists,
        baseUrl: effective.baseUrl,
        graphqlEndpoint: effective.graphqlEndpoint,
        workspaceId: effective.defaultWorkspaceId || null,
        authKind,
        userName: inspection.userName,
        userEmail: inspection.userEmail,
        workspaceCount: inspection.workspaceCount,
      }, null, 2));
      return;
    }

    console.error(`Config: ${CONFIG_FILE} (${summary.configFileExists ? "found" : "not used"})`);
    console.error(`URL:       ${effective.baseUrl}`);
    console.error(`GraphQL:   ${effective.graphqlEndpoint}`);
    console.error(`Auth:      ${authKind}`);
    console.error(`Workspace: ${effective.defaultWorkspaceId || "(none)"}\n`);
    console.error(`User: ${inspection.userName} <${inspection.userEmail}>`);
    console.error(`Workspaces: ${inspection.workspaceCount}`);
  } catch (err: any) {
    throw new CliError(`Connection failed: ${err.message}`);
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
  try {
    const { auth, authKind: resolvedAuthKind } = await resolveCliAuth(effective);
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
    }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  console.log(`Doctor: ${ok ? "OK" : "FAILED"}`);
  console.log(`Base URL: ${summary.baseUrl}`);
  console.log(`GraphQL endpoint: ${summary.graphqlEndpoint}`);
  console.log(`Auth mode: ${summary.authMode}`);
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
  const headersJson = process.env.AFFINE_HEADERS_JSON || stored.AFFINE_HEADERS_JSON;
  if (headersJson) env.AFFINE_HEADERS_JSON = headersJson;
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
      process.exit(1);
    }
    throw err;
  }
  return true;
}
