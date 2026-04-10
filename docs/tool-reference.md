# Tool Reference

`tool-manifest.json` is the source of truth for the canonical tool names exposed by this server.

Use this document as a grouped catalog. For exact schemas, your MCP client should inspect `tools/list`.

## Conventions

- Canonical names only: legacy alias names are not part of the public tool surface
- Document editing relies on AFFiNE WebSocket-backed operations where noted
- Experimental organize tools are marked explicitly
- Use tool filtering in production if you want a reduced or read-only surface

## Workspace

| Tool | Purpose | Notes |
| --- | --- | --- |
| `list_workspaces` | List all available workspaces | Good first discovery step |
| `get_workspace` | Read workspace details | Includes settings and metadata |
| `create_workspace` | Create a workspace with an initial document | Destructive in the sense that it creates new server state |
| `update_workspace` | Update workspace settings | Use carefully in shared workspaces |
| `delete_workspace` | Permanently delete a workspace | Destructive |
| `list_workspace_tree` | Return the workspace document hierarchy as a tree | Useful before moving docs |
| `get_orphan_docs` | Find documents that are not linked from a parent doc | Useful for cleanup and audits |

## Organization

| Tool | Purpose | Notes |
| --- | --- | --- |
| `list_collections` | List workspace collections | |
| `get_collection` | Read a collection by id | |
| `create_collection` | Create a collection | |
| `update_collection` | Rename a collection | |
| `update_collection_rules` | Replace a collection's rules and rebuild its allow-list from workspace docs | Useful for rule-backed collections |
| `delete_collection` | Delete a collection | Destructive |
| `add_doc_to_collection` | Add a document to a collection allow-list | |
| `remove_doc_from_collection` | Remove a document from a collection allow-list | |
| `list_organize_nodes` | Dump the organize or folder tree | Experimental |
| `create_folder` | Create a root or nested folder | Experimental |
| `create_workspace_blueprint` | Create a simple workspace folder blueprint | Good for structured onboarding setups |
| `rename_folder` | Rename a folder | Experimental |
| `delete_folder` | Delete a folder recursively | Experimental and destructive |
| `move_organize_node` | Move a folder or link node | Experimental |
| `add_organize_link` | Add a doc, tag, or collection link under a folder | Experimental |
| `delete_organize_link` | Delete a doc, tag, or collection link | Experimental and destructive |

## Documents

### Discovery and metadata

| Tool | Purpose | Notes |
| --- | --- | --- |
| `list_docs` | List documents with pagination | Includes `node.tags` |
| `list_tags` | List all tags in a workspace | |
| `search_docs` | Search titles with substring, prefix, or exact matching | Supports tag filter and updatedAt sorting |
| `list_docs_by_tag` | List documents with a specific tag | |
| `get_docs_by_tag` | Search documents by case-insensitive tag substring | Returns `availableTags` when nothing matches |
| `get_doc` | Read document metadata | |
| `get_doc_by_title` | Find a document by title and return Markdown content | Useful for title-based lookup |
| `read_doc` | Read block content and plain text snapshot | WebSocket-backed |
| `get_capabilities` | Inspect the server's high-level authoring and fidelity capabilities | Useful for adaptive clients |
| `analyze_doc_fidelity` | Analyze how a document maps to Markdown and which native AFFiNE structures are lossy | Good before export or migration |
| `list_children` | List direct child docs linked from a document | |
| `list_backlinks` | List parent or reference docs that link to a document | |

### Publish and visibility

| Tool | Purpose | Notes |
| --- | --- | --- |
| `publish_doc` | Make a document public | |
| `revoke_doc` | Revoke public access | |

### Create, duplicate, and move

| Tool | Purpose | Notes |
| --- | --- | --- |
| `create_doc` | Create a new document | WebSocket-backed |
| `create_doc_from_markdown` | Create a document from Markdown content | |
| `create_doc_from_template` | Clone a template doc and substitute `{{variables}}` | Can optionally link the new doc under a parent |
| `inspect_template_structure` | Inspect a template's native AFFiNE structure and native-clone support | Helps choose a clone strategy |
| `instantiate_template_native` | Instantiate a template via native AFFiNE block cloning, with optional Markdown fallback | Higher-fidelity than Markdown-only cloning |
| `duplicate_doc` | Clone a document into a new doc | Can optionally place the copy under a parent |
| `move_doc` | Move a document in the sidebar by relinking it under another parent | |
| `batch_create_docs` | Create up to 20 documents in one call | |
| `delete_doc` | Delete a document | WebSocket-backed and destructive |

