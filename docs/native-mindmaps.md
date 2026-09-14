# Native mindmap tools

Build and edit a native AFFiNE mindmap with one shape per node. Nodes belong to
the mindmap's own hierarchy and remain editable with AFFiNE's mindmap toolbar.
Ordinary surface connectors are not created: the editor derives its connectors
from the native parent links.

## Supported operations

All tools take `docId`; pass `workspaceId` explicitly unless a default is set.
Existing maps additionally require `mindmapId`.

| Tool | Required operation fields | Optional fields | Result |
| --- | --- | --- | --- |
| `create_mindmap` | `text` | `layout`, `style`, `x`, `y` | `mindmapId`, `rootId` |
| `get_mindmap` | `mindmapId` | — | Ordered hierarchy, text, bounds, current layout/style |
| `add_mindmap_node` | `mindmapId`, `parentId`, `text` | `beforeId` | `nodeId` |
| `update_mindmap_node` | `mindmapId`, `nodeId`, at least one of `text`/`collapsed` | — | Updated hierarchy |
| `reparent_mindmap_node` | `mindmapId`, `nodeId`, `parentId` | `beforeId` | Updated hierarchy; descendants keep their IDs |
| `set_mindmap_layout` | `mindmapId`, `layout` | — | Direction plus persisted node coordinates |
| `set_mindmap_style` | `mindmapId`, `style` (1–4) | — | Native preset plus styled/resized nodes |
| `set_mindmap_lock` | `mindmapId`, `locked` (boolean) | — | Own and effective native lock state |

Successful responses include `ok`, `workspaceId`, `docId`, `surfaceBlockId`,
`mindmapId`, `rootId`, `nodeCount`, `nodes`, `layout`, `layoutType`, `style`, and
`supportedLayouts`, `lockedBySelf`, `lockedByAncestor`, and effective `locked`. Each node includes `nodeId`, nullable `parentId`, fractional
`index`, `children` in order, `collapsed`, `text`, `lockedBySelf`, `locked`, and serialized `[x,y,w,h]` in
`xywh`. Creation, addition, update and reparent also return the affected `nodeId`.
MCP errors have `isError=true`; never treat their text or structured body as a
successful mutation receipt.

## Example: projects and individual tasks

Use a connected MCP SDK `client` and the exact IDs returned by your workspace
and folder discovery calls. `create_doc` is a separate operation: a mindmap
tool never creates or moves documents in the sidebar.

```js
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

// workspaceId and folderId were resolved from the intended live workspace.
const doc = await call('create_doc', {
  workspaceId, folderId, title: 'Native mindmap example',
});
if (!doc.folderLinked) throw new Error('Document was not linked to its folder');
const sidebar = await call('list_organize_nodes', { workspaceId });
const links = sidebar.nodes.filter(n => n.type === 'doc' && n.data === doc.docId);
if (links.length !== 1 || links[0].parentId !== folderId) {
  throw new Error('Verify document placement before editing');
}

const base = { workspaceId, docId: doc.docId };
const map = await call('create_mindmap', {
  ...base, text: 'Projects and tasks', layout: 'right', x: 100, y: 150,
});
const target = { ...base, mindmapId: map.mindmapId };
const projectA = await call('add_mindmap_node', {
  ...target, parentId: map.rootId, text: 'Project Alpha',
});
const projectB = await call('add_mindmap_node', {
  ...target, parentId: map.rootId, text: 'Project Beta',
});
const task = await call('add_mindmap_node', {
  ...target, parentId: projectA.nodeId, text: 'Prepare prototype',
});
await call('add_mindmap_node', {
  ...target, parentId: task.nodeId, text: 'Verify result',
});
await call('add_mindmap_node', {
  ...target, parentId: projectA.nodeId, text: 'Gather requirements',
  beforeId: task.nodeId,
});
await call('update_mindmap_node', {
  ...target, nodeId: task.nodeId, text: 'Prepare demo',
});
await call('reparent_mindmap_node', {
  ...target, nodeId: task.nodeId, parentId: projectB.nodeId,
}); // The "Verify result" descendant follows the task.
await call('set_mindmap_layout', { ...target, layout: 'balance' });
const verified = await call('get_mindmap', target);
```

