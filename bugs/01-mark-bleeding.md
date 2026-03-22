# Bug: Bold marks bleed into following plain text runs in Y.Text

## Description

When writing rich text deltas into `Y.Text` via `makeText()`, formatting attributes from one run bleed into the following plain-text run.

## Steps to Reproduce

Upload a document via `create_doc_from_markdown` with:

```
Hello **bold** and plain
```

Inspect the stored Yjs snapshot — `" and plain"` is stored with `bold: true` even though it should have no attributes.

## Expected Behavior

Only `"bold"` should carry `{ bold: true }`. The `" and plain"` run should have no formatting attributes.

## Root Cause

In `makeText()` in `src/tools/docs.ts`, when `attrs` is `undefined` for a plain-text delta, Y.js inherits the formatting attributes from the preceding character. This causes the plain run to be merged into the bold run.

Tested all four options locally:

| `attrs` passed to `yText.insert()` | Result |
|-------------------------------------|--------|
| `undefined` | Bleeds — merged into bold run |
| `null` | Bleeds — same as `undefined` |
| `{ bold: null }` | Correct — bold is cleared |
| `{}` | Correct — all prior marks reset |

## Fix

Pass `{}` instead of `undefined` for plain-text deltas in `makeText()`. The Y.js docs state that omitting the format parameter should produce plain text, but in practice Y.js inherits from the preceding character's attributes unless an explicit empty object is passed.

```ts
// Before (buggy)
const attrs = delta.attributes ? { ...delta.attributes } : undefined;
yText.insert(offset, delta.insert, attrs);

// After (fixed)
const attrs = delta.attributes ? { ...delta.attributes } : {};
yText.insert(offset, delta.insert, attrs);
```

## Regression Test

`tests/test-maketext-mark-bleeding.mjs` — run with `npm run test:mark-bleeding`. Currently fails, confirming the bug. Will pass once the fix is applied.

## Related

Identified in PR #97 review by DAWNCR0W.
