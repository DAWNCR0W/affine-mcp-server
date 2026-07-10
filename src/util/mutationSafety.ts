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
    return {
      status: "moved",
      moved: true,
      partial: false,
      linkedToNewParent: true,
      addedToNewParent: !alreadyLinked,
      removedFromParent,
      requiresManualRepair: false,
      warnings: removedFromParent
        ? []
        : ["The destination link is present, but no matching link was found in the declared source parent."],
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