Without `beforeId`, addition and reparent append to the parent's child list.
To reorder siblings, reparent to the same parent with a different sibling's
`beforeId`. To collapse/expand a branch, use `update_mindmap_node` with
`collapsed: true`/`false`. This preserves descendants and their parent links.
Discover an existing `mindmapId` from `get_edgeless_canvas.surfaceElements`
where `type === 'mindmap'`; discover node IDs with `get_mindmap`.

## Layout and style limits

| Direction | Native `layoutType` | Tested live |
| --- | --- | --- |
| `right` | `0` | Yes |
| `left` | `1` | Yes |
| `balance` | `2` | Yes |
| `down` / `up` | Not supported by this frontend | Rejected |

The verified AFFiNE frontend revision is `174ad9bc5`. The native styles are
`ONE=1` (white nodes, colored branches), `TWO=2` (colored nodes, orthogonal
connectors), `THREE=3` (rounded nodes), and `FOUR=4` (Kalam text, transparent
nodes). `create_mindmap` defaults to ONE and accepts an optional `style`.
`set_mindmap_style` updates the preset and each node's fields and dimensions,
including clearing a previous shadow in FOUR. Adding/reparenting also applies
the native preset so branch/depth colors remain consistent. Styles use the
frontend's pinned `@toeverything/theme` 1.1.23 palette, including light/dark black.

```js
await call('set_mindmap_style', { ...target, style: 4 });
await call('set_mindmap_lock', { ...target, locked: true });
const locked = await call('get_mindmap', target);
await call('set_mindmap_lock', { ...target, locked: false });
```

Locking uses native `lockedBySelf`, which the editor applies to the map's nodes.
Lock/unlock changes only that flag, preserving geometry, styling, and independent
node locks. A locked ancestor group can keep `locked=true` after the map is
unlocked. The other mutation tools reject a locked map, locked ancestor group,
or independently locked node because their layout can move the whole tree.
Unlock individual nodes/containing groups in the native editor first. An editor
lock does not replace workspace permissions; generic surface APIs can still
change raw fields.

Layout keeps the root anchored and preserves collapsed flags. Text dimensions
are estimated by the server; the native editor can refine font metrics and
styling when opened. Current operations support native shape nodes, at most
500 nodes and depth 64. Text is nonblank, at most 4096 characters. Node IDs
must be 1–128 ASCII letters, digits, underscores or hyphens. Use returned IDs,
not labels. Node deletion and transfer between different mindmaps are not
exposed.

## Errors, concurrency and verification

Missing parents, IDs belonging to a different map, root reparenting, cycles,
invalid sibling placement, malformed trees and shared node ownership are
rejected before any update is pushed. Mutations use a request-local Yjs document;
validation failure discards that document. A successful push is subsequently
verifiable with `get_mindmap` from another connection.

One shared MCP server serializes hierarchy changes per workspace across its
sessions, including clients using separate stdio HTTP proxies. Use
`read_doc.revision` as `expectedRevision` to reject edits based on stale document
content. Independent server processes and native editors can still race because
AFFiNE's push API has no compare-and-swap; this implementation does not claim
cross-process isolation. See [concurrent writes](configuration-and-deployment.md#concurrent-writes).
After a transport error, first read back the
document: the push may have succeeded despite a lost acknowledgement. Do not
blindly retry `create_mindmap`, `add_mindmap_node`, or `create_doc`.

Verify the hierarchy after a batch, reopen it in the native editor, and check
the document's exact sidebar link. The older `get_edgeless_canvas.elementCounts`
only counts general surface types; count `type === 'mindmap'` entries directly.

For test commands, the pinned deployment overlay, rollback, and exact upstream
source links, see [Native mindmap deployment](../deploy/mindmap-overlay.md).
