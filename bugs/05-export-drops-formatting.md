# Bug: Export/clone paths drop formatting — render.ts does not read Yjs attributes

## Description

Now that `create_doc_from_markdown` writes formatting attributes into Yjs, the export and clone paths (`export_doc_markdown`, `duplicate_doc`, `create_doc_from_template`, `find_and_replace`) silently drop all formatting because `render.ts` reads `Y.Text` as a plain string, ignoring attributes.

## Steps to Reproduce

1. Upload a document with bold text via `create_doc_from_markdown`
2. Export it with `export_doc_markdown` — bold syntax is missing from the output
3. Duplicate it with `duplicate_doc` — the duplicate loses all formatting

## Expected Behavior

`export_doc_markdown` should reconstruct markdown syntax from the Yjs attributes (e.g. a run with `{ bold: true }` should be wrapped in `**...**`).

## Root Cause

`render.ts` reads block text content as a plain string, ignoring the per-character attribute runs stored on `Y.Text`. It needs to be updated to iterate the Yjs delta runs and emit the appropriate markdown syntax for each attribute:

| Attribute | Markdown |
|-----------|----------|
| `bold: true` | `**text**` |
| `italic: true` | `*text*` |
| `strike: true` | `~~text~~` |
| `code: true` | `` `text` `` |
| `link: "url"` | `[text](url)` |

## Note

This is the most significant of the five bugs — it means the write and read sides of the pipeline are now mismatched. The other four bugs are also worth fixing, but this one makes the fix visibly lossy in real tool flows.

## Related

Identified in PR #97 review by DAWNCR0W.
