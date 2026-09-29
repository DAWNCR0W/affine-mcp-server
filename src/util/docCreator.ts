import type { GraphQLClient } from "../graphqlClient.js";
import * as Y from "yjs";
import { loadDoc, pushDocUpdate, type WorkspaceSocket } from "../ws.js";

export type DocumentCreatorTransport = {
  loadDoc: typeof loadDoc;
  pushDocUpdate: typeof pushDocUpdate;
};

const defaultTransport: DocumentCreatorTransport = { loadDoc, pushDocUpdate };

/** Resolve the authenticated AFFiNE user for one operation; do not cache identity across sessions. */
export async function fetchCurrentUserId(gql: Pick<GraphQLClient, "request">): Promise<string> {
  const data = await gql.request<{ currentUser?: { id?: unknown } | null }>(
    "query CurrentDocumentCreator { currentUser { id } }",
  );
  const id = data?.currentUser?.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("The authenticated AFFiNE user id is missing or invalid.");
  }
  return id;
}

/** AFFiNE 0.27.4 wire id for the workspace-scoped docProperties sub-document. */
export function docPropertiesDocId(workspaceId: string): string {
  // AFFiNE 0.27.4 `newIdToOldId` expands the db$docProperties table guid this way.
  return `db$${workspaceId}$docProperties`;
}

export async function readDocumentCreator(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  transport: DocumentCreatorTransport = defaultTransport,
): Promise<{ id: unknown; createdBy: unknown } | null> {
  const snapshot = await transport.loadDoc(socket, workspaceId, docPropertiesDocId(workspaceId));
  if (typeof snapshot.missing !== "string") return null;

  const propertiesDoc = new Y.Doc();
  try {
    Y.applyUpdate(propertiesDoc, Buffer.from(snapshot.missing, "base64"));
    if (!propertiesDoc.share.has(docId)) return null;
    const record = propertiesDoc.getMap(docId);
    return { id: record.get("id"), createdBy: record.get("createdBy") };
  } finally {
    propertiesDoc.destroy();
  }
}

function hasNonEmptyValue(value: unknown): boolean {
  return value !== null && value !== undefined
    && !(typeof value === "string" && value.trim().length === 0);
}

function assertCreatorIsValid(value: unknown, docId: string): void {
  if (hasNonEmptyValue(value) && typeof value !== "string") {
    throw new Error(`Document ${docId} has a non-string createdBy value; it was preserved.`);
  }
}

/** Set the document id and creator without replacing existing properties or creator data. */
export async function ensureDocumentCreator(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  creatorId: string,
  transport: DocumentCreatorTransport = defaultTransport,
): Promise<void> {
  if (typeof creatorId !== "string" || !creatorId.trim()) {
    throw new Error("A non-empty authenticated AFFiNE user id is required to set document creator metadata.");
  }

  const snapshot = await transport.loadDoc(socket, workspaceId, docPropertiesDocId(workspaceId));
  const propertiesDoc = new Y.Doc();
  try {
    if (typeof snapshot.missing === "string") {
      Y.applyUpdate(propertiesDoc, Buffer.from(snapshot.missing, "base64"));
    }

    const record = propertiesDoc.getMap(docId);
    const existingId = record.get("id");
    const existingCreator = record.get("createdBy");
    if (hasNonEmptyValue(existingId) && existingId !== docId) {
      throw new Error(`Document ${docId} has a conflicting id property; it was preserved.`);
    }
    assertCreatorIsValid(existingCreator, docId);

    const previousState = Y.encodeStateVector(propertiesDoc);
    const setId = existingId !== docId;
    const setCreator = !hasNonEmptyValue(existingCreator);
    if (!setId && !setCreator) return;
    if (setId) record.set("id", docId);
    if (setCreator) record.set("createdBy", creatorId);
    const update = Buffer.from(Y.encodeStateAsUpdate(propertiesDoc, previousState)).toString("base64");

    try {
      await transport.pushDocUpdate(socket, workspaceId, docPropertiesDocId(workspaceId), update);
    } catch (writeError) {
      try {
        const confirmed = await readDocumentCreator(socket, workspaceId, docId, transport);
        assertCreatorIsValid(confirmed?.createdBy, docId);
        if (
          confirmed?.id === docId
          && typeof confirmed.createdBy === "string"
          && confirmed.createdBy.trim().length > 0
        ) return;
      } catch (readError) {
        throw new Error(
          `Document creator write could not be confirmed: ${errorMessage(writeError)}; `
          + `${errorMessage(readError)}`,
        );
      }
      throw new Error(`Document creator write was not persisted: ${errorMessage(writeError)}`);
    }
  } finally {
    propertiesDoc.destroy();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
