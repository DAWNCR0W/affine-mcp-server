import * as Y from "yjs";

import { loadDoc, pushDocUpdate, type WorkspaceSocket } from "../ws.js";

/**
 * AFFiNE 0.26+ stores per-doc and per-folder sidebar icons (the Notion-style
 * "Add icon" slot in the explorer) in a dedicated workspace sub-document with
 * guid `db$<workspaceId>$explorerIcon`. Inside that sub-doc each entity is a
 * top-level Y.Map keyed by `doc:<docId>` or `folder:<folderId>`:
 *
 * ```
 * subDoc.getMap("doc:abc123") => {
 *   id:   "doc:abc123",
 *   icon: { type: "emoji", unicode: "🧪" }
 * }
 * ```
 *
 * Clearing an icon removes the `icon` field but keeps `id`, so the entry stays
 * referenceable. This module centralises that schema so the doc-icon and
 * folder-icon tools share a single read/write path.
 */

/** A resolved icon value as stored by AFFiNE. */
export type ExplorerIconValue =
  | { type: "emoji"; unicode: string }
  | { type: "icon"; name: string };

/** The accepted user input: an emoji shorthand, a full value, or null to clear. */
export type ExplorerIconInput = string | ExplorerIconValue | null;

/** The top-level key identifying an explorer entity. */
export type ExplorerIconKey = `doc:${string}` | `folder:${string}`;

/** Build the sub-document guid that holds a workspace's explorer icons. */
export function explorerIconDocId(workspaceId: string): string {
  return `db$${workspaceId}$explorerIcon`;
}

/** Build the per-entity map key for a document. */
export function docIconKey(docId: string): ExplorerIconKey {
  return `doc:${docId}`;
}

/** Build the per-entity map key for an organize folder. */
export function folderIconKey(folderId: string): ExplorerIconKey {
  return `folder:${folderId}`;
}

/**
 * Coerce user input into the stored icon shape (or null to clear).
 *
 * - A bare string is treated as an emoji shorthand → `{ type: "emoji", unicode }`.
 * - A `{ type: "emoji", unicode }` or `{ type: "icon", name }` object is passed
 *   through after validation. Named-icon `name` values are not validated against
 *   AFFiNE's fixed icon set — they are written as-is.
 * - `null` clears the icon.
 */
export function normalizeIconInput(input: ExplorerIconInput): ExplorerIconValue | null {
  if (input === null) return null;

  if (typeof input === "string") {
    const unicode = input.trim();
    if (!unicode) throw new Error("icon emoji string must not be empty.");
    return { type: "emoji", unicode };
  }

  if (input.type === "emoji") {
    const unicode = input.unicode?.trim();
    if (!unicode) throw new Error("emoji icon requires a non-empty `unicode`.");
    return { type: "emoji", unicode };
  }

  if (input.type === "icon") {
    const name = input.name?.trim();
    if (!name) throw new Error("named icon requires a non-empty `name`.");
    return { type: "icon", name };
  }

  throw new Error(`Unsupported icon type: ${JSON.stringify((input as any).type)}.`);
}

async function loadExplorerIconDoc(
  socket: WorkspaceSocket,
  workspaceId: string,
): Promise<Y.Doc> {
  const snap = await loadDoc(socket, workspaceId, explorerIconDocId(workspaceId));
  const doc = new Y.Doc();
  if (snap.missing) Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
  return doc;
}

function readIcon(doc: Y.Doc, key: ExplorerIconKey): ExplorerIconValue | null {
  const map = doc.share.has(key) ? doc.getMap(key) : null;
  if (!map || !map.has("icon")) return null;
  const raw = map.get("icon");
  if (raw && typeof (raw as any).toJSON === "function") {
    return (raw as any).toJSON() as ExplorerIconValue;
  }
  return (raw as ExplorerIconValue) ?? null;
}

/**
 * Set or clear the sidebar icon for a single explorer entity.
 *
 * Loads the workspace's `explorerIcon` sub-doc, mutates only the target entry,
 * and pushes the minimal delta. Passing `icon = null` removes the `icon` field
 * while preserving the entry's `id`.
 */
export async function setExplorerIcon(
  socket: WorkspaceSocket,
  workspaceId: string,
  key: ExplorerIconKey,
  icon: ExplorerIconValue | null,
): Promise<{ key: ExplorerIconKey; icon: ExplorerIconValue | null }> {
  const doc = await loadExplorerIconDoc(socket, workspaceId);
  const prevSV = Y.encodeStateVector(doc);

  const map = doc.getMap(key);
  if (!map.has("id")) map.set("id", key);
  if (icon === null) {
    if (map.has("icon")) map.delete("icon");
  } else {
    map.set("icon", icon);
  }

  const delta = Y.encodeStateAsUpdate(doc, prevSV);
  await pushDocUpdate(
    socket,
    workspaceId,
    explorerIconDocId(workspaceId),
    Buffer.from(delta).toString("base64"),
  );

  return { key, icon };
}

/**
 * Read the current sidebar icon for a single explorer entity.
 * Returns `null` when no icon is set (or the entry does not exist).
 */
export async function getExplorerIcon(
  socket: WorkspaceSocket,
  workspaceId: string,
  key: ExplorerIconKey,
): Promise<{ key: ExplorerIconKey; icon: ExplorerIconValue | null }> {
  const doc = await loadExplorerIconDoc(socket, workspaceId);
  return { key, icon: readIcon(doc, key) };
}
