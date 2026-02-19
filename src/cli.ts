import { fetch } from "undici";
import * as fs from "fs";
import * as readline from "readline";
import { CONFIG_FILE, loadConfigFile, writeConfigFile, validateBaseUrl, VERSION } from "./config.js";
import { loginWithPassword } from "./auth.js";

const CLI_FETCH_TIMEOUT_MS = 30_000;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function ask(prompt: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: process.stdin.isTTY ?? false,
    });
    if (hidden) {
      (rl as any)._writeToOutput = (str: string) => {
        if (str.includes(prompt)) {
          process.stderr.write(prompt);
        }
      };
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) {
        process.stderr.write("\n");
        // Only strip trailing newline/carriage return for passwords — preserve spaces
        resolve((answer || "").replace(/[\r\n]+$/, ""));
      } else {
        resolve((answer || "").trim());
      }
    });
  });
}

async function gql(baseUrl: string, auth: { token?: string; cookie?: string }, query: string, variables?: Record<string, any>): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `affine-mcp-server/${VERSION}`,
  };
  if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
  if (auth.cookie) headers["Cookie"] = auth.cookie;
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
    if (err.name === "AbortError") throw new Error(`Request timed out after ${CLI_FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as any;
  if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json.data;
}

async function detectWorkspace(baseUrl: string, auth: { token?: string; cookie?: string }): Promise<string> {
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

  // Verify identity
  const auth = { cookie: cookieHeader };
  try {
    const data = await gql(baseUrl, auth, "query { currentUser { name email } }");
    console.error(`✓ Signed in as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    throw new CliError(`Session verification failed: ${err.message}`);
  }

  // Auto-generate an API token so the MCP server can use token auth (no cookie expiry issues)
  console.error("Generating API token...");
  let token: string;
  try {
    const data = await gql(baseUrl, auth,
      `mutation($input: GenerateAccessTokenInput!) { generateUserAccessToken(input: $input) { id name token } }`,
      { input: { name: `affine-mcp-${new Date().toISOString().slice(0, 10)}` } }
    );
    token = data.generateUserAccessToken.token;
    console.error(`✓ Token created (name: ${data.generateUserAccessToken.name})\n`);
  } catch (err: any) {
    throw new CliError(
      `Failed to generate token: ${err.message}\n` +
      "You can create one manually in Affine Settings → Integrations → MCP Server"
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

async function login() {
  console.error("Affine MCP Server — Login\n");

  const existing = loadConfigFile();
  if (existing.AFFINE_API_TOKEN) {
    console.error(`Existing config: ${CONFIG_FILE}`);
    console.error(`  URL:       ${existing.AFFINE_BASE_URL || "(default)"}`);
    console.error(`  Token:     (set)`);
    console.error(`  Workspace: ${existing.AFFINE_WORKSPACE_ID || "(none)"}\n`);
    const overwrite = await ask("Overwrite? [y/N] ");
    if (!/^[yY]$/.test(overwrite)) {
      console.error("Keeping existing config.");
      return;
    }
    console.error("");
  }

  const defaultUrl = "https://app.affine.pro";
  const rawUrl = (await ask(`Affine URL [${defaultUrl}]: `)) || defaultUrl;
  const baseUrl = validateBaseUrl(rawUrl);

  const isSelfHosted = !baseUrl.includes("affine.pro");
  let result: { token: string; workspaceId: string };

  if (isSelfHosted) {
    const method = await ask("\nAuth method — [1] Email/password (recommended)  [2] Paste API token: ");
    if (method === "2") {
      result = await loginWithToken(baseUrl);
    } else {
      result = await loginWithEmail(baseUrl);
    }
  } else {
    // Cloudflare blocks programmatic sign-in on app.affine.pro — token is the only option
    result = await loginWithToken(baseUrl);
  }

  writeConfigFile({
    AFFINE_BASE_URL: baseUrl,
    AFFINE_API_TOKEN: result.token,
    AFFINE_WORKSPACE_ID: result.workspaceId,
  });

  console.error(`\n✓ Saved to ${CONFIG_FILE} (mode 600)`);
  console.error("The MCP server will use these credentials automatically.");
}

async function status() {
  const config = loadConfigFile();
  if (!config.AFFINE_API_TOKEN) {
    throw new CliError("Not logged in. Run: affine-mcp login");
  }
  console.error(`Config: ${CONFIG_FILE}`);
  console.error(`URL:       ${config.AFFINE_BASE_URL || "(default)"}`);
  console.error(`Token:     (set)`);
  console.error(`Workspace: ${config.AFFINE_WORKSPACE_ID || "(none)"}\n`);

  try {
    const data = await gql(
      config.AFFINE_BASE_URL || "https://app.affine.pro",
      { token: config.AFFINE_API_TOKEN },
      "query { currentUser { name email } workspaces { id } }"
    );
    console.error(`User: ${data.currentUser.name} <${data.currentUser.email}>`);
    console.error(`Workspaces: ${data.workspaces.length}`);
  } catch (err: any) {
    throw new CliError(`Connection failed: ${err.message}`);
  }
}

function logout() {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    console.error(`Removed ${CONFIG_FILE}`);
  } else {
    console.error("No config file found.");
  }
}

const COMMANDS: Record<string, () => Promise<void> | void> = { login, status, logout };

export async function runCli(command: string): Promise<boolean> {
  const fn = COMMANDS[command];
  if (!fn) return false;
  try {
    await fn();
  } catch (err: any) {
    if (err instanceof CliError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  return true;
}
