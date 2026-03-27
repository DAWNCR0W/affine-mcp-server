# Bug: Hard breaks lose their identity — collapse to same delta as soft breaks

## Description

Markdown hard breaks (two trailing spaces before a newline) are now emitted as the same `{ insert: "\n" }` delta as soft breaks. Hard breaks no longer round-trip correctly.

## What is a hard break?

A hard break is a forced line break *within* a paragraph, created by putting two or more trailing spaces at the end of a line:

```
first
second
```

This produces a `<br>` — a new line without starting a new paragraph. A soft break is just a plain newline with no trailing spaces, which most renderers treat as a space.

## Steps to Reproduce

Upload a document with a hard break:

```
first
second
```

Export the document back to markdown. The result is `first\nsecond` — the two trailing spaces are gone.

## Expected Behavior

`first  \nsecond` should round-trip back to `first  \nsecond`.

## Root Cause

In `src/markdown/parse.ts`, the `hardbreak` case was changed from inserting `"  \n"` to inserting `"\n"` (same as `softbreak`). AFFiNE likely has a distinct representation for hard breaks that needs to be used here instead.

## Related

Identified in PR #97 review by DAWNCR0W.
