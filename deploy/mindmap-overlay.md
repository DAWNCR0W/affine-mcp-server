# Native mindmap deployment

The source branch adds eight native mindmap tools to the existing bridge. The
AGNT deployment can use the pinned 3.2.1 overlay to avoid bringing unrelated
changes from the newer fork branch into production.

## Build and verify

```sh
npm ci --ignore-scripts
npm run build
npm run test:metadata
npm run test:fast
node --test tests/test-native-mindmap.mjs
```

Export `dist/`, `package.json`, and `tool-manifest.json` from the existing
`agnt/affine-mcp-server:3.2.1-trash-v1` image to a private temporary directory.
Do not export environment variables, credentials, config files, or document data.
Run:

```sh
node scripts/build-agnt-mindmap-overlay.mjs "$BASE_EXPORT" "$OVERLAY_DIR"
docker build --network none -f deploy/Dockerfile.mindmap-overlay \
  -t agnt/affine-mcp-server:3.2.1-mindmap-v2 "$OVERLAY_DIR"
```

The generator rejects any base file whose SHA-256 differs from the verified
3.2.1 deployment. Verify the Docker base image ID against the generated
`overlay-manifest.json` too. The overlay contains the new compiled module, two
registration lines in `docs.js`, eight catalog/output-schema entries, the read-only
catalog entry, and package/manifest version metadata. Other code and dependencies
remain from the base image. No credential or transport configuration is changed.

## Rollout and rollback

Before rollout, retain the current Docker image with `docker image save`, verify
the archive, and back up the exact Compose file. Change only the `affine-mcp`
image and use `docker compose up -d --no-deps affine-mcp`. On rollback restore the
saved image reference and recreate only that service. Retain the old image until
the live fixture and independent review both pass.

Check readiness, then use the configured MCP stdio route for `tools/list` and
the new operations. Existing client sessions may need a fresh MCP connection to
discover the added schemas. Never change authentication or hooks to refresh tools.

Create a neutral test document under a verified folder, checking exactly one
sidebar link. Verify root/project/task hierarchy, rename, subtree reparent,
`left`/`balance`/`right`, and collapsed state. Reject missing/foreign parents,
cycles, root reparent, invalid IDs and `down`, then assert the persisted canvas
is unchanged by the rejected batch. Read it from a fresh MCP session and inspect
it visually in the native editor. Switch all four styles, lock the map and
verify text editing is blocked, then unlock and verify editing resumes. Compare
topology and node IDs across the switches. Do not test on a user's existing map.

The legacy `get_edgeless_canvas.elementCounts` counts only the four general
surface types; count native maps from `surfaceElements` or use `get_mindmap`.
The native editor derives connector models locally. Zero stored `connector`
elements is therefore expected for a native-only mindmap fixture.

## Compatibility sources

- [Native node model](https://github.com/toeverything/AFFiNE/blob/174ad9bc5/blocksuite/affine/model/src/elements/mindmap/mindmap.ts)
- [Direction enum](https://github.com/toeverything/AFFiNE/blob/174ad9bc5/blocksuite/affine/model/src/consts/mindmap.ts)
- [Native styles](https://github.com/toeverything/AFFiNE/blob/174ad9bc5/blocksuite/affine/model/src/elements/mindmap/style.ts)
- [Native lock inheritance](https://github.com/toeverything/AFFiNE/blob/174ad9bc5/blocksuite/framework/std/src/utils/tree.ts)
- [Layout geometry](https://github.com/toeverything/AFFiNE/blob/174ad9bc5/blocksuite/affine/gfx/mindmap/src/view/layout.ts)

Only right/left/balance are supported. A downward native layout requires a
separate editor implementation. Concurrent independent hierarchy writers are
not covered by the upstream persistence API's lack of compare-and-swap.
All four native styles are exposed via `set_mindmap_style`; native map lock is
exposed via `set_mindmap_lock`. Verify both and their persistence before rollout acceptance. See [request/response usage](../docs/native-mindmaps.md).
