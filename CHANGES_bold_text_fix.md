# Fix: Bold (and Inline Formatting) Rendering in Markdown Upload

## Problem

When uploading markdown to AFFiNE via this MCP server, inline formatting was rendered as raw syntax instead of native rich text:

- `**bold**` appeared as `**bold**` (literal asterisks)
- `*italic*` appeared as `*italic*`
- `~~strikethrough~~` appeared as `~~strikethrough~~`
- `` `code` `` appeared as `` `code` ``
- `[link text](url)` appeared as `[link text](url)`

## Root Cause

The pipeline had two problems working together:

### 1. `renderInline()` reconstructed markdown strings instead of semantic data

`src/markdown/parse.ts` — `renderInline()` (formerly line 82) took markdown-it tokens like `strong_open / text / strong_close` and reassembled them back into the raw markdown string `**text**`. The semantic meaning (bold) was thrown away.

### 2. `makeText()` inserted plain strings with no formatting attributes

`src/tools/docs.ts` — `makeText()` (formerly line 193) took that plain string and inserted it into a Y.js `Y.Text` object with no formatting attributes. Y.js supports per-character formatting (bold, italic, etc.) via attribute maps on insert, but this was never used.

## The Fix

### New type: `TextDelta` — `src/markdown/types.ts`

A delta represents one styled run of text. Modelled on the Y.js / Quill delta format:

```typescript
export type TextDelta = {
  insert: string;
  attributes?: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    code?: boolean;
    link?: string;
  };
};
```

Example: `**hello** world` becomes:
```typescript
[
  { insert: "hello", attributes: { bold: true } },
  { insert: " world" },
]
```

### `renderInline()` now returns `TextDelta[]` — `src/markdown/parse.ts`

Instead of building a string, it now builds an array of delta objects:

| Token | Before | After |
|-------|--------|-------|
| `text` | `output += token.content` | `{ insert: token.content }` |
| `code_inline` | `` output += `\`${content}\`` `` | `{ insert: content, attributes: { code: true } }` |
| `strong_open` | `` output += `**${inner}**` `` | inner deltas with `{ bold: true }` merged into attributes |
| `em_open` | `` output += `*${inner}*` `` | inner deltas with `{ italic: true }` merged |
| `s_open` | `` output += `~~${inner}~~` `` | inner deltas with `{ strike: true }` merged |
| `link_open` | `` output += `[text](href)` `` | `{ insert: linkText, attributes: { link: href } }` |
| `softbreak` / `hardbreak` | `output += "\n"` | `{ insert: "\n" }` |
| `image` | `` output += `![alt](src)` `` | `{ insert: "![alt](src)" }` (unchanged, not supported) |

Attributes are merged via `applyAttrs()`, so nested formatting (e.g. bold+italic) is handled correctly.

### `deltaToString()` helper — `src/markdown/parse.ts`

A small helper that converts `TextDelta[]` back to a plain string (just joins `.insert` fields) for places that don't need rich text:

- Table cell text
- Quote/callout text (multi-line, joining is complex — kept as plain text for now)
- Bookmark link text extraction
- Checkbox prefix stripping in todo list items

### `deltas?: TextDelta[]` added to `MarkdownOperation` — `src/markdown/types.ts`

The `text: string` field is kept on all operation types for backwards compatibility (used by the direct `append_block` tool path, which accepts user-supplied plain strings). A new optional `deltas` field carries the rich text alongside it for the markdown upload path.

Affected operation types: `heading`, `paragraph`, `quote`, `callout`, `list`.

Not affected: `code` (code block content is always plain text), `table` (cells are plain strings), `divider`, `bookmark`.

### Delta threading through the pipeline — `src/tools/docs.ts`

The deltas are passed through each layer of the conversion pipeline:

1. **`AppendBlockInput`** — `deltas?: TextDelta[]` field added
2. **`NormalizedAppendBlockInput`** — `deltas?: TextDelta[]` field added
3. **`normalizeAppendBlockInput()`** — copies `parsed.deltas` to `normalized.deltas`
4. **`markdownOperationToAppendInput()`** — passes `operation.deltas` through for heading, paragraph, quote, callout, and list operations

### `makeText()` now applies formatting — `src/tools/docs.ts`

Updated to accept `string | TextDelta[]`:

- **String path** (unchanged): inserts the whole string as plain text. Used by the direct `append_block` tool.
- **Delta path** (new): iterates the delta array, calling `yText.insert(offset, text, attrs)` for each segment. Y.js stores these attributes and AFFiNE reads them to render bold, italic, etc.

### `createBlock()` uses deltas when available — `src/tools/docs.ts`

For paragraph/heading/quote, list, and callout block types, the call is now:

```typescript
makeText(normalized.deltas ?? content)
```

If deltas are present (markdown path), rich text formatting is applied. If not (direct tool path), the plain string fallback is used — no behaviour change for existing callers.

## What is not changed

- The `render.ts` direction (AFFiNE → markdown) is unaffected. It reads `Y.Text` via `asText()` which returns the plain string content; this already strips markdown syntax so the render path was not broken.
- Table cells, blockquote/callout text, and bookmark captions remain plain strings for now. Rich text in those contexts is a separate enhancement.
- The `append_block` MCP tool continues to accept plain text strings as before.
