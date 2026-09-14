import { createHash } from "node:crypto";
import * as Y from "yjs";

/** Include delete sets and registration: AFFiNE can retain deleted snapshots. */
export function documentRevision(doc: Y.Doc, registered = true): string {
  return createHash("sha256")
    .update(registered ? "registered\0" : "unregistered\0")
    .update(Y.encodeStateAsUpdate(doc)).digest("hex");
}

export function isDocumentRegistered(workspaceDoc: Y.Doc, docId: string): boolean {
  const pages = workspaceDoc.getMap("meta").get("pages");
  return pages instanceof Y.Array && pages.toArray().some(
    page => page instanceof Y.Map && page.get("id") === docId,
  );
}
