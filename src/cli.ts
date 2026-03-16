import { fetch } from "undici";
import * as fs from "fs";
import * as readline from "readline";

import { CONFIG_FILE, loadConfig, loadConfigFile, validateBaseUrl, VERSION, writeConfigFile } from "./config.js";
import { loginWithPassword } from "./auth.js";

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

async function gql(baseUrl: string, auth: { token?: string; cookie?: string }, query: string, variables?: Record<string, any>): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `affine-mcp-server/${VERSION}`,
  };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.Cookie = auth.cookie;
  const body: any = { query };
  if (variables) body.variables = variables;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLI_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl}/graphql`, {
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

function buildEffectiveConfigSummary() {
  const stored = loadConfigFile();
  const effective = loadConfig();
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
    workspaceId: effective.defaultWorkspaceId || null,
    authMode: effective.authMode,
    authKind,
    apiToken: effective.apiToken ? redactSecret(effective.apiToken) : null,
    cookie: effective.cookie ? "(set)" : null,
    email: effective.email || null,
    publicBaseUrl: effective.publicBaseUrl || null,
    oauthIssuerUrl: effective.oauthIssuerUrl || null,
    oauthScopes: effective.oauthScopes,
    sources: {
      baseUrl: getConfigValueSource("AFFINE_BASE_URL", stored, "http://localhost:3010"),
      apiToken: getConfigValueSource("AFFINE_API_TOKEN", stored),
      cookie: getConfigValueSource("AFFINE_COOKIE", stored),
      email: getConfigValueSource("AFFINE_EMAIL", stored),
      password: getConfigValueSource("AFFINE_PASSWORD", stored),
      workspaceId: getConfigValueSource("AFFINE_WORKSPACE_ID", stored),
      authMode: getConfigValueSource("AFFINE_MCP_AUTH_MODE", stored, "bearer"),
      publicBaseUrl: getConfigValueSource("AFFINE_MCP_PUBLIC_BASE_URL", stored),
      oauthIssuerUrl: getConfigValueSource("AFFINE_OAUTH_ISSUER_URL", stored),
      oauthScopes: getConfigValueSource("AFFINE_OAUTH_SCOPES", stored, "mcp"),
    },
  };
}

async function resolveCliAuth(baseUrl: string): Promise<{ auth: { token?: string; cookie?: string }; authKind: string }> {
  const effective = loadConfig();
  if (effective.apiToken) {
    return { auth: { token: effective.apiToken }, authKind: "api-token" };
  }
  if (effective.cookie) {
    return { auth: { cookie: effective.cookie }, authKind: "cookie" };
  }
  if (effective.email && effective.password) {
    const { cookieHeader } = await loginWithPassword(baseUrl, effective.email, effective.password);
    return { auth: { cookie: cookieHeader }, authKind: "email-password" };
  }
  throw new CliError("No authentication configured. Run 'affine-mcp login' or set AFFINE_API_TOKEN.");
}

async function inspectConnection(baseUrl: string, auth: { token?: string; cookie?: string }): Promise<ConnectionInspection> {
  const data = await gql(
    baseUrl,
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

async function detectWorkspace(baseUrl: string, auth: { token?: string; cookie?: string }, preferredWorkspaceId?: string): Promise<string> {
  if (preferredWorkspaceId) {
    console.error(`Using workspace override: ${preferredWorkspaceId}`);
    return preferredWorkspaceId;
  }
  console.error("Detecting workspaces...");
  try {
    const data = await gql(baseUrl, auth, `query {
      workspaces {
        id createdAt memberCount
        owner { name }
      }
    }`);
    const workspaces: any[] = data.workspaces;
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

async function loginWithEmail(baseUrl: string): Promise<{ token: string; workspaceId: string }> {
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
    const data = await gql(baseUrl, auth, "query { currentUser { name email } }");
    console.error(`✓ Signed in as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw new CliError(`Session verification failed: ${err.message}`);
  }

  console.error("Generating API token...");
  let token: string;
  try {
    const data = await gql(
      baseUrl,
      auth,
      `mutation($input: GenerateAccessTokenInput!) { generateUserAccessToken(input: $input) { id name token } }`,
      { input: { name: `affine-mcp-${new Date().toISOString().slice(0, 10)}` } },
    );
    token = data.generateUserAccessToken.token;
    console.error(`✓ Token created (name: ${data.generateUserAccessToken.name})\n`);
  } catch (err: any) {
    throw new CliError(
      `Failed to generate token: ${err.message}\n` +
      "You can create one manually in Affine Settings → Integrations → MCP Server",
    );
  }

  const workspaceId = await detectWorkspace(baseUrl, { token });
  return { token, workspaceId };
}

