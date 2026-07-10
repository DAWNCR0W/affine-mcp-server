import { z } from "zod";

export const BoundedPageSize = z.number().int().min(1).max(200);
export const BoundedOffset = z.number().int().min(0).max(1_000_000);
export const BoundedSearchLimit = z.number().int().min(1).max(200);
export const BoundedTreeDepth = z.number().int().min(0).max(20);
export const BoundedHistoryTake = z.number().int().min(1).max(200);

/** Require callers to repeat a destructive resource identifier exactly. */
export function requireMatchingConfirmation(
  resourceName: string,
  expected: string,
  confirmation: string | undefined,
): void {
  if (confirmation !== expected) {
    throw new Error(
      `${resourceName} confirmation must exactly match ${JSON.stringify(expected)}.`,
    );
  }
}
