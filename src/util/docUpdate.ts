import * as Y from "yjs";

/** A one-shot capture of local transactions made after loading a document. */
export type DocUpdateCapture = {
  finish(): Uint8Array;
  dispose(): void;
};

/**
 * Capture mutation events, not a state-vector diff. Yjs state vectors describe
 * inserted structs only: encodeStateAsUpdate(doc, vector) also includes every
 * historical deletion in doc. Re-sending that history on each short-lived
 * document load makes a tiny metadata edit grow with the workspace's lifetime.
 *
 * Start after applying the server snapshot and before any local mutation. Keep
 * deletion-only transactions, merge multiple transactions, and never echo an
 * applied remote update. The captured update still requires the loaded base
 * document, exactly as a state-vector delta does; this is not a full snapshot.
 */
export function captureDocUpdate(doc: Y.Doc): DocUpdateCapture {
  const updates: Uint8Array[] = [];
  let result: Uint8Array | undefined;
  let disposed = false;
  const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (transaction.local) updates.push(update);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    doc.off("update", onUpdate);
    doc.off("destroy", dispose);
    updates.length = 0;
  };
  doc.on("update", onUpdate);
  doc.on("destroy", dispose);
  return {
    finish() {
      if (result) return result;
      if (disposed) throw new Error("Document update capture was disposed before completion.");
      result = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
      dispose();
      return result;
    },
    dispose,
  };
}