async function loginWithToken(baseUrl: string): Promise<{ token: string; workspaceId: string }> {
  console.error("\nTo generate a token:");
  console.error(`  1. Open ${baseUrl}/settings in your browser`);
  console.error("  2. Account Settings → Integrations → MCP Server");
  console.error("  3. Copy the Personal access token\n");

  const token = await ask("API token: ", true);
  if (!token) {
    throw new CliError("No token provided.");
  }

  console.error("Testing connection...");
  try {
    const data = await gql(baseUrl, { token }, "query { currentUser { name email } }");
    console.error(`✓ Authenticated as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw new CliError(`Authentication failed: ${err.message}`);
  }

  const workspaceId = await detectWorkspace(baseUrl, { token });
  return { token, workspaceId };
}

async function login(args: string[]) {
  const parsedArgs = [...args];
  const providedUrl = consumeOption(parsedArgs, "--url");
  const providedToken = consumeOption(parsedArgs, "--token");
  const providedWorkspaceId = consumeOption(parsedArgs, "--workspace-id");
  const force = consumeFlags(parsedArgs, "--force", "-f");
  ensureNoUnexpectedArgs(parsedArgs, "login");

  console.error("Affine MCP Server — Login\n");

  const existing = loadConfigFile();
  if (existing.AFFINE_API_TOKEN) {
    console.error(`Existing config: ${CONFIG_FILE}`);
    console.error(`  URL:       ${existing.AFFINE_BASE_URL || "(default)"}`);
    console.error("  Token:     (set)");
    console.error(`  Workspace: ${existing.AFFINE_WORKSPACE_ID || "(none)"}\n`);
    if (!force) {
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

  const defaultUrl = "https://app.affine.pro";
  const rawUrl = providedUrl ?? ((await ask(`Affine URL [${defaultUrl}]: `)) || defaultUrl);
  const baseUrl = validateBaseUrl(rawUrl);

  let result: { token: string; workspaceId: string };

  if (providedToken) {
    console.error("Testing provided token...");
    try {
      const info = await inspectConnection(baseUrl, { token: providedToken });
      console.error(`✓ Authenticated as: ${info.userName} <${info.userEmail}>\n`);
    } catch (err: any) {
      throw new CliError(`Authentication failed: ${err.message}`);
    }
    result = {
      token: providedToken,
      workspaceId: await detectWorkspace(baseUrl, { token: providedToken }, providedWorkspaceId),
    };
  } else {
    const isSelfHosted = !baseUrl.includes("affine.pro");
    if (isSelfHosted) {
      const method = await ask("\nAuth method — [1] Email/password (recommended)  [2] Paste API token: ");
      const loginResult = method === "2" ? await loginWithToken(baseUrl) : await loginWithEmail(baseUrl);
      result = {
        ...loginResult,
        workspaceId: providedWorkspaceId || loginResult.workspaceId,
      };
    } else {
      const loginResult = await loginWithToken(baseUrl);
      result = {
        ...loginResult,
        workspaceId: providedWorkspaceId || loginResult.workspaceId,
      };
    }
  }

  writeConfigFile({
    AFFINE_BASE_URL: baseUrl,
    AFFINE_API_TOKEN: result.token,
    AFFINE_WORKSPACE_ID: result.workspaceId,
  });

  console.error(`\n✓ Saved to ${CONFIG_FILE} (mode 600)`);
  console.error("The MCP server will use these credentials automatically.");
}

async function status(args: string[]) {
  const parsedArgs = [...args];
  const asJson = consumeFlags(parsedArgs, "--json");
  ensureNoUnexpectedArgs(parsedArgs, "status");
  const config = loadConfigFile();
  if (!config.AFFINE_API_TOKEN) {
    throw new CliError("Not logged in. Run: affine-mcp login");
  }
  try {
    const inspection = await inspectConnection(
      config.AFFINE_BASE_URL || "https://app.affine.pro",
      { token: config.AFFINE_API_TOKEN },
    );
    if (asJson) {
      console.log(JSON.stringify({
        configFile: CONFIG_FILE,
        baseUrl: config.AFFINE_BASE_URL || "https://app.affine.pro",
        workspaceId: config.AFFINE_WORKSPACE_ID || null,
        userName: inspection.userName,
        userEmail: inspection.userEmail,
        workspaceCount: inspection.workspaceCount,
      }, null, 2));
      return;
    }

    console.error(`Config: ${CONFIG_FILE}`);
    console.error(`URL:       ${config.AFFINE_BASE_URL || "(default)"}`);
    console.error("Token:     (set)");
    console.error(`Workspace: ${config.AFFINE_WORKSPACE_ID || "(none)"}\n`);
    console.error(`User: ${inspection.userName} <${inspection.userEmail}>`);
    console.error(`Workspaces: ${inspection.workspaceCount}`);
  } catch (err: any) {
    throw new CliError(`Connection failed: ${err.message}`);
  }
}

function logout(args: string[]) {
  ensureNoUnexpectedArgs(args, "logout");
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    console.error(`Removed ${CONFIG_FILE}`);
  } else {
    console.error("No config file found.");
  }
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
  console.log(`GraphQL path: ${summary.graphqlPath}`);
  console.log(`Auth mode: ${summary.authMode} (${summary.sources.authMode})`);
  console.log(`Auth kind: ${summary.authKind}`);
  console.log(`Workspace: ${summary.workspaceId || "(none)"} (${summary.sources.workspaceId})`);
  if (summary.apiToken) console.log(`API token: ${summary.apiToken} (${summary.sources.apiToken})`);
  if (summary.cookie) console.log(`Cookie: ${summary.cookie} (${summary.sources.cookie})`);
  if (summary.email) console.log(`Email: ${summary.email} (${summary.sources.email})`);
  if (summary.publicBaseUrl) console.log(`Public base URL: ${summary.publicBaseUrl} (${summary.sources.publicBaseUrl})`);
  if (summary.oauthIssuerUrl) console.log(`OAuth issuer URL: ${summary.oauthIssuerUrl} (${summary.sources.oauthIssuerUrl})`);
  if (summary.authMode === "oauth") console.log(`OAuth scopes: ${summary.oauthScopes.join(", ")} (${summary.sources.oauthScopes})`);
}

async function doctor(args: string[]) {
  const parsedArgs = [...args];
  const asJson = consumeFlags(parsedArgs, "--json");
  ensureNoUnexpectedArgs(parsedArgs, "doctor");

  const summary = buildEffectiveConfigSummary();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({
    name: "config-file",
    ok: summary.configFileExists,
    detail: summary.configFileExists ? summary.configFile : "No saved config file found",
  });

  let authKind = "none";
  try {
    const { auth, authKind: resolvedAuthKind } = await resolveCliAuth(summary.baseUrl);
    authKind = resolvedAuthKind;
    checks.push({
      name: "auth-configured",
      ok: true,
      detail: `Using ${resolvedAuthKind}`,
    });

    const healthController = new AbortController();
    const healthTimer = setTimeout(() => healthController.abort(), CLI_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(summary.baseUrl, { signal: healthController.signal });
      checks.push({
        name: "base-url",
        ok: response.ok,
        detail: `HTTP ${response.status}`,
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

    try {
      const data = await inspectConnection(summary.baseUrl, auth);
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

  if (summary.authMode === "oauth") {
    const oauthReady = Boolean(summary.publicBaseUrl && summary.oauthIssuerUrl && summary.oauthScopes.length > 0);
    checks.push({
      name: "oauth-config",
      ok: oauthReady,
      detail: oauthReady
        ? `${summary.publicBaseUrl} -> ${summary.oauthIssuerUrl}`
        : "OAuth mode requires AFFINE_MCP_PUBLIC_BASE_URL and AFFINE_OAUTH_ISSUER_URL",
    });
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
  const env: Record<string, string> = {};
  if (effective.baseUrl) env.AFFINE_BASE_URL = effective.baseUrl;
  if (effective.apiToken) env.AFFINE_API_TOKEN = effective.apiToken;
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
        ? `codex mcp add affine ${Object.entries(env).map(([key, value]) => `--env ${key}=${JSON.stringify(value)}`).join(" ")} -- affine-mcp`
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
    const envArgs = Object.entries(env)
      .map(([key, value]) => `--env ${key}=${JSON.stringify(value)}`)
      .join(" ");
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
    usage: "affine-mcp login [--url <url>] [--token <token>] [--workspace-id <id>] [--force]",
    handler: login,
  },
  status: {
    summary: "Test the saved config and print current user info",
    usage: "affine-mcp status [--json]",
    handler: status,
  },
  logout: {
    summary: "Remove the saved config file",
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
    if (err instanceof CliError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  return true;
}
