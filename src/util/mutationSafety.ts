export type DocumentMoveStatus = "moved" | "linked" | "unchanged" | "partial";

export interface DocumentMoveOutcome {
  status: DocumentMoveStatus;
  moved: boolean;
  partial: boolean;
  linkedToNewParent: boolean;
  addedToNewParent: boolean;
  removedFromParent: boolean;
  requiresManualRepair: boolean;
  warnings: string[];
}

export interface SafeDocumentMoveDependencies {
  assertResourcesExist: () => Promise<void>;
  wouldCreateCycle: () => Promise<boolean>;
  isLinkedToNewParent: () => Promise<boolean>;
  addToNewParent: () => Promise<void>;
  removeFromOldParent: () => Promise<boolean>;
}

/** Return whether the requested move reached a complete, trustworthy state. */
export function isDocumentMoveSuccessful(outcome: DocumentMoveOutcome): boolean {
  return !outcome.partial && !outcome.requiresManualRepair;
}

export type DocumentMoveResult = DocumentMoveOutcome & {
  ok: boolean;
  error?: string;
  code?: "DOCUMENT_MOVE_PARTIAL" | "DOCUMENT_MOVE_INCONSISTENT";
  retryable?: boolean;
};

/** Build the stable tool status fields for a document move outcome. */
export function toDocumentMoveResult(outcome: DocumentMoveOutcome): DocumentMoveResult {
  if (isDocumentMoveSuccessful(outcome)) {
    return { ok: true, ...outcome };
  }

  return {
    ok: false,
    ...outcome,
    error: outcome.warnings[0] ?? "The document move did not reach a complete state.",
    code: outcome.partial ? "DOCUMENT_MOVE_PARTIAL" : "DOCUMENT_MOVE_INCONSISTENT",
    retryable: outcome.partial,
  };
}

/**
 * Coordinate a cross-document move so the existing parent link is never
 * removed before the destination link is confirmed.
 */
export async function executeSafeDocumentMove(
  input: {
    docId: string;
    toParentDocId: string;
    fromParentDocId?: string;
  },
  dependencies: SafeDocumentMoveDependencies,
): Promise<DocumentMoveOutcome> {
  if (input.docId === input.toParentDocId) {
    throw new Error("A document cannot be moved under itself.");
  }

  await dependencies.assertResourcesExist();

  if (input.fromParentDocId === input.toParentDocId) {
    const linkedToNewParent = await dependencies.isLinkedToNewParent();
    return {
      status: "unchanged",
      moved: false,
      partial: false,
      linkedToNewParent,
      addedToNewParent: false,
      removedFromParent: false,
      requiresManualRepair: !linkedToNewParent,
      warnings: linkedToNewParent
        ? ["The source and destination parent are identical; no changes were made."]
        : ["The source and destination parent are identical, but the expected link was not found."],
    };
  }

  if (await dependencies.wouldCreateCycle()) {
    throw new Error(
      `Moving document "${input.docId}" under "${input.toParentDocId}" would create a document cycle.`,
    );
  }

  const alreadyLinked = await dependencies.isLinkedToNewParent();
  if (!alreadyLinked) {
    await dependencies.addToNewParent();
  }

  if (!input.fromParentDocId) {
    return {
      status: "linked",
      moved: true,
      partial: false,
      linkedToNewParent: true,
      addedToNewParent: !alreadyLinked,
      removedFromParent: false,
      requiresManualRepair: false,
      warnings: alreadyLinked
        ? ["The destination parent already contained this document link; no duplicate was added."]
        : [],
    };
  }

  try {
    const removedFromParent = await dependencies.removeFromOldParent();
    if (!removedFromParent) {
      return {
        status: "partial",
        moved: false,
        partial: true,
        linkedToNewParent: true,
        addedToNewParent: !alreadyLinked,
        removedFromParent: false,
        requiresManualRepair: true,
        warnings: [
          "The destination link is present, but no matching link was found in the declared source parent; verify the source parent before retrying.",
        ],
      };
    }

    return {
      status: "moved",
      moved: true,
      partial: false,
      linkedToNewParent: true,
      addedToNewParent: !alreadyLinked,
      removedFromParent,
      requiresManualRepair: false,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "partial",
      moved: false,
      partial: true,
      linkedToNewParent: true,
      addedToNewParent: !alreadyLinked,
      removedFromParent: false,
      requiresManualRepair: true,
      warnings: [
        `The destination link was confirmed, but the source link could not be removed: ${message}`,
      ],
    };
  }
}

