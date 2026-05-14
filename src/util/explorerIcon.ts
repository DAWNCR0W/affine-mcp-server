import * as Y from "yjs";
import { Socket } from "socket.io-client";

import { loadDoc, pushDocUpdate } from "../ws.js";

/**
 * Affine 0.26+ stores per-doc and per-folder sidebar icons in a dedicated
 * workspace sub-doc with guid `db$<workspaceId>$explorerIcon`. Each entity
 * is a top-level Y.Map keyed by `doc:<docId>` or `folder:<folderId>`:
 *
 * ```
 * doc.getMap("doc:abc123") => {
 *   id:   "doc:abc123",
 *   icon: { type: "emoji", unicode: "🧪" }
 * }
 * ```
 *
 * This helper updates a single entry. Removing an icon (icon = null)
 * deletes the `icon` field; the `id` field is preserved so the entry
 * stays referenceable.
 */

export type ExplorerIconValue =
  | { type: "emoji"; unicode: string }
  | { type: "icon"; name: string };

export type ExplorerIconKey = `doc:${string}` | `folder:${string}`;

export function explorerIconDocId(workspaceId: string): string {
  return `db$${workspaceId}$explorerIcon`;
}

export async function setExplorerIcon(
  socket: Socket<any, any>,
  workspaceId: string,
  key: ExplorerIconKey,
  icon: ExplorerIconValue | null,
): Promise<{ key: ExplorerIconKey; icon: ExplorerIconValue | null }> {
  const explorerDocId = explorerIconDocId(workspaceId);
  const snap = await loadDoc(socket, workspaceId, explorerDocId);
  const doc = new Y.Doc();
  if (snap.missing) Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));

  const prevSV = Y.encodeStateVector(doc);
  const map = doc.getMap(key);
  if (!map.has("id")) map.set("id", key);
  if (icon === null) {
    if (map.has("icon")) map.delete("icon");
  } else {
    map.set("icon", icon);
  }
  const delta = Y.encodeStateAsUpdate(doc, prevSV);
  await pushDocUpdate(socket, workspaceId, explorerDocId, Buffer.from(delta).toString("base64"));

  return { key, icon };
}
