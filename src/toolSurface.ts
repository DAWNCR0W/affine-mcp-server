const ALL_TOOLS = [
  "add_database_column",
  "add_database_row",
  "add_doc_to_collection",
  "add_organize_link",
  "add_surface_element",
  "add_tag_to_doc",
  "analyze_doc_fidelity",
  "append_block",
  "append_markdown",
  "append_semantic_section",
  "cleanup_blobs",
  "clear_doc_property",
  "compose_database_from_intent",
  "create_collection",
  "create_comment",
  "create_custom_property",
  "create_doc",
  "create_doc_from_markdown",
  "create_folder",
  "create_semantic_page",
  "create_tag",
  "create_workspace",
  "create_workspace_blueprint",
  "current_user",
  "delete_blob",
  "delete_block",
  "delete_collection",
  "delete_comment",
  "delete_custom_property",
  "delete_database_row",
  "delete_doc",
  "delete_folder",
  "delete_organize_link",
  "delete_surface_element",
  "delete_tag",
  "delete_workspace",
  "export_doc_markdown",
  "export_with_fidelity_report",
  "find_doc_by_title",
  "generate_access_token",
  "get_capabilities",
  "get_collection",
  "get_doc",
  "get_doc_icon",
  "get_edgeless_canvas",
  "get_folder_icon",
  "get_orphan_docs",
  "get_workspace",
  "inspect_template_structure",
  "instantiate_template_native",
  "list_access_tokens",
  "list_children",
  "list_collections",
  "list_comments",
  "list_doc_properties",
  "list_docs",
  "list_docs_by_tag",
  "list_histories",
  "list_notifications",
  "list_organize_nodes",
  "list_surface_elements",
  "list_tags",
  "list_workspace_tree",
  "list_workspaces",
  "move_doc",
  "move_organize_node",
  "publish_doc",
  "read_all_notifications",
  "read_database_cells",
  "read_database_columns",
  "read_doc",
  "remove_doc_from_collection",
  "remove_tag_from_doc",
  "rename_folder",
  "replace_doc_with_markdown",
  "resolve_comment",
  "revoke_access_token",
  "revoke_doc",
  "search_docs",
  "set_doc_property",
  "sign_in",
  "update_collection",
  "update_collection_rules",
  "update_comment",
  "update_database_row",
  "update_doc_icon",
  "update_doc_title",
  "update_edgeless_block",
  "update_folder_icon",
  "update_frame_children",
  "update_profile",
  "update_settings",
  "update_surface_element",
  "update_workspace",
  "upload_blob",
] as const;

