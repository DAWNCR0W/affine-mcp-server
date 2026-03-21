# Bug: Quotes and callouts never receive rich text deltas

## Description

Blockquotes and callouts still go through a plain-text path (`collectQuoteText()`), so formatting inside them is always lost.

## Steps to Reproduce

Upload a document with:

```
> **bold** quote

> [!NOTE]
> before **bold** after
```

Both are stored and exported as plain text — the bold is dropped.

## Expected Behavior

Bold (and other inline formatting) inside quotes and callouts should be stored as rich text deltas, just like paragraphs and headings.

## Root Cause

`collectQuoteText()` in `src/markdown/parse.ts` calls `deltaToString()` which strips formatting. The function needs to be updated to return `TextDelta[]` instead of `string`, and the resulting deltas need to be threaded through to the quote/callout operation types.

## Related

Identified in PR #97 review by DAWNCR0W.
