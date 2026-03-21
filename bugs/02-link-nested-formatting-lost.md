# Bug: Nested formatting inside links is lost

## Description

When a link contains formatted text (e.g. bold), the inner formatting is dropped. Only the link attribute survives.

## Steps to Reproduce

Upload a document with:

```
[**bold** link](https://example.com)
```

Inspect the stored Yjs snapshot — the text is stored as a plain link with no `bold` attribute on the inner text.

## Expected Behavior

The deltas should be:

```
{ insert: "bold", attributes: { bold: true, link: "https://example.com" } }
{ insert: " link", attributes: { link: "https://example.com" } }
```

## Root Cause

In `src/markdown/parse.ts`, the `link_open` handler calls `deltaToString(renderRange(i + 1, close))` which flattens the inner content to a plain string before applying the link attribute. It should instead call `applyAttrs(renderRange(i + 1, close), { link: href })` to merge the link attribute onto each inner delta.

## Related

Identified in PR #97 review by DAWNCR0W.