type ToolName = typeof ALL_TOOLS[number];
type ToolProfile = "full" | "read_only" | "core" | "authoring";
type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const TOOL_GROUPS: Record<ToolName, readonly string[]> = {
  add_database_column: ["docs", "docs.database", "docs.write", "write"],
  add_database_row: ["docs", "docs.database", "docs.write", "write"],
  add_doc_to_collection: ["organize", "organize.collections", "organize.write", "write"],
  add_organize_link: ["organize", "organize.folders", "organize.write", "experimental", "write"],
  add_surface_element: ["docs", "docs.edgeless", "docs.surface", "docs.write", "write"],
  add_tag_to_doc: ["docs", "docs.tags", "docs.write", "write"],
  analyze_doc_fidelity: ["docs", "docs.read", "docs.export", "read"],
  append_block: ["docs", "docs.write", "write"],
  append_markdown: ["docs", "docs.markdown", "docs.write", "write"],
  append_semantic_section: ["docs", "docs.semantic", "docs.write", "write"],
  cleanup_blobs: ["blobs", "blobs.write", "cleanup", "destructive", "write"],
  clear_doc_property: ["docs", "docs.properties", "docs.write", "write"],
  compose_database_from_intent: ["docs", "docs.database", "docs.intent", "docs.write", "write"],
  create_collection: ["organize", "organize.collections", "organize.write", "write"],
  create_comment: ["comments", "comments.write", "write"],
  create_custom_property: ["docs", "docs.properties", "docs.write", "write"],
  create_doc: ["docs", "docs.write", "write"],
  create_doc_from_markdown: ["docs", "docs.markdown", "docs.write", "write"],
  create_folder: ["organize", "organize.folders", "organize.write", "experimental", "write"],
  create_semantic_page: ["docs", "docs.semantic", "docs.write", "write"],
  create_tag: ["docs", "docs.tags", "docs.write", "write"],
  create_workspace: ["workspaces", "workspaces.write", "admin", "write"],
  create_workspace_blueprint: ["organize", "organize.folders", "organize.write", "experimental", "write"],
  current_user: ["users", "users.read", "read"],
  delete_blob: ["blobs", "blobs.write", "destructive", "write"],
  delete_block: ["docs", "docs.edgeless", "docs.write", "destructive", "write"],
  delete_collection: ["organize", "organize.collections", "organize.write", "destructive", "write"],
  delete_comment: ["comments", "comments.write", "destructive", "write"],
  delete_custom_property: ["docs", "docs.properties", "docs.write", "destructive", "write"],
  delete_database_row: ["docs", "docs.database", "docs.write", "destructive", "write"],
  delete_doc: ["docs", "docs.write", "destructive", "write"],
  delete_folder: ["organize", "organize.folders", "organize.write", "destructive", "experimental", "write"],
  delete_organize_link: ["organize", "organize.folders", "organize.write", "destructive", "experimental", "write"],
  delete_surface_element: ["docs", "docs.edgeless", "docs.surface", "docs.write", "destructive", "write"],
  delete_tag: ["docs", "docs.tags", "docs.write", "destructive", "write"],
  delete_workspace: ["workspaces", "workspaces.write", "admin", "destructive", "write"],
  export_doc_markdown: ["docs", "docs.export", "docs.markdown", "docs.read", "read"],
  export_with_fidelity_report: ["docs", "docs.export", "docs.markdown", "docs.read", "read"],
  find_doc_by_title: ["docs", "docs.read", "read"],
  generate_access_token: ["access_tokens", "access_tokens.write", "admin", "write"],
  get_capabilities: ["docs", "docs.read", "read"],
  get_collection: ["organize", "organize.collections", "organize.read", "read"],
  get_doc: ["docs", "docs.read", "read"],
  get_doc_icon: ["docs", "docs.read", "read"],
  get_edgeless_canvas: ["docs", "docs.edgeless", "docs.surface", "docs.read", "read"],
  get_folder_icon: ["organize", "organize.folders", "organize.read", "experimental", "read"],
  get_orphan_docs: ["docs", "docs.tree", "docs.read", "read"],
  get_workspace: ["workspaces", "workspaces.read", "read"],
  inspect_template_structure: ["docs", "docs.template", "docs.read", "read"],
  instantiate_template_native: ["docs", "docs.template", "docs.write", "write"],
  list_access_tokens: ["access_tokens", "access_tokens.read", "admin", "read"],
  list_children: ["docs", "docs.tree", "docs.read", "read"],
  list_collections: ["organize", "organize.collections", "organize.read", "read"],
  list_comments: ["comments", "comments.read", "read"],
  list_doc_properties: ["docs", "docs.properties", "docs.read", "read"],
  list_docs: ["docs", "docs.read", "read"],
  list_docs_by_tag: ["docs", "docs.tags", "docs.read", "read"],
  list_histories: ["history", "history.read", "read"],
  list_notifications: ["notifications", "notifications.read", "read"],
  list_organize_nodes: ["organize", "organize.folders", "organize.read", "experimental", "read"],
  list_surface_elements: ["docs", "docs.edgeless", "docs.surface", "docs.read", "read"],
  list_tags: ["docs", "docs.tags", "docs.read", "read"],
  list_workspace_tree: ["docs", "docs.tree", "docs.read", "read"],
  list_workspaces: ["workspaces", "workspaces.read", "read"],
  move_doc: ["docs", "docs.tree", "docs.write", "write"],
  move_organize_node: ["organize", "organize.folders", "organize.write", "experimental", "write"],
  publish_doc: ["docs", "docs.share", "docs.write", "write"],
  read_all_notifications: ["notifications", "notifications.write", "write"],
  read_database_cells: ["docs", "docs.database", "docs.read", "read"],
  read_database_columns: ["docs", "docs.database", "docs.read", "read"],
  read_doc: ["docs", "docs.read", "read"],
  remove_doc_from_collection: ["organize", "organize.collections", "organize.write", "write"],
  remove_tag_from_doc: ["docs", "docs.tags", "docs.write", "write"],
  rename_folder: ["organize", "organize.folders", "organize.write", "experimental", "write"],
  replace_doc_with_markdown: ["docs", "docs.markdown", "docs.write", "write"],
  resolve_comment: ["comments", "comments.write", "write"],
  revoke_access_token: ["access_tokens", "access_tokens.write", "admin", "destructive", "write"],
  revoke_doc: ["docs", "docs.share", "docs.write", "destructive", "write"],
  search_docs: ["docs", "docs.read", "read"],
  set_doc_property: ["docs", "docs.properties", "docs.write", "write"],
  sign_in: ["users", "users.auth", "auth", "write"],
  update_collection: ["organize", "organize.collections", "organize.write", "write"],
  update_collection_rules: ["organize", "organize.collections", "organize.write", "write"],
  update_comment: ["comments", "comments.write", "write"],
  update_database_row: ["docs", "docs.database", "docs.write", "write"],
  update_doc_icon: ["docs", "docs.write", "write"],
  update_doc_title: ["docs", "docs.write", "write"],
  update_edgeless_block: ["docs", "docs.edgeless", "docs.write", "write"],
  update_folder_icon: ["organize", "organize.folders", "organize.write", "experimental", "write"],
  update_frame_children: ["docs", "docs.edgeless", "docs.write", "write"],
  update_profile: ["users", "users.write", "admin", "write"],
  update_settings: ["users", "users.write", "admin", "write"],
  update_surface_element: ["docs", "docs.edgeless", "docs.surface", "docs.write", "write"],
  update_workspace: ["workspaces", "workspaces.write", "admin", "write"],
  upload_blob: ["blobs", "blobs.write", "write"],
};

