import { z } from "zod";
import { secureAffineId } from "./random.js";

// AFFiNE 0.27.4's comment editor consumes a BlockSuite DocSnapshot, not { text }.
const BlockSnapshot: z.ZodTypeAny = z.lazy(() => z.object({
  type: z.literal("block"),
  id: z.string(),
  flavour: z.string(),
  version: z.number().optional(),
  props: z.record(z.unknown()),
  children: z.array(BlockSnapshot),
}).passthrough());

const CommentSnapshot = z.object({
  type: z.literal("page"),
  meta: z.object({
    id: z.string(),
    title: z.string(),
    createDate: z.number(),
    tags: z.array(z.string()),
  }).passthrough(),
  blocks: BlockSnapshot.refine(block => block.flavour === "affine:page", {
    message: "Comment snapshots require an affine:page root block.",
  }),
}).passthrough();

/** Preserve native comment payloads and convert plain text to a renderable snapshot. */
export function normalizeCommentContent(content: unknown): Record<string, unknown> {
  const record = typeof content === "object" && content !== null && !Array.isArray(content)
    ? content as Record<string, unknown>
    : undefined;
  if (record && "snapshot" in record) {
    CommentSnapshot.parse(record.snapshot);
    return record;
  }
  const value = typeof content === "string" ? content : record?.text;
  if (typeof value !== "string") {
    throw new Error("Comment content must be a string, { text: string }, or an AFFiNE { snapshot } payload.");
  }
  const { text: _text, ...metadata } = record ?? {};
  return {
    ...metadata,
    snapshot: {
      type: "page",
      meta: { id: secureAffineId(), title: "", createDate: Date.now(), tags: [] },
      blocks: {
        type: "block", id: "page", flavour: "affine:page", version: 2,
        props: { title: { "$blocksuite:internal:text$": true, delta: [] } },
        children: [{
          type: "block", id: "note", flavour: "affine:note", version: 1,
          props: { displayMode: "both" },
          children: [{
            type: "block", id: "paragraph", flavour: "affine:paragraph", version: 1,
            props: {
              type: "text", collapsed: false,
              text: { "$blocksuite:internal:text$": true, delta: value ? [{ insert: value }] : [] },
            },
            children: [],
          }],
        }],
      },
    },
  };
}
