# Bug: Bold Markdown Text Renders as Raw `**text**` Instead of Bold

## Summary

When uploading markdown content to AFFiNE via this MCP server, bold text formatted with `**text**` is displayed as literal asterisks rather than rendered as bold.

## Steps to Reproduce

1. Use mcporter (or any MCP client) to upload a document containing bold markdown syntax, e.g. `**bold text**`
2. Open the resulting document in AFFiNE
3. Observe the text is displayed as `**bold text**` literally instead of **bold text**

## Expected Behavior

Bold markdown syntax (`**text**`) should be converted to AFFiNE's native bold formatting so it renders as bold text in the AFFiNE UI.

## Actual Behavior

The raw markdown syntax `**text**` is displayed as-is, with the asterisks visible to the user.

## Environment

- affine-mcp-server version: 1.9.0
- Client: mcporter

## Notes

This is likely a markdown-to-AFFiNE block conversion issue, where the markdown parser is not translating inline bold syntax into the appropriate AFFiNE rich text format before uploading.