const READ_ONLY_TOOLS = new Set<ToolName>([
  "analyze_doc_fidelity",
  "current_user",
  "export_doc_markdown",
  "export_with_fidelity_report",
  "find_doc_by_title",
  "get_capabilities",
  "get_collection",
  "get_doc",
  "get_doc_icon",
  "get_edgeless_canvas",
  "get_folder_icon",
  "get_orphan_docs",
  "get_workspace",
  "inspect_template_structure",
  "list_access_tokens",
  "list_children",
  "list_collections",
  "list_comments",
  "list_doc_properties",
  "list_docs",
  "list_docs_by_tag",
  "list_histories",
  "list_notifications",
  "list_organize_nodes",
  "list_surface_elements",
  "list_tags",
  "list_workspace_tree",
  "list_workspaces",
  "read_database_cells",
  "read_database_columns",
  "read_doc",
  "search_docs",
  "sign_in",
]);

const CORE_TOOLS = new Set<ToolName>([
  "add_database_column",
  "add_database_row",
  "add_tag_to_doc",
  "append_block",
  "append_markdown",
  "create_doc",
  "create_doc_from_markdown",
  "current_user",
  "export_doc_markdown",
  "find_doc_by_title",
  "get_capabilities",
  "get_doc",
  "get_doc_icon",
  "get_workspace",
  "list_children",
  "list_docs",
  "list_docs_by_tag",
  "list_tags",
  "list_workspaces",
  "read_database_cells",
  "read_database_columns",
  "read_doc",
  "remove_tag_from_doc",
  "replace_doc_with_markdown",
  "search_docs",
  "sign_in",
  "update_database_row",
  "update_doc_icon",
  "update_doc_title",
]);

const AUTHORING_EXCLUDED_GROUPS = new Set([
  "admin",
  "cleanup",
  "destructive",
  "experimental",
]);

const KNOWN_PROFILES = new Set<ToolProfile>(["full", "read_only", "core", "authoring"]);
const KNOWN_TOOLS = new Set<string>(ALL_TOOLS);
const KNOWN_GROUPS = new Set<string>(Object.values(TOOL_GROUPS).flat());

