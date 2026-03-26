#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(__dirname, "..", "src", "index.ts");

async function testFiltering(env = {}) {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  // Use npx tsx to avoid having to run tsc
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", SRC_PATH],
    env: {
      ...process.env,
      ...env,
      AFFINE_BASE_URL: "http://localhost:3000", // dummy
      AFFINE_API_TOKEN: "dummy_token",
      XDG_CONFIG_HOME: "/tmp/affine-test-" + Date.now(),
    },
  });

  await client.connect(transport);
  const result = await client.listTools();
  const toolNames = result.tools.map((t) => t.name);
  await transport.close();
  return toolNames;
}

async function run() {
  console.log("🚀 Starting Tool Filtering Tests...\n");

  try {
    // 1. Test "users" group consolidation
    console.log("Case 1: Disable group 'users'");
    const tools1 = await testFiltering({ AFFINE_DISABLED_GROUPS: "users" });
    const userTools = ["current_user", "update_profile", "update_settings"];
    const found = userTools.filter(t => tools1.includes(t));
    if (found.length === 0) {
      console.log("✅ Success: All user management tools are hidden.");
    } else {
      console.error("❌ Failed: Some user tools are still visible: " + found.join(", "));
    }

    // 2. Test individual tool blacklist
    console.log("\nCase 2: Disable individual tool 'update_settings'");
    const tools2 = await testFiltering({ AFFINE_DISABLED_TOOLS: "update_settings" });
    if (!tools2.includes("update_settings") && tools2.includes("current_user")) {
      console.log("✅ Success: Only 'update_settings' was filtered out.");
    } else {
      console.error("❌ Failed: Tool filtering logic inconsistent.");
    }

    // 3. Mixed case
    console.log("\nCase 3: Mixed Case/Whitespace check");
    const tools3 = await testFiltering({ AFFINE_DISABLED_GROUPS: " USERS " });
    if (!tools3.includes("current_user")) {
        console.log("✅ Success: Case-insensitive group filtering works.");
    }

    process.exit(found.length === 0 ? 0 : 1);
  } catch (error) {
    console.error("💥 Test runner failed:", error);
    process.exit(1);
  }
}

run();
