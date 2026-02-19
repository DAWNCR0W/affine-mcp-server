import { fetch } from "undici";
import * as fs from "fs";
import * as readline from "readline";
import { CONFIG_FILE, loadConfigFile, writeConfigFile } from "./config.js";
import { loginWithPassword } from "./auth.js";

function ask(prompt: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    if (hidden) {
      const origWrite = process.stderr.write.bind(process.stderr);
      let muted = false;
      (process.stderr as any).write = (chunk: any, ...args: any[]) => {
        if (muted) return true;
        return origWrite(chunk, ...args);
      };
      rl.question(prompt, (answer) => {
        muted = true;
        (process.stderr as any).write = origWrite;
        process.stderr.write("\n");
        rl.close();
        resolve(answer.trim());
      });
    } else {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

async function gql(baseUrl: string, auth: { token?: string; cookie?: string }, query: string, variables?: Record<string, any>): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "affine-mcp-server/1.5.0",
  };
  if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
  if (auth.cookie) headers["Cookie"] = auth.cookie;
  const body: any = { query };
  if (variables) body.variables = variables;
  const res = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
    const id = workspaces[parseInt(choice, 10) - 1]?.id || "";
    if (!id) {
      console.error("Invalid selection.");
      process.exit(1);
    }
    return id;
  } catch (err: any) {
    console.error(`  Could not list workspaces: ${err.message}`);
    return "";
  }
}

async function loginWithEmail(baseUrl: string): Promise<{ token: string; workspaceId: string }> {
  const email = await ask("Email: ");
  const password = await ask("Password: ", true);
  if (!email || !password) {
    console.error("Email and password are required. Aborting.");
    process.exit(1);
  }

  console.error("Signing in...");
  let cookieHeader: string;
  try {
    ({ cookieHeader } = await loginWithPassword(baseUrl, email, password));
  } catch (err: any) {
    console.error(`✗ Sign-in failed: ${err.message}`);
    process.exit(1);
  }

  // Verify identity
  const auth = { cookie: cookieHeader };
  try {
    const data = await gql(baseUrl, auth, "query { currentUser { name email } }");
    console.error(`✓ Signed in as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    console.error(`✗ Session verification failed: ${err.message}`);
    process.exit(1);
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
    console.error(`✓ Created token: ${token.slice(0, 10)}... (name: ${data.generateUserAccessToken.name})\n`);
  } catch (err: any) {
    console.error(`✗ Failed to generate token: ${err.message}`);
    console.error("You can create one manually in Affine Settings → Integrations → MCP Server");
    process.exit(1);
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
    console.error("No token provided. Aborting.");
    process.exit(1);
  }

  console.error("Testing connection...");
  try {
    const data = await gql(baseUrl, { token }, "query { currentUser { name email } }");
    console.error(`✓ Authenticated as: ${data.currentUser.name} <${data.currentUser.email}>\n`);
  } catch (err: any) {
    console.error(`✗ Authentication failed: ${err.message}`);
    process.exit(1);
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
    console.error(`  Token:     ${existing.AFFINE_API_TOKEN.slice(0, 10)}...`);
    console.error(`  Workspace: ${existing.AFFINE_WORKSPACE_ID || "(none)"}\n`);
    const overwrite = await ask("Overwrite? [y/N] ");
    if (!/^[yY]$/.test(overwrite)) {
      console.error("Keeping existing config.");
      return;
    }
    console.error("");
  }

  const defaultUrl = "https://app.affine.pro";
  const baseUrl = (await ask(`Affine URL [${defaultUrl}]: `)) || defaultUrl;

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
    console.error("Not logged in. Run: affine-mcp login");
    process.exit(1);
  }
  console.error(`Config: ${CONFIG_FILE}`);
  console.error(`URL:       ${config.AFFINE_BASE_URL || "(default)"}`);
  console.error(`Token:     ${config.AFFINE_API_TOKEN.slice(0, 10)}...`);
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
    console.error(`Connection failed: ${err.message}`);
    process.exit(1);
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
  await fn();
  return true;
}
