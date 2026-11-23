import { AsyncLocalStorage } from "node:async_hooks";
import * as Y from "yjs";
import { documentMutationRevision, documentRevision, isDocumentRegistered } from "./documentRevision.js";
import { ToolFailure } from "./mcp.js";

// Capture the snapshot used by this MCP call and only replay updates acknowledged
// for its primary document. A read after saving may include an unseen editor's changes.
export class DocumentMutation {
  #registered: boolean | undefined;
  #doc: Y.Doc | null | undefined;
  #wrote = false;
  conflict?: { currentRevision: string | null };

  constructor(
    readonly workspaceId: string,
    readonly docId: string,
    readonly expectedRevision?: string,
  ) {}

  get hasRegistration() { return this.#registered !== undefined; }

  observeRegistration(snapshot: string | undefined): void {
    if (this.hasRegistration) return;
    this.#registered = false;
    if (!snapshot) return;
    const root = new Y.Doc();
    try {
      Y.applyUpdate(root, Buffer.from(snapshot, "base64"));
      this.#registered = isDocumentRegistered(root, this.docId);
    } finally {
      root.destroy();
    }
  }

  /** Record an explicit workspace registration after its write is acknowledged. */
  recordRegistration(): void {
    this.#registered = true;
  }

  observeSnapshot(snapshot: string | undefined): void {
    if (this.#wrote) return;
    this.#doc?.destroy();
    this.#doc = snapshot ? new Y.Doc() : null;
    if (this.#doc && snapshot) Y.applyUpdate(this.#doc, Buffer.from(snapshot, "base64"));
    if (this.expectedRevision === undefined) return;
    const currentRevision = this.revision ?? null;
    if (currentRevision !== this.expectedRevision) {
      this.conflict = { currentRevision };
      throw new Error("Document content changed before writing.");
    }
  }

  recordUpdate(updateBase64: string): void {
    if (this.#doc === undefined) throw documentRevisionUnavailable(this.docId);
    this.#doc ??= new Y.Doc();
    Y.applyUpdate(this.#doc, Buffer.from(updateBase64, "base64"));
    this.#wrote = true;
  }

  get revision(): string | null | undefined {
    if (!this.#doc) return this.#doc;
    return this.#wrote
      ? documentMutationRevision(this.#doc, this.#registered)
      : documentRevision(this.#doc, this.#registered);
  }

  destroy() { this.#doc?.destroy(); }
}

export function documentRevisionUnavailable(docId: string): ToolFailure {
  return new ToolFailure(
    `The resulting revision of document ${docId} could not be determined.`,
    "document_revision_unavailable",
    `Inspect document ${docId} before retrying because a change may have been saved.`,
  );
}

const mutationContext = new AsyncLocalStorage<DocumentMutation>();

export function runDocumentMutation<T>(mutation: DocumentMutation, run: () => T): T {
  return mutationContext.run(mutation, run);
}

export function activeDocumentMutation(workspaceId: string): DocumentMutation | undefined {
  const mutation = mutationContext.getStore();
  return mutation?.workspaceId === workspaceId ? mutation : undefined;
}