### Content editing

| Tool | Purpose | Notes |
| --- | --- | --- |
| `update_doc_title` | Rename a document in workspace metadata and in the page block | |
| `append_paragraph` | Append a paragraph block | WebSocket-backed |
| `append_block` | Append canonical block types with validation and placement control | Supports text, media, embeds, database, and edgeless blocks |
| `create_semantic_page` | Create an AFFiNE-native page with an intentional section skeleton and native block composition | High-level authoring helper |
| `append_semantic_section` | Append a semantic section to an existing page by heading title | High-level authoring helper |
| `append_markdown` | Append Markdown content to an existing document | |
| `replace_doc_with_markdown` | Replace the main note content with Markdown | Overwrites main note content |
| `find_and_replace` | Preview or apply text replacement across a document | |
| `cleanup_orphan_embeds` | Remove linked-doc embeds that point to missing docs | Cleanup-oriented |

### Tags

| Tool | Purpose | Notes |
| --- | --- | --- |
| `create_tag` | Create a reusable workspace-level tag | |
| `add_tag_to_doc` | Attach a tag to a document | |
| `remove_tag_from_doc` | Detach a tag from a document | |

### Markdown export

| Tool | Purpose | Notes |
| --- | --- | --- |
| `export_doc_markdown` | Export document content as Markdown | Useful for backup and automation |
| `export_with_fidelity_report` | Export a document with a machine-readable fidelity report | Useful when native AFFiNE structures matter |

## Database blocks

| Tool | Purpose | Notes |
| --- | --- | --- |
| `compose_database_from_intent` | Create or enrich a database block from a high-level schema intent | Useful for project boards and structured tables |
| `add_database_column` | Add a column to a database block | Supports `rich-text`, `select`, `multi-select`, `number`, `checkbox`, `link`, and `date` |
| `add_database_row` | Add a row to a database block | Can set the built-in title field |
| `delete_database_row` | Delete a row by row block id | Destructive |
| `read_database_columns` | Read schema metadata, types, options, and view mappings | Useful before edits |
| `read_database_cells` | Read row titles and decoded cell values | Supports row and column filters |
| `update_database_cell` | Update a single cell or built-in title | `createOption` defaults to `true` for select-like fields |
| `update_database_row` | Update multiple cells on a row at once | `createOption` defaults to `true` |

## Comments

| Tool | Purpose | Notes |
| --- | --- | --- |
| `list_comments` | List comments on a document | |
| `list_unresolved_threads` | List unresolved comment threads on a document | Useful for review and triage flows |
| `create_comment` | Create a comment on a document | |
| `update_comment` | Update comment content | |
| `delete_comment` | Delete a comment | Destructive |
| `resolve_comment` | Resolve or unresolve a comment | |

## Version History

| Tool | Purpose | Notes |
| --- | --- | --- |
| `list_histories` | List document history timestamps | |

## Users and tokens

| Tool | Purpose | Notes |
| --- | --- | --- |
| `current_user` | Return the current signed-in user | |
| `sign_in` | Sign in with email and password | Self-hosted flows only for direct programmatic sign-in |
| `update_profile` | Update current user profile data | |
| `update_settings` | Update user notification preferences | |
| `list_access_tokens` | List personal access tokens | |
| `generate_access_token` | Create a personal access token | Sensitive operation |
| `revoke_access_token` | Revoke a personal access token | Destructive |

## Notifications

| Tool | Purpose | Notes |
| --- | --- | --- |
| `list_notifications` | List notifications for the current user | |
| `read_all_notifications` | Mark notifications as read | |

## Blob storage

| Tool | Purpose | Notes |
| --- | --- | --- |
| `upload_blob` | Upload a file or blob to workspace storage | |
| `delete_blob` | Delete a blob from workspace storage | Destructive |
| `cleanup_blobs` | Permanently remove deleted blobs | Cleanup-oriented |
