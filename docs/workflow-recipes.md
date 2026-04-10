# Workflow Recipes

This guide shows practical tool sequences for common AFFiNE workflows.

The exact JSON schema for each tool is discoverable from MCP `tools/list`. The recipes below focus on tool selection and ordering.

## 1. Discover the right workspace and document

Use when:

- you are connecting to an AFFiNE instance for the first time
- you need to locate a document before editing it

Typical tool sequence:

1. `list_workspaces`
2. `list_docs` or `search_docs`
3. `get_doc` or `read_doc`

Prompt example:

> List my workspaces, find the document titled "Launch Plan", and show me its current structure before editing anything.

## 2. Create a document and place it in the sidebar tree

Use when:

- you need a new document under an existing parent doc
- you want the new page to be visible in the workspace tree immediately

Typical tool sequence:

1. `search_docs` or `get_doc_by_title` to find the parent
2. `create_doc` or `create_doc_from_markdown`
3. `move_doc` if you created the doc before deciding its final parent
4. `list_children` to verify placement

Prompt example:

> Create a document called "Q2 Notes" under "Team Wiki", then verify that it appears as a child page.

## 3. Find documents by tag or title and clean up metadata

Use when:

- titles are inconsistent
- tags exist but you are not sure which document to open

Typical tool sequence:

1. `list_tags`
2. `get_docs_by_tag` or `list_docs_by_tag`
3. `update_doc_title`
4. `add_tag_to_doc` or `remove_tag_from_doc`

Prompt example:

> Show me documents related to onboarding, rename the outdated title, and make sure the page has the `Onboarding` tag.

## 4. Append content or replace the main note

Use when:

- you need to add content incrementally
- you already have Markdown content to import

Typical tool sequence:

1. `read_doc`
2. `append_paragraph`, `append_block`, or `append_markdown`
3. `replace_doc_with_markdown` only when you intend to overwrite the main note

Prompt example:

> Read the current document, append a short release checklist section, and leave the existing content intact.

## 5. Work with database blocks

Use when:

- you want to inspect or update an AFFiNE database
- you need to add rows or change schema

Typical tool sequence:

1. `read_doc` to inspect the page structure
2. `read_database_columns` to inspect schema
3. `add_database_column` if needed
4. `add_database_row`
5. `update_database_cell` or `update_database_row`
6. `read_database_cells` to verify

Prompt example:

> Inspect the task database on this page, add a `Due Date` column if it is missing, then add a new task row and verify the final values.

## 6. Review comments and resolve them

Use when:

- you need to triage feedback on a document
- you want to update or resolve comments after an edit

Typical tool sequence:

1. `list_comments`
2. `create_comment` or `update_comment`
3. `resolve_comment`

Prompt example:

> List unresolved comments on the document, summarize them, and resolve the ones that are already addressed in the current draft.

## 7. Publish a document or revoke public access

Use when:

- you are moving a document from draft to public view
- you need to remove public access after review

Typical tool sequence:

1. `get_doc`
2. `publish_doc` or `revoke_doc`
3. `get_doc` again to confirm visibility state

Prompt example:

> Publish the final release notes page and confirm that public access is enabled.

## 8. Export, duplicate, or clean up linked structure

Use when:

- you need a markdown backup
- you want to clone a page
- you need to remove stale linked-doc embeds

Typical tool sequence:

1. `export_doc_markdown` or `duplicate_doc`
2. `list_backlinks` or `list_children` if you need structural context
3. `cleanup_orphan_embeds` if linked-doc embeds reference deleted pages

Prompt example:

> Duplicate the template page under the current parent, export the original as Markdown, and clean up any orphaned linked-doc embeds on the copy.
