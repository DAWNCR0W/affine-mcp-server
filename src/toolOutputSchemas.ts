import { z, type ZodRawShape, type ZodTypeAny } from "zod";

import type { ToolName } from "./toolSurface.js";

type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "nullableString"
  | "nullableNumber"
  | "stringArray"
  | "unknownArray"
  | "object"
  | "nullableObject"
  | "icon"
  | "unknown";

type OutputSpec = {
  fields: Record<string, FieldKind>;
  optional?: boolean;
};

/** Builds a top-level tool output specification. */
const spec = (fields: OutputSpec["fields"], optional = false): OutputSpec => ({ fields, optional });

/** Builds the shared mutation-receipt fields plus tool-specific fields. */
const receipt = (fields: OutputSpec["fields"], optional = false): OutputSpec =>
  spec({ kind: "string", ok: "boolean", ...fields }, optional);

/**
 * Top-level fields advertised for each tool result. Complex AFFiNE payloads are
 * intentionally typed as objects/arrays here while their stable top-level
 * contract remains explicit. Schemas are passthrough so newly-added AFFiNE
 * fields remain backward compatible until they are promoted into this map.
 */
const OUTPUT_SPECS = {
  add_database_column: spec({ added: "boolean", columnId: "string", name: "string", type: "string" }),
  add_database_row: spec({ added: "boolean", rowBlockId: "string", databaseBlockId: "string", cellCount: "number", linkedDocId: "nullableString" }),
  add_doc_to_collection: spec({ id: "string", name: "string", rules: "object", allowList: "stringArray" }),
  add_organize_link: spec({ id: "string", parentId: "nullableString", type: "string", data: "string", index: "string" }),
  add_surface_element: spec({ added: "boolean", elementId: "string", type: "string", surfaceBlockId: "string", ignored: "stringArray" }),
  add_tag_to_doc: spec({ workspaceId: "string", docId: "string", tag: "string", added: "boolean", tags: "stringArray", docMetaSynced: "boolean", warning: "nullableString" }),
  analyze_doc_fidelity: spec({ docId: "string", exists: "boolean", unsupportedBlocks: "unknownArray", conditionallyRiskyBlocks: "unknownArray" }),
  append_block: receipt({ workspaceId: "nullableString", docId: "string", appended: "boolean", blockId: "string", flavour: "string", type: "nullableString", blockType: "nullableString", normalizedType: "string", legacyType: "nullableString" }),
  append_markdown: receipt({ workspaceId: "string", docId: "string", appended: "boolean", appendedCount: "number", blockIds: "stringArray", warnings: "stringArray", lossy: "boolean", stats: "object" }),
  append_semantic_section: spec({ workspaceId: "string", docId: "string", noteId: "string", sectionTitle: "string", sectionHeadingId: "string", afterSectionTitle: "nullableString", blockIds: "stringArray", appendedCount: "number" }),
  cleanup_blobs: spec({ success: "boolean", workspaceId: "string", blobsReleased: "number", error: "string" }, true),
  clear_doc_property: spec({ workspaceId: "string", docId: "string", propertyId: "string", cleared: "boolean" }),
  compose_database_from_intent: spec({ workspaceId: "string", docId: "string", intent: "string", title: "string", databaseBlockId: "string", primaryViewId: "nullableString", viewIds: "stringArray", columnIds: "stringArray", rowBlockIds: "stringArray", columns: "unknownArray", views: "unknownArray", warnings: "stringArray", lossy: "boolean", stats: "object" }),
  create_collection: spec({ id: "string", name: "string", rules: "object", allowList: "stringArray" }),
  create_comment: receipt({ workspaceId: "string", docId: "string", commentId: "string", id: "string", comment: "object" }),
  create_custom_property: spec({ workspaceId: "string", propertyId: "string", name: "string", type: "string", index: "string", created: "boolean" }),
  create_doc: receipt({ workspaceId: "string", docId: "string", title: "string", parentDocId: "nullableString", linkedToParent: "boolean", folderId: "nullableString", folderLinked: "boolean", folderNodeId: "nullableString", warnings: "stringArray" }),
  create_doc_from_markdown: receipt({ workspaceId: "string", docId: "string", title: "string", parentDocId: "nullableString", linkedToParent: "boolean", warnings: "stringArray", lossy: "boolean", stats: "object" }),
  create_folder: spec({ id: "string", parentId: "nullableString", type: "string", data: "string", index: "string", storageDocId: "string" }),
  create_semantic_page: spec({ workspaceId: "string", docId: "string", title: "string", pageType: "string", pageId: "string", noteId: "string", sectionCount: "number", sectionHeadingIds: "stringArray", blockIds: "stringArray", parentLinked: "boolean", warnings: "stringArray" }),
  create_tag: spec({ workspaceId: "string", tag: "string", created: "boolean" }),
  create_workspace: receipt({ workspaceId: "string", id: "string", name: "string", avatar: "string", firstDocId: "string", syncStatus: "string", status: "string", message: "string", url: "string", error: "string" }, true),
  create_workspace_blueprint: spec({ workspaceId: "string", rootFolderId: "string", rootFolderName: "string", childFolders: "unknownArray", childFolderCount: "number", storageDocId: "string" }),
  current_user: spec({ id: "string", name: "string", email: "string", emailVerified: "boolean", avatarUrl: "nullableString", disabled: "boolean" }),
  delete_blob: spec({ success: "boolean", key: "string", workspaceId: "string", permanently: "boolean", error: "string" }, true),
  delete_block: spec({ deleted: "boolean", blockId: "string", reason: "string", deletedIds: "stringArray", prunedConnectors: "stringArray" }, true),
  delete_collection: spec({ success: "boolean", collectionId: "string" }),
  delete_comment: receipt({ commentId: "string", id: "string", success: "boolean" }),
  delete_custom_property: spec({ workspaceId: "string", propertyId: "string", name: "string", deleted: "boolean" }),
  delete_database_row: spec({ deleted: "boolean", rowBlockId: "string", databaseBlockId: "string" }),
  delete_doc: receipt({ workspaceId: "string", docId: "string", deleted: "boolean" }),
  delete_folder: spec({ success: "boolean", deletedIds: "stringArray" }),
  delete_organize_link: spec({ success: "boolean", nodeId: "string" }),
  delete_surface_element: spec({ deleted: "boolean", elementId: "string", reason: "string", prunedConnectors: "stringArray" }, true),
  delete_tag: spec({ workspaceId: "string", tag: "string", tagId: "string", value: "string", deleted: "boolean", affectedDocs: "number", docMetaSynced: "boolean", warnings: "stringArray" }),
  delete_workspace: spec({ kind: "string", ok: "boolean", workspaceId: "string", id: "string", deleted: "boolean", success: "boolean", message: "string", error: "string" }, true),
  export_doc_markdown: spec({ docId: "string", title: "nullableString", tags: "stringArray", exists: "boolean", markdown: "string", warnings: "stringArray", lossy: "boolean", stats: "object" }),
  export_with_fidelity_report: spec({ docId: "string", exists: "boolean", markdown: "string", fidelity: "object" }),
  find_doc_by_title: spec({ query: "string", caseInsensitive: "boolean", matches: "unknownArray", workspaceDocCount: "number", truncated: "boolean" }),
  generate_access_token: spec({ id: "string", name: "string", createdAt: "string", expiresAt: "nullableString", token: "string" }),
  get_capabilities: spec({ server: "object", docs: "object" }),
  get_collection: spec({ id: "string", name: "string", rules: "object", allowList: "stringArray" }),
  get_doc: spec({ id: "string" }),
  get_doc_icon: receipt({ workspaceId: "string", docId: "string", icon: "icon", hasIcon: "boolean" }),
  get_edgeless_canvas: spec({ docId: "string", exists: "boolean", surfaceBlockId: "nullableString", edgelessBlocks: "unknownArray", surfaceElements: "unknownArray", bounds: "nullableObject", elementCounts: "object" }),
  get_folder_icon: receipt({ workspaceId: "string", folderId: "string", icon: "icon", hasIcon: "boolean" }),
  get_orphan_docs: spec({ count: "number", orphans: "unknownArray" }, true),
  get_workspace: spec({ id: "string", public: "boolean", enableAi: "boolean", createdAt: "string", permissions: "object", error: "string" }, true),
  inspect_template_structure: spec({ workspaceId: "string", templateDocId: "string", title: "string", tags: "stringArray", pageId: "nullableString", surfaceId: "nullableString", noteId: "nullableString", rootBlockIds: "stringArray", blockCount: "number", blocks: "unknownArray", nativeCloneSupported: "boolean", fallbackReasons: "stringArray" }),
  instantiate_template_native: spec({ workspaceId: "string", sourceTemplateDocId: "string", docId: "string", title: "string", mode: "string", nativeCloneSupported: "boolean", linkedToParent: "boolean", preservedTags: "stringArray", replacedVariableCount: "number", unresolvedVariables: "stringArray", warnings: "stringArray", blockCount: "number", rootBlockIds: "stringArray" }, true),
  list_access_tokens: spec({ items: "unknownArray", error: "string" }, true),
  list_children: spec({ docId: "string", count: "number", children: "unknownArray" }, true),
  list_collections: spec({ items: "unknownArray" }),
  list_comments: spec({ totalCount: "number", pageInfo: "object", edges: "unknownArray" }),
  list_doc_properties: spec({ workspaceId: "string", docId: "string", definitions: "unknownArray", properties: "unknownArray", orphanValues: "unknownArray" }),
  list_docs: spec({ items: "unknownArray" }),
  list_docs_by_tag: spec({ workspaceId: "string", tag: "string", ignoreCase: "boolean", totalDocs: "number", docs: "unknownArray" }),
  list_histories: spec({ items: "unknownArray" }),
  list_notifications: spec({ items: "unknownArray", error: "string" }, true),
  list_organize_nodes: spec({ workspaceId: "string", storageDocId: "string", nodes: "unknownArray" }),
  list_surface_elements: spec({ docId: "string", exists: "boolean", surfaceBlockId: "nullableString", count: "number", elements: "unknownArray" }),
  list_tags: spec({ workspaceId: "string", totalTags: "number", tags: "unknownArray" }),
  list_workspace_tree: spec({ workspaceId: "string", totalDocs: "number", rootCount: "number", tree: "unknownArray" }, true),
  list_workspaces: spec({ items: "unknownArray", error: "string" }, true),
  move_doc: receipt({ workspaceId: "string", moved: "boolean", docId: "string", toParentDocId: "string", removedFromParent: "boolean" }),
  move_organize_node: spec({ id: "string", parentId: "nullableString", index: "string" }),
  publish_doc: receipt({ workspaceId: "string", docId: "string" }),
  read_all_notifications: spec({ success: "boolean", message: "string", error: "string" }, true),
  read_database_cells: spec({ rows: "unknownArray" }),
  read_database_columns: spec({ databaseBlockId: "string", title: "nullableString", rowCount: "number", columnCount: "number", titleColumnId: "nullableString", columns: "unknownArray", views: "unknownArray" }),
  read_doc: spec({ docId: "string", title: "nullableString", tags: "stringArray", exists: "boolean", blockCount: "number", blocks: "unknownArray", plainText: "string", markdown: "string" }, true),
  remove_doc_from_collection: spec({ id: "string", name: "string", rules: "object", allowList: "stringArray" }),
  remove_tag_from_doc: spec({ workspaceId: "string", docId: "string", tag: "string", removed: "boolean", tags: "stringArray", docMetaSynced: "boolean", warning: "nullableString" }),
  rename_folder: spec({ id: "string", name: "string" }),
  replace_doc_with_markdown: receipt({ workspaceId: "string", docId: "string", replaced: "boolean", warnings: "stringArray", lossy: "boolean", stats: "object" }),
  resolve_comment: receipt({ commentId: "string", id: "string", resolved: "boolean", success: "boolean" }),
  revoke_access_token: spec({ success: "boolean" }),
  revoke_doc: receipt({ workspaceId: "string", docId: "string" }),
  search_docs: spec({ query: "string", tag: "nullableString", matchMode: "string", sortBy: "string", sortDirection: "string", totalCount: "number", results: "unknownArray" }, true),
  set_doc_property: spec({ workspaceId: "string", docId: "string", propertyId: "string", name: "string", type: "string", value: "unknown", stored: "unknown", updated: "boolean" }),
  sign_in: spec({ signedIn: "boolean" }),
  update_collection: spec({ id: "string", name: "string", rules: "object", allowList: "stringArray" }),
  update_collection_rules: spec({ workspaceId: "string", collectionId: "string", rules: "object", allowList: "stringArray", matchedDocIds: "stringArray", matchedCount: "number" }),
  update_comment: receipt({ commentId: "string", id: "string", success: "boolean" }),
  update_database_row: spec({ updated: "boolean", rowBlockId: "string", cellCount: "number" }),
  update_doc_icon: receipt({ workspaceId: "string", docId: "string", icon: "icon", cleared: "boolean" }),
  update_doc_title: receipt({ workspaceId: "string", updated: "boolean", docId: "string", title: "string" }),
  update_edgeless_block: spec({ updated: "boolean", blockId: "string", flavour: "string", changed: "stringArray", ignored: "stringArray" }),
  update_folder_icon: receipt({ workspaceId: "string", folderId: "string", icon: "icon", cleared: "boolean" }),
  update_frame_children: spec({ updated: "boolean", blockId: "string", flavour: "string", ownedIds: "stringArray", missing: "stringArray", resized: "boolean", xywh: "string" }, true),
  update_profile: spec({ id: "string", name: "string", avatarUrl: "nullableString", error: "string" }, true),
  update_settings: spec({ success: "boolean", error: "string" }, true),
  update_surface_element: spec({ updated: "boolean", elementId: "string", type: "nullableString", changed: "stringArray", ignored: "stringArray" }),
  update_workspace: spec({ kind: "string", ok: "boolean", workspaceId: "string", id: "string", error: "string" }, true),
  upload_blob: spec({ id: "string", key: "string", workspaceId: "string", filename: "string", contentType: "string", size: "number", uploadedAt: "string", error: "string" }, true),
} satisfies Record<ToolName, OutputSpec>;