/** Abort any replacement batch that cannot be applied in full. */
export function handleMarkdownOperationFailure(
  error: unknown,
  input: { strict: boolean; replaceExisting: boolean; operationIndex: number },
): void {
  if (!input.strict && !input.replaceExisting) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const mode = input.replaceExisting ? "replace" : "strict append";
  throw new Error(
    `Markdown ${mode} aborted at operation ${input.operationIndex + 1}: ${message}`,
  );
}

export type DocumentCreationStage = "content" | "metadata";
export type DocumentCreationStatus = "partial" | "uncertain";
export type DocumentCreationPersistence = boolean | null;

export type DocumentCreationErrorInput = {
  workspaceId: string;
  docId: string;
  title: string;
  stage: DocumentCreationStage;
  contentPersisted: DocumentCreationPersistence;
  metadataPersisted: DocumentCreationPersistence;
  cause: unknown;
};

export type DocumentCreationFailure = {
  status: DocumentCreationStatus;
  workspaceId: string;
  docId: string;
  title: string;
  stage: DocumentCreationStage;
  contentPersisted: DocumentCreationPersistence;
  metadataPersisted: DocumentCreationPersistence;
  requiresManualRepair: true;
  recoveryGuidance: string;
};

export type DocumentCreationResult = DocumentCreationFailure & {
  ok: false;
  error: string;
  code: "DOCUMENT_CREATE_PARTIAL" | "DOCUMENT_CREATE_UNCERTAIN";
  retryable: false;
};

function creationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown document creation error";
}

/** Preserve the generated id when a document write cannot be proven complete. */
export class DocumentCreationError extends Error implements DocumentCreationFailure {
  readonly status: DocumentCreationStatus;
  readonly workspaceId: string;
  readonly docId: string;
  readonly title: string;
  readonly stage: DocumentCreationStage;
  readonly contentPersisted: DocumentCreationPersistence;
  readonly metadataPersisted: DocumentCreationPersistence;
  readonly requiresManualRepair = true as const;
  readonly recoveryGuidance: string;
  readonly code: DocumentCreationResult["code"];
  readonly retryable = false as const;

  constructor(input: DocumentCreationErrorInput) {
    const contentConfirmed = input.contentPersisted === true;
    const metadataMissing = input.metadataPersisted === false;
    const status: DocumentCreationStatus = contentConfirmed && metadataMissing ? "partial" : "uncertain";
    const recoveryGuidance = status === "partial"
      ? `Document "${input.docId}" content is persisted but workspace metadata is missing. Do not retry document creation; inspect this docId and repair its workspace metadata or parent link manually.`
      : `Document "${input.docId}" creation could not be fully confirmed. Do not retry document creation until this docId is inspected; reconcile existing content and workspace metadata first.`;
    const message = `Document creation ${status} at ${input.stage} for doc "${input.docId}": ${creationErrorMessage(input.cause)}. ${recoveryGuidance}`;

    super(message);
    this.name = "DocumentCreationError";
    this.status = status;
    this.workspaceId = input.workspaceId;
    this.docId = input.docId;
    this.title = input.title;
    this.stage = input.stage;
    this.contentPersisted = input.contentPersisted;
    this.metadataPersisted = input.metadataPersisted;
    this.recoveryGuidance = recoveryGuidance;
    this.code = status === "partial" ? "DOCUMENT_CREATE_PARTIAL" : "DOCUMENT_CREATE_UNCERTAIN";
  }
}

export function isDocumentCreationError(error: unknown): error is DocumentCreationError {
  return error instanceof DocumentCreationError;
}

/** Build the stable structured failure returned by every document creation caller. */
export function toDocumentCreationResult(error: DocumentCreationError): DocumentCreationResult {
  return {
    ok: false,
    status: error.status,
    workspaceId: error.workspaceId,
    docId: error.docId,
    title: error.title,
    stage: error.stage,
    contentPersisted: error.contentPersisted,
    metadataPersisted: error.metadataPersisted,
    requiresManualRepair: true,
    recoveryGuidance: error.recoveryGuidance,
    error: error.message,
    code: error.code,
    retryable: false,
  };
}