function parseCsv(raw: string | undefined, normalize = true): string[] {
  return (raw || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => normalize ? value.toLowerCase() : value);
}

function normalizeProfile(raw: string | undefined): { profile: ToolProfile; warning?: string } {
  const value = (raw || "full").trim().toLowerCase();
  if (KNOWN_PROFILES.has(value as ToolProfile)) {
    return { profile: value as ToolProfile };
  }
  return {
    profile: "full",
    warning: `Unknown AFFINE_TOOL_PROFILE "${raw}". Using "full". Valid profiles: ${[...KNOWN_PROFILES].join(", ")}`,
  };
}

function profileAllowsTool(profile: ToolProfile, toolName: ToolName): boolean {
  if (profile === "full") {
    return true;
  }
  if (profile === "read_only") {
    return READ_ONLY_TOOLS.has(toolName);
  }
  if (profile === "core") {
    return CORE_TOOLS.has(toolName);
  }
  const groups = TOOL_GROUPS[toolName];
  return !groups.some(group => AUTHORING_EXCLUDED_GROUPS.has(group));
}

export function createToolFilter(env: NodeJS.ProcessEnv = process.env) {
  const profileResult = normalizeProfile(env.AFFINE_TOOL_PROFILE);
  const disabledGroups = new Set(parseCsv(env.AFFINE_DISABLED_GROUPS));
  const disabledTools = new Set(parseCsv(env.AFFINE_DISABLED_TOOLS));
  const warnings: string[] = [];

  if (profileResult.warning) {
    warnings.push(profileResult.warning);
  }

  for (const group of disabledGroups) {
    if (!KNOWN_GROUPS.has(group)) {
      warnings.push(
        `Unknown group "${group}" in AFFINE_DISABLED_GROUPS. Valid groups: ${[...KNOWN_GROUPS].sort().join(", ")}`
      );
    }
  }

  for (const tool of disabledTools) {
    if (!KNOWN_TOOLS.has(tool)) {
      warnings.push(`Unknown tool "${tool}" in AFFINE_DISABLED_TOOLS.`);
    }
  }

  function isEnabled(name: string): boolean {
    const toolName = name as ToolName;
    if (!KNOWN_TOOLS.has(toolName)) {
      return profileResult.profile === "full" && disabledGroups.size === 0 && disabledTools.size === 0;
    }
    if (disabledTools.has(toolName)) {
      return false;
    }
    const groups = TOOL_GROUPS[toolName];
    if (groups.some(group => disabledGroups.has(group))) {
      return false;
    }
    return profileAllowsTool(profileResult.profile, toolName);
  }

  const enabledTools = ALL_TOOLS.filter(toolName => isEnabled(toolName));

  return {
    profile: profileResult.profile,
    disabledGroups,
    disabledTools,
    warnings,
    enabledTools,
    totalToolCount: ALL_TOOLS.length,
    isEnabled,
  };
}

export function toolFilterRequiresRegisterTool(filter: {
  profile: ToolProfile;
  disabledGroups: ReadonlySet<string>;
  disabledTools: ReadonlySet<string>;
}): boolean {
  return filter.profile !== "full" || filter.disabledGroups.size > 0 || filter.disabledTools.size > 0;
}

export function toolAnnotationsFor(name: string): ToolAnnotations {
  const toolName = name as ToolName;
  if (!KNOWN_TOOLS.has(toolName)) {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    };
  }

  const groups = TOOL_GROUPS[toolName];
  const isReadOnly = groups.includes("read") && !groups.includes("write") && !groups.includes("destructive");
  const isDestructive = groups.includes("destructive");

  return {
    readOnlyHint: isReadOnly,
    destructiveHint: isDestructive,
    idempotentHint: isReadOnly,
    openWorldHint: true,
  };
}

export function knownToolSurfaceGroups(): string[] {
  return [...KNOWN_GROUPS].sort();
}

export function knownToolSurfaceProfiles(): ToolProfile[] {
  return [...KNOWN_PROFILES];
}