/** Converts a compact field kind into its runtime Zod schema. */
function fieldSchema(kind: FieldKind): ZodTypeAny {
  switch (kind) {
    case "string": return z.string();
    case "number": return z.number();
    case "boolean": return z.boolean();
    case "nullableString": return z.string().nullable();
    case "nullableNumber": return z.number().nullable();
    case "stringArray": return z.array(z.string());
    case "unknownArray": return z.array(z.unknown());
    case "object": return z.record(z.string(), z.unknown());
    case "nullableObject": return z.record(z.string(), z.unknown()).nullable();
    case "icon": return z.union([
      z.string(),
      z.object({ type: z.literal("emoji"), unicode: z.string() }),
      z.object({ type: z.literal("icon"), name: z.string() }),
      z.null(),
    ]);
    case "unknown": return z.unknown();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled FieldKind: ${exhaustive}`);
    }
  }
}

/** Returns the declared structured-result schema for a canonical MCP tool. */
export function toolOutputSchemaFor(name: string): ZodTypeAny | undefined {
  const outputSpec = OUTPUT_SPECS[name as ToolName];
  if (!outputSpec) return undefined;

  const shape: ZodRawShape = {};
  for (const [field, kind] of Object.entries(outputSpec.fields)) {
    const schema = fieldSchema(kind);
    shape[field] = outputSpec.optional ? schema.optional() : schema;
  }
  return z.object(shape).passthrough();
}
