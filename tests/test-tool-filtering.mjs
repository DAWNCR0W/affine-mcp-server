#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(__dirname, "..", "src", "index.ts");
const REPO_ROOT = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

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

async function inspectToolSurfacePolicy() {
  const script = `
    import { createToolFilter, toolFilterRequiresRegisterTool } from "./src/toolSurface.ts";

    const full = createToolFilter({ AFFINE_TOOL_PROFILE: "full" });
    const readOnly = createToolFilter({ AFFINE_TOOL_PROFILE: "read_only" });
    const disabled = createToolFilter({ AFFINE_DISABLED_TOOLS: "create_doc" });

    console.log(JSON.stringify({
      fullUnknown: full.isEnabled("future_tool"),
      readOnlyUnknown: readOnly.isEnabled("future_tool"),
      disabledUnknown: disabled.isEnabled("future_tool"),
      fullRequiresRegisterTool: toolFilterRequiresRegisterTool(full),
      readOnlyRequiresRegisterTool: toolFilterRequiresRegisterTool(readOnly),
      disabledRequiresRegisterTool: toolFilterRequiresRegisterTool(disabled)
    }));
  `;
  const { stdout } = await execFileAsync("npx", ["tsx", "--eval", script], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  return JSON.parse(stdout);
}

async function run() {
  console.log("🚀 Starting Tool Filtering Tests...\n");

  let hasFailures = false;
  try {
    // 0. Removed convenience wrappers are not registered on the default surface.
    console.log("Case 0: Removed convenience wrappers stay absent");
    const allTools = await testFiltering();
    const removedTools = [
      "append_paragraph",
      "batch_create_docs",
      "cleanup_orphan_embeds",
      "create_doc_from_template",
      "duplicate_doc",
      "find_and_replace",
      "get_doc_by_title",
      "get_docs_by_tag",
      "list_backlinks",
      "list_unresolved_threads",
      "update_database_cell",
    ];
    const stillRegistered = removedTools.filter(t => allTools.includes(t));
    if (allTools.length === 94 && stillRegistered.length === 0) {
      console.log("✅ Success: Default tool surface exposes 94 tools.");
    } else {
      console.error(`❌ Failed: Default tool surface mismatch. count=${allTools.length} stillRegistered=${stillRegistered.join(", ")}`);
      hasFailures = true;
    }

    // 1. Test "users" group consolidation
    console.log("\nCase 1: Disable group 'users'");
    const tools1 = await testFiltering({ AFFINE_DISABLED_GROUPS: "users" });
    const userTools = ["current_user", "sign_in", "update_profile", "update_settings"];
    const found = userTools.filter(t => tools1.includes(t));
    if (found.length === 0) {
      console.log("✅ Success: All user management tools are hidden.");
    } else {
      console.error("❌ Failed: Some user tools are still visible: " + found.join(", "));
      hasFailures = true;
    }

    // 2. Test individual tool blacklist
    console.log("\nCase 2: Disable individual tool 'update_settings'");
    const tools2 = await testFiltering({ AFFINE_DISABLED_TOOLS: "update_settings" });
    if (!tools2.includes("update_settings") && tools2.includes("current_user")) {
      console.log("✅ Success: Only 'update_settings' was filtered out.");
    } else {
      console.error("❌ Failed: Tool filtering logic inconsistent.");
      hasFailures = true;
    }

    // 3. Mixed Case and Whitespace
    console.log("\nCase 3: Case-insensitive and Whitespace tolerance");
    const tools3 = await testFiltering({ AFFINE_DISABLED_GROUPS: "  Users  " });
    if (!tools3.includes("current_user")) {
        console.log("✅ Success: Case-insensitive and whitespace group filtering works.");
    } else {
        console.error("❌ Failed: Case-insensitive/whitespace check failed.");
        hasFailures = true;
    }

    // 4. Combined Filtering (Groups + Tools)
    console.log("\nCase 4: Combined Filtering (Multiple variables)");
    const tools4 = await testFiltering({ 
        AFFINE_DISABLED_GROUPS: "comments", 
        AFFINE_DISABLED_TOOLS: "list_workspaces" 
    });
    const hiddenByGroup = !tools4.includes("list_comments"); 
    const hiddenByTool = !tools4.includes("list_workspaces");
    const visibleTool = tools4.includes("get_workspace");

    if (hiddenByGroup && hiddenByTool && visibleTool) {
        console.log("✅ Success: Multiple variables integrated correctly.");
    } else {
        console.error("❌ Failed: Combined filtering logic failure.");
        console.error(`  - Group Hidden: ${hiddenByGroup}, Tool Hidden: ${hiddenByTool}, Visible: ${visibleTool}`);
        hasFailures = true;
    }

    // 5. Fine-grained group filtering
    console.log("\nCase 5: Fine-grained database group filtering");
    const tools5 = await testFiltering({
      AFFINE_DISABLED_GROUPS: "docs.database",
    });
    const databaseTools = [
      "add_database_column",
      "add_database_row",
      "compose_database_from_intent",
      "read_database_cells",
      "read_database_columns",
      "update_database_row",
    ];
    const visibleDatabaseTools = databaseTools.filter(t => tools5.includes(t));
    if (visibleDatabaseTools.length === 0 && tools5.includes("read_doc")) {
      console.log("✅ Success: Database tools are hidden without disabling all docs tools.");
    } else {
      console.error("❌ Failed: Fine-grained database filtering failed: " + visibleDatabaseTools.join(", "));
      hasFailures = true;
    }

    // 6. Read-only profile
    console.log("\nCase 6: Read-only profile hides mutating tools");
    const tools6 = await testFiltering({
      AFFINE_TOOL_PROFILE: "read_only",
    });
    const readOnlyHidden = [
      "create_doc",
      "append_block",
      "delete_doc",
      "update_database_row",
      "add_surface_element",
      "read_all_notifications",
    ];
    const visibleWrites = readOnlyHidden.filter(t => tools6.includes(t));
    const expectedReads = ["read_doc", "search_docs", "get_edgeless_canvas", "list_comments"];
    const missingReads = expectedReads.filter(t => !tools6.includes(t));
    if (visibleWrites.length === 0 && missingReads.length === 0) {
      console.log("✅ Success: Read-only profile keeps read tools and hides write tools.");
    } else {
      console.error(`❌ Failed: Read-only profile mismatch. visibleWrites=${visibleWrites.join(", ")} missingReads=${missingReads.join(", ")}`);
      hasFailures = true;
    }

    // 7. Core profile trims administrative, destructive, and experimental tools
    console.log("\nCase 7: Core profile trims administrative, destructive, and experimental tools");
    const tools7 = await testFiltering({
      AFFINE_TOOL_PROFILE: "core",
    });
    const trimmed = [
      "delete_workspace",
      "generate_access_token",
      "cleanup_blobs",
      "create_workspace_blueprint",
      "add_organize_link",
    ];
    const unexpectedlyVisible = trimmed.filter(t => tools7.includes(t));
    const coreExpected = ["create_doc", "append_block", "read_doc", "update_database_row"];
    const coreMissing = coreExpected.filter(t => !tools7.includes(t));
    if (unexpectedlyVisible.length === 0 && coreMissing.length === 0) {
      console.log("✅ Success: Core profile exposes the compact everyday surface.");
    } else {
      console.error(`❌ Failed: Core profile mismatch. visible=${unexpectedlyVisible.join(", ")} missing=${coreMissing.join(", ")}`);
      hasFailures = true;
    }

    // 8. Authoring profile keeps non-destructive creation/editing and hides destructive/admin tools
    console.log("\nCase 8: Authoring profile hides destructive and admin tools");
    const tools8 = await testFiltering({
      AFFINE_TOOL_PROFILE: "authoring",
    });
    const hiddenAuthoring = [
      "delete_doc",
      "delete_surface_element",
      "cleanup_blobs",
      "generate_access_token",
      "update_profile",
    ];
    const visibleRestricted = hiddenAuthoring.filter(t => tools8.includes(t));
    const expectedAuthoring = ["create_semantic_page", "instantiate_template_native", "add_surface_element", "update_surface_element"];
    const missingAuthoring = expectedAuthoring.filter(t => !tools8.includes(t));
    if (visibleRestricted.length === 0 && missingAuthoring.length === 0) {
      console.log("✅ Success: Authoring profile keeps editing tools while hiding restricted tools.");
    } else {
      console.error(`❌ Failed: Authoring profile mismatch. visible=${visibleRestricted.join(", ")} missing=${missingAuthoring.join(", ")}`);
      hasFailures = true;
    }

    // 9. Unknown tools fail closed whenever the configured surface is restricted.
    console.log("\nCase 9: Unknown tool policy stays least-privilege for restricted surfaces");
    const policy = await inspectToolSurfacePolicy();
    if (
      policy.fullUnknown === true &&
      policy.readOnlyUnknown === false &&
      policy.disabledUnknown === false &&
      policy.fullRequiresRegisterTool === false &&
      policy.readOnlyRequiresRegisterTool === true &&
      policy.disabledRequiresRegisterTool === true
    ) {
      console.log("✅ Success: Unknown tools and missing registerTool handling stay least-privilege.");
    } else {
      console.error("❌ Failed: Tool surface policy mismatch.");
      console.error(JSON.stringify(policy, null, 2));
      hasFailures = true;
    }

    process.exit(hasFailures ? 1 : 0);

  } catch (error) {
    console.error("💥 Test runner failed:", error);
    process.exit(1);
  }
}

run();
