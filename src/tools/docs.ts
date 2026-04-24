import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateKeyBetween } from "fractional-indexing";
import { GraphQLClient } from "../graphqlClient.js";
import { receipt, text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, deleteDoc as wsDeleteDoc } from "../ws.js";
import * as Y from "yjs";
import { parseMarkdownToOperations } from "../markdown/parse.js";
import { renderBlocksToMarkdown } from "../markdown/render.js";
import type { MarkdownOperation, MarkdownRenderableBlock, TextDelta } from "../markdown/types.js";
import {
  type Bound,
  DEFAULT_NOTE_XYWH,
  DEFAULT_STACK_GAP_HORIZONTAL,
  DEFAULT_STACK_GAP_VERTICAL,
  SIDE_TO_NORMALIZED_POSITION,
  encloseBounds,
  estimateConnectorLabelXYWH,
  estimateNoteHeightForMarkdown,
  formatXywhString,
  parseXywhString,
  pickConnectorSides,
  pickFurthestInDirection,
  sortByFractionalIndex,
  stackRelativeTo,
} from "../edgeless/layout.js";

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");
const MarkdownContent = z.string().min(1, "markdown required");
const APPEND_BLOCK_CANONICAL_TYPE_VALUES = [
  "paragraph",
  "heading",
  "quote",
  "list",
  "code",
  "divider",
  "callout",
  "latex",
  "table",
  "bookmark",
  "image",
  "attachment",
  "embed_youtube",
  "embed_github",
  "embed_figma",
  "embed_loom",
  "embed_html",
  "embed_linked_doc",
  "embed_synced_doc",
  "embed_iframe",
  "database",
  "data_view",
  "surface_ref",
  "frame",
  "edgeless_text",
  "note",
] as const;
type AppendBlockCanonicalType = typeof APPEND_BLOCK_CANONICAL_TYPE_VALUES[number];

const APPEND_BLOCK_LEGACY_ALIAS_MAP = {
  heading1: "heading",
  heading2: "heading",
  heading3: "heading",
  bulleted_list: "list",
  numbered_list: "list",
  todo: "list",
} as const;
type AppendBlockLegacyType = keyof typeof APPEND_BLOCK_LEGACY_ALIAS_MAP;

const APPEND_BLOCK_LIST_STYLE_VALUES = ["bulleted", "numbered", "todo"] as const;
type AppendBlockListStyle = typeof APPEND_BLOCK_LIST_STYLE_VALUES[number];
const AppendBlockListStyle = z.enum(APPEND_BLOCK_LIST_STYLE_VALUES);
const APPEND_BLOCK_BOOKMARK_STYLE_VALUES = [
  "vertical",
  "horizontal",
  "list",
  "cube",
  "citation",
] as const;
type AppendBlockBookmarkStyle = typeof APPEND_BLOCK_BOOKMARK_STYLE_VALUES[number];
const AppendBlockBookmarkStyle = z.enum(APPEND_BLOCK_BOOKMARK_STYLE_VALUES);
const APPEND_BLOCK_DATA_VIEW_MODE_VALUES = ["table", "kanban"] as const;
type AppendBlockDataViewMode = typeof APPEND_BLOCK_DATA_VIEW_MODE_VALUES[number];
const AppendBlockDataViewMode = z.enum(APPEND_BLOCK_DATA_VIEW_MODE_VALUES);
const DATABASE_INTENT_VALUES = ["task_board", "issue_tracker"] as const;
type DatabaseIntent = typeof DATABASE_INTENT_VALUES[number];
const DatabaseIntent = z.enum(DATABASE_INTENT_VALUES);
type DatabaseIntentSeedRow = Record<string, unknown>;
type DatabaseIntentColumnSpec = {
  name: string;
  type: "rich-text" | "select" | "multi-select" | "number" | "checkbox" | "link" | "date";
  options?: string[];
  width?: number;
};
type DatabaseIntentPreset = {
  title: string;
  viewName: string;
  statusOptions: string[];
  extraColumns: DatabaseIntentColumnSpec[];
  starterRows: DatabaseIntentSeedRow[];
};
const DATABASE_COLUMN_TYPE_VALUES = ["rich-text", "select", "multi-select", "number", "checkbox", "link", "date"] as const;

const MARKDOWN_EXPORT_SUPPORTED_FLAVOURS = new Set<string>([
  "affine:paragraph",
  "affine:list",
  "affine:code",
  "affine:divider",
  "affine:bookmark",
  "affine:embed-youtube",
  "affine:embed-github",
  "affine:embed-figma",
  "affine:embed-loom",
  "affine:embed-iframe",
  "affine:image",
  "affine:table",
  "affine:callout",
  "affine:note",
  "affine:page",
  "affine:surface",
]);

const KNOWN_BLOCK_FLAVOURS = new Set<string>([
  "affine:page",
  "affine:surface",
  "affine:paragraph",
  "affine:list",
  "affine:code",
  "affine:divider",
  "affine:callout",
  "affine:latex",
  "affine:table",
  "affine:bookmark",
  "affine:image",
  "affine:attachment",
  "affine:embed-youtube",
  "affine:embed-github",
  "affine:embed-figma",
  "affine:embed-loom",
  "affine:embed-html",
  "affine:embed-linked-doc",
  "affine:embed-synced-doc",
  "affine:embed-iframe",
  "affine:database",
  "affine:surface-ref",
  "affine:frame",
  "affine:edgeless-text",
  "affine:note",
]);

type AppendPlacement = {
  parentId?: string;
  afterBlockId?: string;
  beforeBlockId?: string;
  index?: number;
};

type AppendBlockInput = {
  workspaceId?: string;
  docId: string;
  type: string;
  text?: string;
  deltas?: TextDelta[];
  url?: string;
  pageId?: string;
  iframeUrl?: string;
  html?: string;
  design?: string;
  reference?: string;
  refFlavour?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  background?: string;
  sourceId?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  embed?: boolean;
  rows?: number;
  columns?: number;
  latex?: string;
  checked?: boolean;
  language?: string;
  caption?: string;
  level?: number;
  style?: AppendBlockListStyle;
  bookmarkStyle?: AppendBlockBookmarkStyle;
  viewMode?: AppendBlockDataViewMode;
  strict?: boolean;
  placement?: AppendPlacement;
  tableData?: string[][];
  tableCellDeltas?: TextDelta[][][];
  markdown?: string;
  childElementIds?: string[];
  stackAfter?: {
    blockId: string | string[];
    direction?: "down" | "up" | "right" | "left";
    gap?: number;
  };
  padding?: number;
};

type NormalizedAppendBlockInput = {
  workspaceId?: string;
  docId: string;
  type: AppendBlockCanonicalType;
  strict: boolean;
  placement?: AppendPlacement;
  text: string;
  url: string;
  pageId: string;
  iframeUrl: string;
  html: string;
  design: string;
  reference: string;
  refFlavour: string;
  x: number;
  y: number;
  width: number;
  height: number;
  // string = palette token or raw CSS color; { light, dark } = theme-adaptive hex pair.
  background: string | { light?: string; dark?: string };
  sourceId: string;
  name: string;
  mimeType: string;
  size: number;
  embed: boolean;
  rows: number;
  columns: number;
  latex: string;
  headingLevel: 1 | 2 | 3 | 4 | 5 | 6;
  listStyle: AppendBlockListStyle;
  bookmarkStyle: AppendBlockBookmarkStyle;
  dataViewMode: AppendBlockDataViewMode;
  checked: boolean;
  language: string;
  caption?: string;
  legacyType?: AppendBlockLegacyType;
  tableData?: string[][];
  deltas?: TextDelta[];
  tableCellDeltas?: TextDelta[][][];
  childElementIds?: string[];
  stackAfter?: {
    blockId: string | string[];
    direction?: "down" | "up" | "right" | "left";
    gap?: number;
  };
  padding?: number;
  xProvided?: boolean;
  yProvided?: boolean;
  heightProvided?: boolean;
  widthProvided?: boolean;
  markdown?: string;
  // Resolved by resolveEdgelessLayoutHints from `childElementIds`; carries
  // both the ids to write and the ones that didn't resolve for the receipt.
  _frameOwnedIds?: string[];
  _frameMissing?: string[];
};

type CreateDocInput = {
  workspaceId?: string;
  title?: string;
  content?: string;
};

type SemanticPageType = "meeting_notes" | "project_hub" | "spec_page" | "wiki_page";

type SemanticSectionInput = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  callouts?: string[];
};

type SemanticPageInput = {
  workspaceId?: string;
  title?: string;
  pageType?: SemanticPageType;
  parentDocId?: string;
  sections?: SemanticSectionInput[];
};

type AppendSemanticSectionInput = {
  workspaceId?: string;
  docId: string;
  sectionTitle: string;
  afterSectionTitle?: string;
  paragraphs?: string[];
  bullets?: string[];
  callouts?: string[];
};

type SemanticBlockDraft = Omit<AppendBlockInput, "workspaceId" | "docId">;

type CreateDocResult = {
  workspaceId: string;
  docId: string;
  title: string;
  parentDocId: string | null;
  linkedToParent: boolean;
  warnings: string[];
};

function blockVersion(flavour: string): number {
  switch (flavour) {
    case "affine:page":
      return 2;
    case "affine:surface":
      return 5;
    default:
      return 1;
  }
}

export function registerDocTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  // helpers
  function generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let id = '';
    for (let i = 0; i < 10; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
  }

  async function getCookieAndEndpoint() {
    const endpoint = gql.endpoint;
    const cookie = gql.cookie;
    const bearer = gql.bearer;
    return { endpoint, cookie, bearer };
  }

  const SELECT_COLORS = [
    "var(--affine-tag-blue)", "var(--affine-tag-green)", "var(--affine-tag-red)",
    "var(--affine-tag-orange)", "var(--affine-tag-purple)", "var(--affine-tag-yellow)",
    "var(--affine-tag-teal)", "var(--affine-tag-pink)", "var(--affine-tag-gray)",
  ];

  function makeText(content: string | TextDelta[]): Y.Text {
    const yText = new Y.Text();
    if (typeof content === "string") {
      if (content.length > 0) {
        yText.insert(0, content);
      }
      return yText;
    }
    let offset = 0;
    for (const delta of content) {
      if (!delta.insert) {
        continue;
      }
      yText.insert(offset, delta.insert, delta.attributes ? { ...delta.attributes } : {});
      offset += delta.insert.length;
    }
    return yText;
  }

  /**
   * Build a Y.Text containing a LinkedPage reference delta.
   * This is the mechanism AFFiNE uses to associate a database row with a
   * linked doc that opens in "center peek" when the row title is clicked.
   */
  function makeLinkedDocText(docId: string): Y.Text {
    const delta = [{ insert: "\u200B", attributes: { reference: { type: "LinkedPage", pageId: docId } } }];
    // Cast needed: TextDelta.attributes doesn't declare `reference`, but
    // makeText spreads all attributes at runtime via `{ ...delta.attributes }`.
    return makeText(delta as TextDelta[]);
  }

  /**
   * Extract a linked-doc page ID from a database row block's prop:text,
   * if it contains a LinkedPage reference delta.  Returns null otherwise.
   */
  function readLinkedDocId(rowBlock: Y.Map<any>): string | null {
    const propText = rowBlock.get("prop:text");
    if (!(propText instanceof Y.Text)) return null;
    const delta = propText.toDelta();
    if (!Array.isArray(delta)) return null;
    for (const d of delta) {
      if (d.attributes?.reference?.type === "LinkedPage" && d.attributes.reference.pageId) {
        return d.attributes.reference.pageId;
      }
    }
    return null;
  }

  function asText(value: unknown): string {
    if (value instanceof Y.Text) return value.toString();
    if (typeof value === "string") return value;
    return "";
  }

  function childIdsFrom(value: unknown): string[] {
    if (!(value instanceof Y.Array)) return [];
    const childIds: string[] = [];
    value.forEach((entry: unknown) => {
      if (typeof entry === "string") {
        childIds.push(entry);
        return;
      }
      if (Array.isArray(entry)) {
        for (const child of entry) {
          if (typeof child === "string") {
            childIds.push(child);
          }
        }
      }
    });
    return childIds;
  }

  function normalizeTag(rawTag: string): string {
    const normalized = rawTag.trim();
    if (!normalized) {
      throw new Error("tag is required");
    }
    return normalized;
  }

  type WorkspaceTagOption = {
    id: string;
    value: string;
    color: string;
    createDate: number | null;
    updateDate: number | null;
  };

  const TAG_OPTION_COLORS = [
    "var(--affine-tag-blue)", "var(--affine-tag-green)", "var(--affine-tag-red)",
    "var(--affine-tag-orange)", "var(--affine-tag-purple)", "var(--affine-tag-yellow)",
    "var(--affine-tag-teal)", "var(--affine-tag-pink)", "var(--affine-tag-gray)",
  ];

  function getStringArray(value: unknown): string[] {
    if (!(value instanceof Y.Array)) {
      return [];
    }
    const values: string[] = [];
    value.forEach((entry: unknown) => {
      if (typeof entry === "string") {
        values.push(entry);
      }
    });
    return values;
  }

  function getTagArray(target: Y.Map<any>, key: string = "tags"): Y.Array<string> | null {
    const value = target.get(key);
    if (!(value instanceof Y.Array)) {
      return null;
    }
    return value as Y.Array<string>;
  }

  function ensureTagArray(target: Y.Map<any>, key: string = "tags"): Y.Array<string> {
    const existing = getTagArray(target, key);
    if (existing) {
      return existing;
    }
    const next = new Y.Array<string>();
    target.set(key, next);
    return next;
  }

  function getYMap(target: Y.Map<any>, key: string): Y.Map<any> | null {
    const value = target.get(key);
    if (!(value instanceof Y.Map)) {
      return null;
    }
    return value;
  }

  function ensureYMap(target: Y.Map<any>, key: string): Y.Map<any> {
    const current = getYMap(target, key);
    if (current) {
      return current;
    }
    const next = new Y.Map<any>();
    target.set(key, next);
    return next;
  }

  function getWorkspaceTagOptionsArray(meta: Y.Map<any>): Y.Array<any> | null {
    const properties = getYMap(meta, "properties");
    if (!properties) {
      return null;
    }
    const tags = getYMap(properties, "tags");
    if (!tags) {
      return null;
    }
    const options = tags.get("options");
    if (!(options instanceof Y.Array)) {
      return null;
    }
    return options;
  }

  function ensureWorkspaceTagOptionsArray(meta: Y.Map<any>): Y.Array<any> {
    const properties = ensureYMap(meta, "properties");
    const tags = ensureYMap(properties, "tags");
    const existing = tags.get("options");
    if (existing instanceof Y.Array) {
      return existing;
    }
    const next = new Y.Array<any>();
    tags.set("options", next);
    return next;
  }

  function asNumberOrNull(value: unknown): number | null {
    return typeof value === "number" ? value : null;
  }

  function parseWorkspaceTagOption(raw: unknown): WorkspaceTagOption | null {
    let id: unknown;
    let value: unknown;
    let color: unknown;
    let createDate: unknown;
    let updateDate: unknown;

    if (raw instanceof Y.Map) {
      id = raw.get("id");
      value = raw.get("value");
      color = raw.get("color");
      createDate = raw.get("createDate");
      updateDate = raw.get("updateDate");
    } else if (raw && typeof raw === "object") {
      id = (raw as any).id;
      value = (raw as any).value;
      color = (raw as any).color;
      createDate = (raw as any).createDate;
      updateDate = (raw as any).updateDate;
    } else {
      return null;
    }

    if (typeof id !== "string" || id.trim().length === 0) {
      return null;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }

    return {
      id,
      value,
      color: typeof color === "string" && color.trim().length > 0 ? color : TAG_OPTION_COLORS[0],
      createDate: asNumberOrNull(createDate),
      updateDate: asNumberOrNull(updateDate),
    };
  }

  function getWorkspaceTagOptions(meta: Y.Map<any>): WorkspaceTagOption[] {
    const options = getWorkspaceTagOptionsArray(meta);
    if (!options) {
      return [];
    }
    const parsed: WorkspaceTagOption[] = [];
    options.forEach((raw: unknown) => {
      const option = parseWorkspaceTagOption(raw);
      if (option) {
        parsed.push(option);
      }
    });
    return parsed;
  }

  function getWorkspaceTagOptionMaps(meta: Y.Map<any>): {
    options: WorkspaceTagOption[];
    byId: Map<string, WorkspaceTagOption>;
    byValueLower: Map<string, WorkspaceTagOption>;
  } {
    const options = getWorkspaceTagOptions(meta);
    const byId = new Map<string, WorkspaceTagOption>();
    const byValueLower = new Map<string, WorkspaceTagOption>();
    for (const option of options) {
      if (!byId.has(option.id)) {
        byId.set(option.id, option);
      }
      const key = option.value.toLocaleLowerCase();
      if (!byValueLower.has(key)) {
        byValueLower.set(key, option);
      }
    }
    return { options, byId, byValueLower };
  }

  function resolveTagLabels(tagEntries: string[], byId: Map<string, WorkspaceTagOption>): string[] {
    const deduped = new Set<string>();
    const resolved: string[] = [];
    for (const entry of tagEntries) {
      const raw = entry.trim();
      if (!raw) {
        continue;
      }
      const option = byId.get(raw);
      const label = (option ? option.value : raw).trim();
      if (!label) {
        continue;
      }
      const dedupeKey = label.toLocaleLowerCase();
      if (deduped.has(dedupeKey)) {
        continue;
      }
      deduped.add(dedupeKey);
      resolved.push(label);
    }
    return resolved;
  }

  function ensureWorkspaceTagOption(meta: Y.Map<any>, tag: string): {
    option: WorkspaceTagOption;
    created: boolean;
  } {
    const normalizedTag = normalizeTag(tag);
    const maps = getWorkspaceTagOptionMaps(meta);
    const existing = maps.byValueLower.get(normalizedTag.toLocaleLowerCase());
    if (existing) {
      return { option: existing, created: false };
    }

    const optionsArray = ensureWorkspaceTagOptionsArray(meta);
    const color = TAG_OPTION_COLORS[maps.options.length % TAG_OPTION_COLORS.length];
    const now = Date.now();
    const option: WorkspaceTagOption = {
      id: generateId(),
      value: normalizedTag,
      color,
      createDate: now,
      updateDate: now,
    };

    const optionMap = new Y.Map<any>();
    optionMap.set("id", option.id);
    optionMap.set("value", option.value);
    optionMap.set("color", option.color);
    optionMap.set("createDate", now);
    optionMap.set("updateDate", now);
    optionsArray.push([optionMap]);

    return { option, created: true };
  }

  function collectMatchingTagIndexes(
    tags: Y.Array<string>,
    requestedTag: string,
    option: WorkspaceTagOption | null,
    ignoreCase: boolean
  ): number[] {
    const normalizedRequested = ignoreCase ? requestedTag.toLocaleLowerCase() : requestedTag;
    const normalizedOptionId = option
      ? (ignoreCase ? option.id.toLocaleLowerCase() : option.id)
      : null;
    const normalizedOptionValue = option
      ? (ignoreCase ? option.value.toLocaleLowerCase() : option.value)
      : null;

    const indexes: number[] = [];
    tags.forEach((entry: unknown, index: number) => {
      if (typeof entry !== "string") {
        return;
      }
      const current = ignoreCase ? entry.toLocaleLowerCase() : entry;
      if (
        current === normalizedRequested ||
        (normalizedOptionId && current === normalizedOptionId) ||
        (normalizedOptionValue && current === normalizedOptionValue)
      ) {
        indexes.push(index);
      }
    });
    return indexes;
  }

  function deleteArrayIndexes(arr: Y.Array<any>, indexes: number[]): boolean {
    if (indexes.length === 0) {
      return false;
    }
    const sorted = [...indexes].sort((a, b) => b - a);
    for (const index of sorted) {
      arr.delete(index, 1);
    }
    return true;
  }

  function syncTagArrayToOption(
    tags: Y.Array<string>,
    requestedTag: string,
    option: WorkspaceTagOption
  ): {
    existed: boolean;
    changed: boolean;
  } {
    const optionId = option.id.toLocaleLowerCase();
    const optionValue = option.value.toLocaleLowerCase();
    const requested = requestedTag.toLocaleLowerCase();

    let existed = false;
    let hasCanonicalId = false;
    const removeIndexes: number[] = [];

    tags.forEach((entry: unknown, index: number) => {
      if (typeof entry !== "string") {
        return;
      }
      const current = entry.toLocaleLowerCase();
      const matched = current === optionId || current === optionValue || current === requested;
      if (!matched) {
        return;
      }
      existed = true;
      if (current === optionId) {
        if (hasCanonicalId) {
          removeIndexes.push(index);
        } else {
          hasCanonicalId = true;
        }
        return;
      }
      removeIndexes.push(index);
    });

    let changed = deleteArrayIndexes(tags, removeIndexes);
    if (!hasCanonicalId) {
      tags.push([option.id]);
      changed = true;
    }
    return { existed, changed };
  }

  function hasTag(tagValues: string[], tag: string, ignoreCase: boolean): boolean {
    const normalizedTag = ignoreCase ? tag.toLocaleLowerCase() : tag;
    return tagValues.some((entry) => (ignoreCase ? entry.toLocaleLowerCase() : entry) === normalizedTag);
  }

  type WorkspacePageEntry = {
    index: number;
    id: string;
    title: string | null;
    createDate: number | null;
    updatedDate: number | null;
    entry: Y.Map<any>;
    tagsArray: Y.Array<string> | null;
  };

  function getWorkspacePageEntries(meta: Y.Map<any>): WorkspacePageEntry[] {
    const pages = meta.get("pages");
    if (!(pages instanceof Y.Array)) {
      return [];
    }

    const entries: WorkspacePageEntry[] = [];
    pages.forEach((value: unknown, index: number) => {
      if (!(value instanceof Y.Map)) {
        return;
      }
      const id = value.get("id");
      if (typeof id !== "string" || id.length === 0) {
        return;
      }
      const title = value.get("title");
      const createDate = value.get("createDate");
      const updatedDate = value.get("updatedDate");
      entries.push({
        index,
        id,
        title: typeof title === "string" ? title : null,
        createDate: typeof createDate === "number" ? createDate : null,
        updatedDate: typeof updatedDate === "number" ? updatedDate : null,
        entry: value,
        tagsArray: getTagArray(value),
      });
    });
    return entries;
  }

  function setSysFields(block: Y.Map<any>, blockId: string, flavour: string): void {
    block.set("sys:id", blockId);
    block.set("sys:flavour", flavour);
    block.set("sys:version", blockVersion(flavour));
  }

  function findBlockIdByFlavour(blocks: Y.Map<any>, flavour: string): string | null {
    for (const [, value] of blocks) {
      const block = value as Y.Map<any>;
      if (block?.get && block.get("sys:flavour") === flavour) {
        return String(block.get("sys:id"));
      }
    }
    return null;
  }

  function ensureNoteBlock(blocks: Y.Map<any>): string {
    const existingNoteId = findBlockIdByFlavour(blocks, "affine:note");
    if (existingNoteId) {
      return existingNoteId;
    }

    const pageId = findBlockIdByFlavour(blocks, "affine:page");
    if (!pageId) {
      throw new Error("Document has no page block; unable to insert content.");
    }

    // Mirror BlockSuite's createDefaultDoc shape so the editor doesn't re-seed
     // its own default note alongside ours.
    const noteId = generateId();
    const note = new Y.Map<any>();
    setSysFields(note, noteId, "affine:note");
    note.set("sys:parent", null);
    const noteChildren = new Y.Array<string>();
    note.set("sys:children", noteChildren);
    note.set("prop:xywh", DEFAULT_NOTE_XYWH);
    note.set("prop:index", "a0");
    note.set("prop:hidden", false);
    note.set("prop:displayMode", "both");
    note.set("prop:background", buildDefaultNoteBackground());
    blocks.set(noteId, note);

    const paragraphId = generateId();
    const paragraph = new Y.Map<any>();
    setSysFields(paragraph, paragraphId, "affine:paragraph");
    paragraph.set("sys:parent", null);
    paragraph.set("sys:children", new Y.Array<string>());
    paragraph.set("prop:type", "text");
    paragraph.set("prop:text", makeText(""));
    blocks.set(paragraphId, paragraph);
    noteChildren.push([paragraphId]);

    const page = blocks.get(pageId) as Y.Map<any>;
    let pageChildren = page.get("sys:children") as Y.Array<string> | undefined;
    if (!(pageChildren instanceof Y.Array)) {
      pageChildren = new Y.Array<string>();
      page.set("sys:children", pageChildren);
    }
    pageChildren.push([noteId]);
    return noteId;
  }

  function buildDefaultNoteBackground(): Y.Map<any> {
    const map = new Y.Map<any>();
    map.set("light", "#ffffff");
    map.set("dark", "#252525");
    return map;
  }

  function ensureSurfaceBlock(blocks: Y.Map<any>): string {
    const existingSurfaceId = findBlockIdByFlavour(blocks, "affine:surface");
    if (existingSurfaceId) {
      return existingSurfaceId;
    }

    const pageId = findBlockIdByFlavour(blocks, "affine:page");
    if (!pageId) {
      throw new Error("Document has no page block; unable to create/find surface.");
    }

    const surfaceId = generateId();
    const surface = new Y.Map<any>();
    setSysFields(surface, surfaceId, "affine:surface");
    surface.set("sys:parent", null);
    surface.set("sys:children", new Y.Array<string>());
    const elements = new Y.Map<any>();
    elements.set("type", "$blocksuite:internal:native$");
    elements.set("value", new Y.Map<any>());
    surface.set("prop:elements", elements);
    blocks.set(surfaceId, surface);

    const page = blocks.get(pageId) as Y.Map<any>;
    let pageChildren = page.get("sys:children") as Y.Array<string> | undefined;
    if (!(pageChildren instanceof Y.Array)) {
      pageChildren = new Y.Array<string>();
      page.set("sys:children", pageChildren);
    }
    pageChildren.push([surfaceId]);
    return surfaceId;
  }

  function normalizeBlockTypeInput(typeInput: string): {
    type: AppendBlockCanonicalType;
    legacyType?: AppendBlockLegacyType;
    headingLevelFromAlias?: 1 | 2 | 3;
    listStyleFromAlias?: AppendBlockListStyle;
  } {
    const key = typeInput.trim().toLowerCase();
    if ((APPEND_BLOCK_CANONICAL_TYPE_VALUES as readonly string[]).includes(key)) {
      return { type: key as AppendBlockCanonicalType };
    }

    if (Object.prototype.hasOwnProperty.call(APPEND_BLOCK_LEGACY_ALIAS_MAP, key)) {
      const legacyType = key as AppendBlockLegacyType;
      const type = APPEND_BLOCK_LEGACY_ALIAS_MAP[legacyType];
      const listStyleFromAlias =
        legacyType === "bulleted_list"
          ? "bulleted"
          : legacyType === "numbered_list"
            ? "numbered"
            : legacyType === "todo"
              ? "todo"
              : undefined;
      const headingLevelFromAlias =
        legacyType === "heading1"
          ? 1
          : legacyType === "heading2"
            ? 2
            : legacyType === "heading3"
              ? 3
              : undefined;
      return { type, legacyType, headingLevelFromAlias, listStyleFromAlias };
    }

    const supported = [
      ...APPEND_BLOCK_CANONICAL_TYPE_VALUES,
      ...Object.keys(APPEND_BLOCK_LEGACY_ALIAS_MAP),
    ].join(", ");
    throw new Error(`Unsupported append_block type '${typeInput}'. Supported types: ${supported}`);
  }

  function normalizePlacement(placement: AppendPlacement | undefined): AppendPlacement | undefined {
    if (!placement) return undefined;

    const normalized: AppendPlacement = {};
    if (placement.parentId?.trim()) normalized.parentId = placement.parentId.trim();
    if (placement.afterBlockId?.trim()) normalized.afterBlockId = placement.afterBlockId.trim();
    if (placement.beforeBlockId?.trim()) normalized.beforeBlockId = placement.beforeBlockId.trim();
    if (placement.index !== undefined) normalized.index = placement.index;

    const hasAfter = Boolean(normalized.afterBlockId);
    const hasBefore = Boolean(normalized.beforeBlockId);
    if (hasAfter && hasBefore) {
      throw new Error("placement.afterBlockId and placement.beforeBlockId are mutually exclusive.");
    }
    if (normalized.index !== undefined) {
      if (!Number.isInteger(normalized.index) || normalized.index < 0) {
        throw new Error("placement.index must be an integer greater than or equal to 0.");
      }
      if (hasAfter || hasBefore) {
        throw new Error("placement.index cannot be used with placement.afterBlockId/beforeBlockId.");
      }
    }

    if (!normalized.parentId && !normalized.afterBlockId && !normalized.beforeBlockId && normalized.index === undefined) {
      return undefined;
    }
    return normalized;
  }

  function validateNormalizedAppendBlockInput(normalized: NormalizedAppendBlockInput, raw: AppendBlockInput): void {
    if (normalized.type === "heading") {
      if (!Number.isInteger(normalized.headingLevel) || normalized.headingLevel < 1 || normalized.headingLevel > 6) {
        throw new Error("Heading level must be an integer from 1 to 6.");
      }
    } else if (raw.level !== undefined && normalized.strict) {
      throw new Error("The 'level' field can only be used with type='heading'.");
    }

    if (normalized.type === "list") {
      if (!(APPEND_BLOCK_LIST_STYLE_VALUES as readonly string[]).includes(normalized.listStyle)) {
        throw new Error(`Invalid list style '${normalized.listStyle}'.`);
      }
      if (normalized.listStyle !== "todo" && raw.checked !== undefined && normalized.strict) {
        throw new Error("The 'checked' field can only be used when list style is 'todo'.");
      }
    } else {
      if (raw.style !== undefined && normalized.strict) {
        throw new Error("The 'style' field can only be used with type='list'.");
      }
      if (raw.checked !== undefined && normalized.strict) {
        throw new Error("The 'checked' field can only be used with type='list' (style='todo').");
      }
    }

    if (normalized.type !== "code") {
      if (raw.language !== undefined && normalized.strict) {
        throw new Error("The 'language' field can only be used with type='code'.");
      }
      const allowsCaption =
        normalized.type === "bookmark" ||
        normalized.type === "image" ||
        normalized.type === "attachment" ||
        normalized.type === "surface_ref" ||
        normalized.type.startsWith("embed_");
      if (raw.caption !== undefined && !allowsCaption && normalized.strict) {
        throw new Error("The 'caption' field is not valid for this block type.");
      }
    } else if (normalized.language.length > 64) {
      throw new Error("Code language is too long (max 64 chars).");
    }

    if (normalized.type === "divider" && raw.text && raw.text.length > 0 && normalized.strict) {
      throw new Error("Divider blocks do not accept text.");
    }

    const requiresUrl = [
      "bookmark",
      "embed_youtube",
      "embed_github",
      "embed_figma",
      "embed_loom",
      "embed_iframe",
    ] as const;
    const urlAllowedTypes = [...requiresUrl] as readonly string[];
    if (urlAllowedTypes.includes(normalized.type)) {
      if (!normalized.url) {
        throw new Error(`${normalized.type} blocks require a non-empty url.`);
      }
      try {
        new URL(normalized.url);
      } catch {
        throw new Error(`Invalid url for ${normalized.type} block: '${normalized.url}'.`);
      }
    }

    if (normalized.type === "bookmark") {
      if (!(APPEND_BLOCK_BOOKMARK_STYLE_VALUES as readonly string[]).includes(normalized.bookmarkStyle)) {
        throw new Error(`Invalid bookmark style '${normalized.bookmarkStyle}'.`);
      }
    } else {
      if (raw.bookmarkStyle !== undefined && normalized.strict) {
        throw new Error("The 'bookmarkStyle' field can only be used with type='bookmark'.");
      }
      if (raw.url !== undefined && !urlAllowedTypes.includes(normalized.type) && normalized.strict) {
        throw new Error("The 'url' field is not valid for this block type.");
      }
    }

    if (normalized.type === "image" || normalized.type === "attachment") {
      if (!normalized.sourceId) {
        throw new Error(`${normalized.type} blocks require sourceId (use upload_blob first).`);
      }
      if (normalized.type === "attachment" && (!normalized.name || !normalized.mimeType)) {
        throw new Error("attachment blocks require valid name and mimeType.");
      }
    } else if (raw.sourceId !== undefined && normalized.strict) {
      throw new Error("The 'sourceId' field can only be used with type='image' or type='attachment'.");
    } else if (
      (raw.name !== undefined || raw.mimeType !== undefined || raw.embed !== undefined || raw.size !== undefined) &&
      normalized.strict
    ) {
      throw new Error("The 'name'/'mimeType'/'embed'/'size' fields are only valid for image/attachment blocks.");
    }

    if (normalized.type === "latex") {
      if (!normalized.latex && normalized.strict) {
        throw new Error("latex blocks require a non-empty 'latex' value in strict mode.");
      }
    } else if (raw.latex !== undefined && normalized.strict) {
      throw new Error("The 'latex' field can only be used with type='latex'.");
    }

    if (normalized.type === "embed_linked_doc" || normalized.type === "embed_synced_doc") {
      if (!normalized.pageId) {
        throw new Error(`${normalized.type} blocks require pageId.`);
      }
    } else if (raw.pageId !== undefined && normalized.strict) {
      throw new Error("The 'pageId' field can only be used with linked/synced doc embed types.");
    }

    if (normalized.type === "embed_html") {
      if (!normalized.html && !normalized.design && normalized.strict) {
        throw new Error("embed_html blocks require html or design.");
      }
    } else if ((raw.html !== undefined || raw.design !== undefined) && normalized.strict) {
      throw new Error("The 'html'/'design' fields can only be used with type='embed_html'.");
    }

    if (normalized.type === "embed_iframe") {
      if (raw.iframeUrl !== undefined && !normalized.iframeUrl && normalized.strict) {
        throw new Error("embed_iframe iframeUrl cannot be empty when provided.");
      }
    } else if (raw.iframeUrl !== undefined && normalized.strict) {
      throw new Error("The 'iframeUrl' field can only be used with type='embed_iframe'.");
    }

    if (normalized.type === "surface_ref") {
      if (!normalized.reference) {
        throw new Error("surface_ref blocks require 'reference' (target element/block id).");
      }
      if (!normalized.refFlavour) {
        throw new Error("surface_ref blocks require 'refFlavour' (for example affine:frame).");
      }
    } else if ((raw.reference !== undefined || raw.refFlavour !== undefined) && normalized.strict) {
      throw new Error("The 'reference'/'refFlavour' fields can only be used with type='surface_ref'.");
    }

    if (normalized.type === "frame" || normalized.type === "edgeless_text" || normalized.type === "note") {
      if (!Number.isInteger(normalized.width) || normalized.width < 1 || normalized.width > 10000) {
        throw new Error(`${normalized.type} width must be an integer between 1 and 10000.`);
      }
      if (!Number.isInteger(normalized.height) || normalized.height < 1 || normalized.height > 10000) {
        throw new Error(`${normalized.type} height must be an integer between 1 and 10000.`);
      }
    } else if ((raw.width !== undefined || raw.height !== undefined) && normalized.strict) {
      throw new Error("The 'width'/'height' fields are only valid for frame/edgeless_text/note.");
    }

    if (normalized.type !== "frame" && normalized.type !== "note" && raw.background !== undefined && normalized.strict) {
      throw new Error("The 'background' field is only valid for frame/note.");
    }

    if (normalized.type === "table") {
      if (!Number.isInteger(normalized.rows) || normalized.rows < 1 || normalized.rows > 20) {
        throw new Error("table rows must be an integer between 1 and 20.");
      }
      if (!Number.isInteger(normalized.columns) || normalized.columns < 1 || normalized.columns > 20) {
        throw new Error("table columns must be an integer between 1 and 20.");
      }
      if (normalized.tableData) {
        if (!Array.isArray(normalized.tableData) || normalized.tableData.length !== normalized.rows) {
          throw new Error("tableData row count must match table rows.");
        }
        for (const row of normalized.tableData) {
          if (!Array.isArray(row) || row.length !== normalized.columns) {
            throw new Error("tableData column count must match table columns.");
          }
        }
      }
    } else if ((raw.rows !== undefined || raw.columns !== undefined) && normalized.strict) {
      throw new Error("The 'rows'/'columns' fields can only be used with type='table'.");
    } else if (raw.tableData !== undefined && normalized.strict) {
      throw new Error("The 'tableData' field can only be used with type='table'.");
    }

    if (normalized.type !== "database" && normalized.type !== "data_view" && raw.viewMode !== undefined && normalized.strict) {
      throw new Error("The 'viewMode' field can only be used with type='database' or type='data_view'.");
    }
  }

  function normalizeAppendBlockInput(parsed: AppendBlockInput): NormalizedAppendBlockInput {
    const strict = parsed.strict !== false;
    const typeInfo = normalizeBlockTypeInput(parsed.type);
    const headingLevelCandidate = parsed.level ?? typeInfo.headingLevelFromAlias ?? 1;
    const headingLevelNumber = Number(headingLevelCandidate);
    const headingLevel = Math.max(1, Math.min(6, headingLevelNumber)) as 1 | 2 | 3 | 4 | 5 | 6;
    const listStyle = typeInfo.listStyleFromAlias ?? parsed.style ?? "bulleted";
    const bookmarkStyle = parsed.bookmarkStyle ?? "horizontal";
    const dataViewMode = parsed.viewMode ?? (typeInfo.type === "data_view" ? "kanban" : "table");
    const language = (parsed.language ?? "txt").trim().toLowerCase() || "txt";
    const placement = normalizePlacement(parsed.placement);
    const url = (parsed.url ?? "").trim();
    const pageId = (parsed.pageId ?? "").trim();
    const iframeUrl = (parsed.iframeUrl ?? "").trim();
    const html = parsed.html ?? "";
    const design = parsed.design ?? "";
    const reference = (parsed.reference ?? "").trim();
    const refFlavour = (parsed.refFlavour ?? "").trim();
    const x = Number.isFinite(parsed.x) ? Math.floor(parsed.x as number) : 0;
    const y = Number.isFinite(parsed.y) ? Math.floor(parsed.y as number) : 0;
    const widthProvided = Number.isFinite(parsed.width);
    const heightProvided = Number.isFinite(parsed.height);
    const width = widthProvided ? Math.max(1, Math.floor(parsed.width as number)) : 100;
    let height = heightProvided ? Math.max(1, Math.floor(parsed.height as number)) : 100;
    // Pre-inflate the stored height so stackAfter'd siblings don't overlap the
    // note before the editor's ResizeObserver corrects it on first render.
    if (typeInfo.type === "note" && !heightProvided && typeof parsed.markdown === "string" && parsed.markdown.length > 0) {
      height = Math.max(height, estimateNoteHeightForMarkdown(parsed.markdown, widthProvided ? width : 400));
    }
    const background: string | { light?: string; dark?: string } =
      typeof parsed.background === "string"
        ? (parsed.background.trim() || "transparent")
        : (parsed.background && typeof parsed.background === "object" ? parsed.background : "transparent");
    const sourceId = (parsed.sourceId ?? "").trim();
    const name = (parsed.name ?? "attachment").trim() || "attachment";
    const mimeType = (parsed.mimeType ?? "application/octet-stream").trim() || "application/octet-stream";
    const size = Number.isFinite(parsed.size) ? Math.max(0, Math.floor(parsed.size as number)) : 0;
    const rows = Number.isInteger(parsed.rows) ? (parsed.rows as number) : 3;
    const columns = Number.isInteger(parsed.columns) ? (parsed.columns as number) : 3;
    const latex = (parsed.latex ?? "").trim();
    const tableData = Array.isArray(parsed.tableData) ? parsed.tableData : undefined;
    const tableCellDeltas = Array.isArray(parsed.tableCellDeltas) ? parsed.tableCellDeltas : undefined;

    const normalized: NormalizedAppendBlockInput = {
      workspaceId: parsed.workspaceId,
      docId: parsed.docId,
      type: typeInfo.type,
      strict,
      placement,
      text: parsed.text ?? "",
      url,
      pageId,
      iframeUrl,
      html,
      design,
      reference,
      refFlavour,
      x,
      y,
      width,
      height,
      background,
      sourceId,
      name,
      mimeType,
      size,
      embed: Boolean(parsed.embed),
      rows,
      columns,
      latex,
      headingLevel,
      listStyle,
      bookmarkStyle,
      dataViewMode,
      checked: Boolean(parsed.checked),
      language,
      caption: parsed.caption,
      legacyType: typeInfo.legacyType,
      tableData,
      deltas: parsed.deltas,
      tableCellDeltas,
      childElementIds: Array.isArray(parsed.childElementIds) ? parsed.childElementIds : undefined,
      stackAfter: parsed.stackAfter,
      padding: Number.isFinite(parsed.padding) ? Math.max(0, Math.floor(parsed.padding as number)) : undefined,
      xProvided: Number.isFinite(parsed.x),
      yProvided: Number.isFinite(parsed.y),
      widthProvided,
      heightProvided,
      markdown: typeof parsed.markdown === "string" ? parsed.markdown : undefined,
    };

    validateNormalizedAppendBlockInput(normalized, parsed);
    return normalized;
  }

  function findBlockById(blocks: Y.Map<any>, blockId: string): Y.Map<any> | null {
    const value = blocks.get(blockId);
    if (value instanceof Y.Map) return value;
    return null;
  }

  function ensureChildrenArray(block: Y.Map<any>): Y.Array<any> {
    const current = block.get("sys:children");
    if (current instanceof Y.Array) return current;
    const created = new Y.Array<any>();
    block.set("sys:children", created);
    return created;
  }

  function indexOfChild(children: Y.Array<any>, blockId: string): number {
    let index = -1;
    children.forEach((entry: unknown, i: number) => {
      if (index >= 0) return;
      if (typeof entry === "string") {
        if (entry === blockId) index = i;
        return;
      }
      if (Array.isArray(entry)) {
        for (const child of entry) {
          if (child === blockId) {
            index = i;
            return;
          }
        }
      }
    });
    return index;
  }

  function findParentIdByChild(blocks: Y.Map<any>, childId: string): string | null {
    for (const [id, value] of blocks) {
      if (!(value instanceof Y.Map)) {
        continue;
      }
      const childIds = childIdsFrom(value.get("sys:children"));
      if (childIds.includes(childId)) {
        return String(id);
      }
    }
    return null;
  }

  function resolveBlockParentId(blocks: Y.Map<any>, blockId: string): string | null {
    const block = findBlockById(blocks, blockId);
    if (!block) {
      return null;
    }
    const rawParentId = block.get("sys:parent");
    if (typeof rawParentId === "string" && rawParentId.trim().length > 0) {
      return rawParentId;
    }
    // AFFiNE UI commonly stores sys:parent as null and derives hierarchy from sys:children.
    return findParentIdByChild(blocks, blockId);
  }

  function resolveInsertContext(blocks: Y.Map<any>, normalized: NormalizedAppendBlockInput): {
    parentId: string;
    parentBlock: Y.Map<any>;
    children: Y.Array<any>;
    insertIndex: number;
  } {
    const placement = normalized.placement;
    let parentId: string | undefined;
    let referenceBlockId: string | undefined;
    let mode: "append" | "index" | "after" | "before" = "append";

    if (placement?.afterBlockId) {
      mode = "after";
      referenceBlockId = placement.afterBlockId;
      const referenceBlock = findBlockById(blocks, referenceBlockId);
      if (!referenceBlock) throw new Error(`placement.afterBlockId '${referenceBlockId}' was not found.`);
      const refParentId = resolveBlockParentId(blocks, referenceBlockId);
      if (!refParentId) {
        throw new Error(`Block '${referenceBlockId}' has no parent.`);
      }
      parentId = refParentId;
    } else if (placement?.beforeBlockId) {
      mode = "before";
      referenceBlockId = placement.beforeBlockId;
      const referenceBlock = findBlockById(blocks, referenceBlockId);
      if (!referenceBlock) throw new Error(`placement.beforeBlockId '${referenceBlockId}' was not found.`);
      const refParentId = resolveBlockParentId(blocks, referenceBlockId);
      if (!refParentId) {
        throw new Error(`Block '${referenceBlockId}' has no parent.`);
      }
      parentId = refParentId;
    } else if (placement?.parentId) {
      mode = placement.index !== undefined ? "index" : "append";
      parentId = placement.parentId;
    }

    if (!parentId) {
      if (normalized.type === "frame" || normalized.type === "edgeless_text") {
        parentId = ensureSurfaceBlock(blocks);
      } else if (normalized.type === "note") {
        parentId = findBlockIdByFlavour(blocks, "affine:page") || undefined;
        if (!parentId) {
          throw new Error("Document has no page block; unable to insert note.");
        }
      } else {
        parentId = ensureNoteBlock(blocks);
      }
    }
    const parentBlock = findBlockById(blocks, parentId);
    if (!parentBlock) {
      throw new Error(`Target parent block '${parentId}' was not found.`);
    }
    const parentFlavour = parentBlock.get("sys:flavour");
    if (normalized.strict) {
      if (parentFlavour === "affine:page" && normalized.type !== "note") {
        throw new Error(`Cannot append '${normalized.type}' directly under 'affine:page'.`);
      }
      if (
        parentFlavour === "affine:surface" &&
        normalized.type !== "frame" &&
        normalized.type !== "edgeless_text"
      ) {
        throw new Error(`Cannot append '${normalized.type}' directly under 'affine:surface'.`);
      }
      if (normalized.type === "note" && parentFlavour !== "affine:page") {
        throw new Error("note blocks must be appended under affine:page.");
      }
      if (
        (normalized.type === "frame" || normalized.type === "edgeless_text") &&
        parentFlavour !== "affine:surface"
      ) {
        throw new Error(`${normalized.type} blocks must be appended under affine:surface.`);
      }
    }

    const children = ensureChildrenArray(parentBlock);
    let insertIndex = children.length;
    if (mode === "after" || mode === "before") {
      const idx = indexOfChild(children, referenceBlockId as string);
      if (idx < 0) {
        throw new Error(`Reference block '${referenceBlockId}' is not a child of parent '${parentId}'.`);
      }
      insertIndex = mode === "after" ? idx + 1 : idx;
    } else if (mode === "index") {
      const requestedIndex = placement?.index ?? children.length;
      if (requestedIndex > children.length && normalized.strict) {
        throw new Error(`placement.index ${requestedIndex} is out of range (max ${children.length}).`);
      }
      insertIndex = Math.min(requestedIndex, children.length);
    }

    return { parentId, parentBlock, children, insertIndex };
  }

  function createDatabaseViewColumn(columnId: string, width: number = 200, hide: boolean = false): Y.Map<any> {
    const column = new Y.Map<any>();
    column.set("id", columnId);
    column.set("width", width);
    column.set("hide", hide);
    return column;
  }

  function replaceSelectColumnOptions(column: Y.Map<any>, options: string[]): void {
    let data = column.get("data");
    if (!(data instanceof Y.Map)) {
      data = new Y.Map<any>();
      column.set("data", data);
    }

    let rawOptions = data.get("options");
    if (!(rawOptions instanceof Y.Array)) {
      rawOptions = new Y.Array<any>();
      data.set("options", rawOptions);
    } else if (rawOptions.length > 0) {
      rawOptions.delete(0, rawOptions.length);
    }

    options.forEach((value, index) => {
      const option = new Y.Map<any>();
      option.set("id", generateId());
      option.set("value", value);
      option.set("color", SELECT_COLORS[index % SELECT_COLORS.length]);
      rawOptions.push([option]);
    });
  }

  function createDatabaseColumnDefinition(input: {
    id: string;
    name: string;
    type: string;
    width?: number;
    options?: string[];
  }): Y.Map<any> {
    const column = new Y.Map<any>();
    column.set("id", input.id);
    column.set("name", input.name);
    column.set("type", input.type);
    column.set("width", input.width ?? 200);

    if ((input.type === "select" || input.type === "multi-select") && input.options?.length) {
      const data = new Y.Map<any>();
      const options = new Y.Array<any>();
      input.options.forEach((value, index) => {
        const option = new Y.Map<any>();
        option.set("id", generateId());
        option.set("value", value);
        option.set("color", SELECT_COLORS[index % SELECT_COLORS.length]);
        options.push([option]);
      });
      data.set("options", options);
      column.set("data", data);
    }

    return column;
  }

  function addDatabaseColumnToBlock(dbBlock: Y.Map<any>, spec: DatabaseIntentColumnSpec): string {
    const columns = dbBlock.get("prop:columns");
    if (!(columns instanceof Y.Array)) {
      throw new Error("Database has no columns array");
    }

    const currentDefs = readColumnDefs(dbBlock);
    const existing = currentDefs.find(column => column.name === spec.name);
    if (existing) {
      if (existing.type !== spec.type) {
        throw new Error(`Column '${spec.name}' already exists with type '${existing.type}'`);
      }
      return existing.id;
    }

    const columnId = generateId();
    columns.push([createDatabaseColumnDefinition({
      id: columnId,
      name: spec.name,
      type: spec.type,
      width: spec.width,
      options: spec.options,
    })]);

    const views = dbBlock.get("prop:views");
    if (views instanceof Y.Array) {
      views.forEach((view: any) => {
        if (!(view instanceof Y.Map)) {
          return;
        }
        const viewColumns = view.get("columns");
        if (!(viewColumns instanceof Y.Array)) {
          return;
        }
        const viewColumn = new Y.Map<any>();
        viewColumn.set("id", columnId);
        viewColumn.set("hide", false);
        viewColumn.set("width", spec.width ?? 200);
        viewColumns.push([viewColumn]);
      });
    }

    return columnId;
  }

  function createPresetBackedDataViewBlock(
    blockId: string,
    titleText: string,
    viewMode: AppendBlockDataViewMode,
    blockType: string,
  ): { blockId: string; block: Y.Map<any>; flavour: string; blockType: string } {
    const block = new Y.Map<any>();
    setSysFields(block, blockId, "affine:database");
    block.set("sys:parent", null);
    block.set("sys:children", new Y.Array<string>());
    block.set("prop:title", makeText(titleText));
    block.set("prop:cells", new Y.Map<any>());
    block.set("prop:comments", undefined);

    const titleColumnId = generateId();
    const columns = new Y.Array<any>();
    columns.push([createDatabaseColumnDefinition({
      id: titleColumnId,
      name: "Title",
      type: "title",
      width: 320,
    })]);

    const viewColumns = new Y.Array<any>();
    viewColumns.push([createDatabaseViewColumn(titleColumnId, 320, false)]);
    const header = {
      titleColumn: titleColumnId,
      iconColumn: "type",
    };

    let groupBy: Record<string, string> | null = null;
    let groupProperties: unknown[] | null = null;

    if (viewMode === "kanban") {
      const statusColumnId = generateId();
      columns.push([createDatabaseColumnDefinition({
        id: statusColumnId,
        name: "Status",
        type: "select",
        options: ["Todo", "In Progress", "Done"],
      })]);
      viewColumns.push([createDatabaseViewColumn(statusColumnId, 200, false)]);
      groupBy = {
        columnId: statusColumnId,
        name: "select",
        type: "groupBy",
      };
      groupProperties = [];
    }

    const view = new Y.Map<any>();
    view.set("id", generateId());
    view.set("name", viewMode === "kanban" ? "Kanban View" : "Table View");
    view.set("mode", viewMode);
    view.set("columns", viewColumns);
    view.set("filter", { type: "group", op: "and", conditions: [] });
    if (groupBy) {
      view.set("groupBy", groupBy);
    } else {
      view.set("groupBy", null);
    }
    if (groupProperties) {
      view.set("groupProperties", groupProperties);
    }
    view.set("sort", null);
    view.set("header", header);

    const views = new Y.Array<any>();
    views.push([view]);

    block.set("prop:columns", columns);
    block.set("prop:views", views);

    return {
      blockId,
      block,
      flavour: "affine:database",
      blockType,
    };
  }

  function createBlock(normalized: NormalizedAppendBlockInput): {
    blockId: string;
    block: Y.Map<any>;
    flavour: string;
    blockType?: string;
    extraBlocks?: Array<{ blockId: string; block: Y.Map<any> }>;
  } {
    const blockId = generateId();
    const block = new Y.Map<any>();
    const content = normalized.text;
    // Keep parity with AFFiNE UI-created docs: sys:parent stays null and hierarchy is represented by sys:children.

    switch (normalized.type) {
      case "paragraph":
      case "heading":
      case "quote": {
        setSysFields(block, blockId, "affine:paragraph");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        const blockType =
          normalized.type === "heading"
            ? (`h${normalized.headingLevel}` as const)
            : normalized.type === "quote"
              ? "quote"
              : "text";
        block.set("prop:type", blockType);
        block.set("prop:text", makeText(normalized.deltas ?? content));
        return { blockId, block, flavour: "affine:paragraph", blockType };
      }
      case "list": {
        setSysFields(block, blockId, "affine:list");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:type", normalized.listStyle);
        block.set("prop:checked", normalized.listStyle === "todo" ? normalized.checked : false);
        block.set("prop:text", makeText(normalized.deltas ?? content));
        return { blockId, block, flavour: "affine:list", blockType: normalized.listStyle };
      }
      case "code": {
        setSysFields(block, blockId, "affine:code");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:language", normalized.language);
        if (normalized.caption) {
          block.set("prop:caption", normalized.caption);
        }
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:code" };
      }
      case "divider": {
        setSysFields(block, blockId, "affine:divider");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        return { blockId, block, flavour: "affine:divider" };
      }
      case "callout": {
        setSysFields(block, blockId, "affine:callout");
        block.set("sys:parent", null);
        const calloutChildren = new Y.Array<string>();
        const textBlockId = generateId();
        const textBlock = new Y.Map<any>();
        setSysFields(textBlock, textBlockId, "affine:paragraph");
        textBlock.set("sys:parent", null);
        textBlock.set("sys:children", new Y.Array<string>());
        textBlock.set("prop:type", "text");
        textBlock.set("prop:text", makeText(normalized.deltas ?? content));
        calloutChildren.push([textBlockId]);
        block.set("sys:children", calloutChildren);
        block.set("prop:icon", { type: "emoji", unicode: "💡" });
        block.set("prop:backgroundColorName", "grey");
        return {
          blockId,
          block,
          flavour: "affine:callout",
          extraBlocks: [{ blockId: textBlockId, block: textBlock }],
        };
      }
      case "latex": {
        setSysFields(block, blockId, "affine:latex");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:xywh", "[0,0,16,16]");
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:scale", 1);
        block.set("prop:rotate", 0);
        block.set("prop:latex", normalized.latex);
        return { blockId, block, flavour: "affine:latex" };
      }
      case "table": {
        setSysFields(block, blockId, "affine:table");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());

        // AFFiNE reads table props as flat dot-notation keys on the block Y.Map:
        //   prop:rows.{rowId}.rowId, prop:rows.{rowId}.order
        //   prop:columns.{colId}.columnId, prop:columns.{colId}.order
        //   prop:cells.{rowId}:{colId}.text  (Y.Text, NOT a nested Y.Map)
        // Using nested Y.Maps (the old approach) causes cells to be invisible in the UI.
        const rowIds: string[] = [];
        const columnIds: string[] = [];
        const tableData = normalized.tableData ?? [];

        for (let i = 0; i < normalized.rows; i++) {
          const rowId = generateId();
          block.set(`prop:rows.${rowId}.rowId`, rowId);
          block.set(`prop:rows.${rowId}.order`, `r${String(i).padStart(4, "0")}`);
          rowIds.push(rowId);
        }
        for (let i = 0; i < normalized.columns; i++) {
          const columnId = generateId();
          block.set(`prop:columns.${columnId}.columnId`, columnId);
          block.set(`prop:columns.${columnId}.order`, `c${String(i).padStart(4, "0")}`);
          columnIds.push(columnId);
        }
        for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex += 1) {
          const rowId = rowIds[rowIndex];
          const isHeader = rowIndex === 0;
          for (let columnIndex = 0; columnIndex < columnIds.length; columnIndex += 1) {
            const columnId = columnIds[columnIndex];
            const cellText = tableData[rowIndex]?.[columnIndex] ?? "";
            const cellDeltas = normalized.tableCellDeltas?.[rowIndex]?.[columnIndex] ?? [];
            const cellYText = new Y.Text();
            // First row is always rendered bold (header row convention)
            if (cellDeltas.length > 0) {
              let offset = 0;
              for (const delta of cellDeltas) {
                if (!delta.insert) {
                  continue;
                }
                const attrs = isHeader
                  ? { ...(delta.attributes ?? {}), bold: true }
                  : (delta.attributes ? { ...delta.attributes } : {});
                cellYText.insert(offset, delta.insert, attrs);
                offset += delta.insert.length;
              }
            } else if (isHeader && cellText) {
              cellYText.insert(0, cellText, { bold: true });
            } else {
              cellYText.insert(0, cellText);
            }
            block.set(`prop:cells.${rowId}:${columnId}.text`, cellYText);
          }
        }

        block.set("prop:comments", undefined);
        block.set("prop:textAlign", undefined);
        return { blockId, block, flavour: "affine:table" };
      }
      case "bookmark": {
        setSysFields(block, blockId, "affine:bookmark");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:style", normalized.bookmarkStyle);
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:description", null);
        block.set("prop:icon", null);
        block.set("prop:image", null);
        block.set("prop:title", null);
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:footnoteIdentifier", null);
        return { blockId, block, flavour: "affine:bookmark" };
      }
      case "image": {
        setSysFields(block, blockId, "affine:image");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:caption", normalized.caption ?? "");
        block.set("prop:sourceId", normalized.sourceId);
        block.set("prop:width", 0);
        block.set("prop:height", 0);
        block.set("prop:size", normalized.size || -1);
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        return { blockId, block, flavour: "affine:image" };
      }
      case "attachment": {
        setSysFields(block, blockId, "affine:attachment");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:name", normalized.name);
        block.set("prop:size", normalized.size);
        block.set("prop:type", normalized.mimeType);
        block.set("prop:sourceId", normalized.sourceId);
        block.set("prop:caption", normalized.caption ?? undefined);
        block.set("prop:embed", normalized.embed);
        block.set("prop:style", "horizontalThin");
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:footnoteIdentifier", null);
        return { blockId, block, flavour: "affine:attachment" };
      }
      case "embed_youtube": {
        setSysFields(block, blockId, "affine:embed-youtube");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "video");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:image", null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        block.set("prop:creator", null);
        block.set("prop:creatorUrl", null);
        block.set("prop:creatorImage", null);
        block.set("prop:videoId", null);
        return { blockId, block, flavour: "affine:embed-youtube" };
      }
      case "embed_github": {
        setSysFields(block, blockId, "affine:embed-github");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "horizontal");
        block.set("prop:owner", "");
        block.set("prop:repo", "");
        block.set("prop:githubType", "issue");
        block.set("prop:githubId", "");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:image", null);
        block.set("prop:status", null);
        block.set("prop:statusReason", null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        block.set("prop:createdAt", null);
        block.set("prop:assignees", null);
        return { blockId, block, flavour: "affine:embed-github" };
      }
      case "embed_figma": {
        setSysFields(block, blockId, "affine:embed-figma");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "figma");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        return { blockId, block, flavour: "affine:embed-figma" };
      }
      case "embed_loom": {
        setSysFields(block, blockId, "affine:embed-loom");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "video");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:image", null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        block.set("prop:videoId", null);
        return { blockId, block, flavour: "affine:embed-loom" };
      }
      case "embed_html": {
        setSysFields(block, blockId, "affine:embed-html");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "html");
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:html", normalized.html || undefined);
        block.set("prop:design", normalized.design || undefined);
        return { blockId, block, flavour: "affine:embed-html" };
      }
      case "embed_linked_doc": {
        setSysFields(block, blockId, "affine:embed-linked-doc");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "horizontal");
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:pageId", normalized.pageId);
        block.set("prop:title", undefined);
        block.set("prop:description", undefined);
        block.set("prop:footnoteIdentifier", null);
        return { blockId, block, flavour: "affine:embed-linked-doc" };
      }
      case "embed_synced_doc": {
        setSysFields(block, blockId, "affine:embed-synced-doc");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,800,100]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "syncedDoc");
        block.set("prop:caption", normalized.caption ?? undefined);
        block.set("prop:pageId", normalized.pageId);
        block.set("prop:scale", undefined);
        block.set("prop:preFoldHeight", undefined);
        block.set("prop:title", undefined);
        block.set("prop:description", undefined);
        return { blockId, block, flavour: "affine:embed-synced-doc" };
      }
      case "embed_iframe": {
        setSysFields(block, blockId, "affine:embed-iframe");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:scale", 1);
        block.set("prop:url", normalized.url);
        block.set("prop:iframeUrl", normalized.iframeUrl || normalized.url);
        block.set("prop:width", undefined);
        block.set("prop:height", undefined);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        return { blockId, block, flavour: "affine:embed-iframe" };
      }
      case "database": {
        if (normalized.dataViewMode === "kanban") {
          return createPresetBackedDataViewBlock(blockId, normalized.text, "kanban", "database_kanban");
        }
        setSysFields(block, blockId, "affine:database");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        // Create a default table view so AFFiNE UI renders the database
        const defaultView = new Y.Map<any>();
        defaultView.set("id", generateId());
        defaultView.set("name", "Table View");
        defaultView.set("mode", "table");
        defaultView.set("columns", new Y.Array<any>());
        defaultView.set("filter", { type: "group", op: "and", conditions: [] });
        defaultView.set("groupBy", null);
        defaultView.set("sort", null);
        defaultView.set("header", { titleColumn: null, iconColumn: null });
        const views = new Y.Array<any>();
        views.push([defaultView]);
        block.set("prop:views", views);
        block.set("prop:title", makeText(content));
        block.set("prop:cells", new Y.Map<any>());
        block.set("prop:columns", new Y.Array<any>());
        block.set("prop:comments", undefined);
        return { blockId, block, flavour: "affine:database" };
      }
      case "data_view": {
        return createPresetBackedDataViewBlock(blockId, normalized.text, normalized.dataViewMode, `data_view_${normalized.dataViewMode}`);
      }
      case "surface_ref": {
        setSysFields(block, blockId, "affine:surface-ref");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:reference", normalized.reference);
        block.set("prop:caption", normalized.caption ?? "");
        block.set("prop:refFlavour", normalized.refFlavour);
        block.set("prop:comments", undefined);
        return { blockId, block, flavour: "affine:surface-ref" };
      }
      case "frame": {
        setSysFields(block, blockId, "affine:frame");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:title", makeText(content || "Frame"));
        // 'transparent' matches FrameBlockSchema; any other value renders as a
        // solid fill (the border is separate).
        block.set("prop:background", normalized.background ?? "transparent");
        block.set("prop:xywh", `[${normalized.x},${normalized.y},${normalized.width},${normalized.height}]`);
        block.set("prop:index", "a0");
        const childIds = new Y.Map<boolean>();
        for (const id of normalized._frameOwnedIds ?? []) childIds.set(id, true);
        block.set("prop:childElementIds", childIds);
        block.set("prop:presentationIndex", "a0");
        block.set("prop:lockedBySelf", false);
        return { blockId, block, flavour: "affine:frame" };
      }
      case "edgeless_text": {
        setSysFields(block, blockId, "affine:edgeless-text");
        block.set("sys:parent", null);
        const edgelessTextChildren = new Y.Array<string>();
        block.set("prop:xywh", `[${normalized.x},${normalized.y},${normalized.width},${normalized.height}]`);
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:scale", 1);
        block.set("prop:rotate", 0);
        block.set("prop:hasMaxWidth", false);
        block.set("prop:comments", undefined);
        // Theme-adaptive token so canvas text stays legible in dark mode.
        block.set("prop:color", "--affine-text-primary-color");
        block.set("prop:fontFamily", "Inter");
        block.set("prop:fontStyle", "normal");
        block.set("prop:fontWeight", "regular");
        block.set("prop:textAlign", "left");
        const edgelessTextExtraBlocks: Array<{ blockId: string; block: Y.Map<any> }> = [];
        if (content) {
          const paraId = generateId();
          const para = new Y.Map<any>();
          setSysFields(para, paraId, "affine:paragraph");
          para.set("sys:parent", null);
          para.set("sys:children", new Y.Array<string>());
          para.set("prop:type", "text");
          para.set("prop:text", makeText(normalized.deltas ?? content));
          edgelessTextChildren.push([paraId]);
          edgelessTextExtraBlocks.push({ blockId: paraId, block: para });
        }
        block.set("sys:children", edgelessTextChildren);
        return { blockId, block, flavour: "affine:edgeless-text", extraBlocks: edgelessTextExtraBlocks };
      }
      case "note": {
        setSysFields(block, blockId, "affine:note");
        block.set("sys:parent", null);
        const noteChildren = new Y.Array<string>();
        block.set("prop:xywh", `[${normalized.x},${normalized.y},${normalized.width},${normalized.height}]`);
        // BlockSuite reads the adaptive-bg case as a Y.Map; a plain JS object
        // would serialize to a JSON string and break theme switching.
        const bg = normalized.background;
        if (bg && typeof bg === "object" && !Array.isArray(bg) && ("light" in bg || "dark" in bg)) {
          const bgMap = new Y.Map<any>();
          if (typeof (bg as any).light === "string") bgMap.set("light", (bg as any).light);
          if (typeof (bg as any).dark === "string") bgMap.set("dark", (bg as any).dark);
          block.set("prop:background", bgMap);
        } else {
          block.set("prop:background", bg);
        }
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:hidden", false);
        block.set("prop:displayMode", "both");
        const edgeless = new Y.Map<any>();
        const style = new Y.Map<any>();
        style.set("borderRadius", 8);
        style.set("borderSize", 1);
        style.set("borderStyle", "solid");
        style.set("shadowType", "none");
        edgeless.set("style", style);
        block.set("prop:edgeless", edgeless);
        block.set("prop:comments", undefined);
        const noteExtraBlocks: Array<{ blockId: string; block: Y.Map<any> }> = [];
        if (content) {
          const paraId = generateId();
          const para = new Y.Map<any>();
          setSysFields(para, paraId, "affine:paragraph");
          para.set("sys:parent", null);
          para.set("sys:children", new Y.Array<string>());
          para.set("prop:type", "text");
          para.set("prop:text", makeText(normalized.deltas ?? content));
          noteChildren.push([paraId]);
          noteExtraBlocks.push({ blockId: paraId, block: para });
        }
        block.set("sys:children", noteChildren);
        return { blockId, block, flavour: "affine:note", extraBlocks: noteExtraBlocks };
      }
    }
  }

  function resolveBlockBoundAsBound(blocks: Y.Map<any>, blockId: string): Bound | null {
    const b = blocks.get(blockId);
    if (b instanceof Y.Map) {
      const xywh = parseXywhString(b.get("prop:xywh"));
      if (xywh) return { x: xywh.x, y: xywh.y, w: xywh.width, h: xywh.height };
    }
    return null;
  }

  function resolveEdgelessLayoutHints(
    blocks: Y.Map<any>,
    normalized: NormalizedAppendBlockInput
  ): void {
    const defaultPadding = normalized.padding ?? 40;
    let placed = false;

    if (normalized.stackAfter) {
      const idList = Array.isArray(normalized.stackAfter.blockId)
        ? normalized.stackAfter.blockId
        : [normalized.stackAfter.blockId];
      const direction = normalized.stackAfter.direction ?? "down";
      const missing: string[] = [];
      const bounds: Bound[] = [];
      for (const id of idList) {
        const b = resolveBlockBoundAsBound(blocks, id);
        if (!b) missing.push(id);
        else bounds.push(b);
      }
      const ref = pickFurthestInDirection(bounds, direction);
      if (!ref) {
        throw new Error(
          `stackAfter: no blockIds resolved to xywh. Missing: ${JSON.stringify(missing)}`
        );
      }
      // Gap precedence: explicit `gap` > explicit `padding` > direction default
      // (horizontal larger because notes are wide-short and tight sideways).
      const isHorizontal = direction === "left" || direction === "right";
      const directionDefaultGap = isHorizontal ? DEFAULT_STACK_GAP_HORIZONTAL : DEFAULT_STACK_GAP_VERTICAL;
      const gap = normalized.stackAfter.gap
        ?? (normalized.padding !== undefined ? normalized.padding : directionDefaultGap);
      // Center on the anchor group's orthogonal-axis union; caller x/y wins.
      const isVertical = direction === "down" || direction === "up";
      let preserveX: number | undefined;
      let preserveY: number | undefined;
      if (normalized.xProvided === true) {
        preserveX = normalized.x;
      } else if (isVertical) {
        const minX = bounds.reduce((m, b) => Math.min(m, b.x), Infinity);
        const maxX = bounds.reduce((m, b) => Math.max(m, b.x + b.w), -Infinity);
        preserveX = Math.round((minX + maxX) / 2 - normalized.width / 2);
      }
      if (normalized.yProvided === true) {
        preserveY = normalized.y;
      } else if (!isVertical) {
        const minY = bounds.reduce((m, b) => Math.min(m, b.y), Infinity);
        const maxY = bounds.reduce((m, b) => Math.max(m, b.y + b.h), -Infinity);
        preserveY = Math.round((minY + maxY) / 2 - normalized.height / 2);
      }
      const { x, y } = stackRelativeTo(
        ref,
        { w: normalized.width, h: normalized.height },
        { direction, gap, preserveX, preserveY }
      );
      normalized.x = x;
      normalized.y = y;
      placed = true;
    }

    // prop:childElementIds accepts both surface-element ids and block ids —
    // that's what the editor writes when you drag a note into a frame.
    if (normalized.type === "frame" && normalized.childElementIds && normalized.childElementIds.length > 0) {
      const surfaceCtx = getSurfaceElementsValueMap(blocks, { create: false });
      const surfaceValueMap = surfaceCtx?.value ?? new Y.Map<any>();
      const ownedIds: string[] = [];
      const missing: string[] = [];
      const kids: Bound[] = [];
      for (const id of normalized.childElementIds) {
        const resolved = resolveChildBound(surfaceValueMap, blocks, id);
        if (resolved.kind === "missing") {
          missing.push(id);
        } else {
          ownedIds.push(id);
          if (resolved.bound) kids.push(resolved.bound);
        }
      }
      if (ownedIds.length === 0) {
        throw new Error(
          `None of the ids in childElementIds were found: ${JSON.stringify(missing)}.`
        );
      }
      normalized._frameOwnedIds = ownedIds;
      normalized._frameMissing = missing;

      if (!normalized.widthProvided || !normalized.heightProvided || !normalized.xProvided || !normalized.yProvided) {
        const wrapped = encloseBounds(kids, { padding: defaultPadding, titleBand: 60 });
        if (wrapped) {
          if (!normalized.xProvided) normalized.x = wrapped.x;
          if (!normalized.yProvided) normalized.y = wrapped.y;
          if (!normalized.widthProvided) normalized.width = wrapped.w;
          if (!normalized.heightProvided) normalized.height = wrapped.h;
          placed = true;
        }
      }
    }

    // Auto-stack-below fallback: avoids dropping new edgeless blocks on top of
    // the seeded default note at [0,0,…] when the caller gave no placement.
    const isEdgelessBlock =
      normalized.type === "frame" ||
      normalized.type === "note" ||
      normalized.type === "edgeless_text";
    if (!placed && isEdgelessBlock && !normalized.yProvided) {
      const existing: Bound[] = [];
      for (const [, b] of blocks.entries()) {
        if (!(b instanceof Y.Map)) continue;
        const flavour = b.get("sys:flavour");
        if (
          flavour !== "affine:note" &&
          flavour !== "affine:frame" &&
          flavour !== "affine:edgeless-text"
        ) continue;
        const xywh = parseXywhString(b.get("prop:xywh"));
        if (!xywh) continue;
        existing.push({ x: xywh.x, y: xywh.y, w: xywh.width, h: xywh.height });
      }
      const ref = pickFurthestInDirection(existing, "down");
      if (ref) {
        const { x, y } = stackRelativeTo(
          ref,
          { w: normalized.width, h: normalized.height },
          {
            direction: "down",
            gap: defaultPadding,
            preserveX: normalized.xProvided === true ? normalized.x : undefined,
          }
        );
        normalized.x = x;
        normalized.y = y;
      }
    }
  }

  async function appendBlockInternal(parsed: AppendBlockInput) {
    const normalized = normalizeAppendBlockInput(parsed);
    const workspaceId = normalized.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, normalized.docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }

      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      resolveEdgelessLayoutHints(blocks, normalized);
      const context = resolveInsertContext(blocks, normalized);
      const { blockId, block, flavour, blockType, extraBlocks } = createBlock(normalized);

      blocks.set(blockId, block);
      if (Array.isArray(extraBlocks)) {
        for (const extra of extraBlocks) {
          blocks.set(extra.blockId, extra.block);
        }
      }
      if (context.insertIndex >= context.children.length) {
        context.children.push([blockId]);
      } else {
        context.children.insert(context.insertIndex, [blockId]);
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, normalized.docId, Buffer.from(delta).toString("base64"));

      return {
        appended: true,
        blockId,
        flavour,
        blockType,
        normalizedType: normalized.type,
        legacyType: normalized.legacyType || null,
        ownedIds: normalized._frameOwnedIds,
        missing: normalized._frameMissing,
      };
    } finally {
      socket.disconnect();
    }
  }

  function mergeWarnings(...sources: string[][]): string[] {
    const deduped = new Set<string>();
    for (const source of sources) {
      for (const warning of source) {
        deduped.add(warning);
      }
    }
    return [...deduped];
  }

  function markdownOperationToAppendInput(
    operation: MarkdownOperation,
    docId: string,
    workspaceId?: string,
    strict: boolean = true,
    placement?: AppendPlacement
  ): AppendBlockInput {
    switch (operation.type) {
      case "heading":
        return {
          workspaceId,
          docId,
          type: "heading",
          text: operation.text,
          level: operation.level,
          deltas: operation.deltas,
          strict,
          placement,
        };
      case "paragraph":
        return {
          workspaceId,
          docId,
          type: "paragraph",
          text: operation.text,
          deltas: operation.deltas,
          strict,
          placement,
        };
      case "quote":
        return {
          workspaceId,
          docId,
          type: "quote",
          text: operation.text,
          deltas: operation.deltas,
          strict,
          placement,
        };
      case "callout":
        return {
          workspaceId,
          docId,
          type: "callout",
          text: operation.text,
          deltas: operation.deltas,
          strict,
          placement,
        };
      case "list":
        return {
          workspaceId,
          docId,
          type: "list",
          text: operation.text,
          style: operation.style,
          checked: operation.checked,
          deltas: operation.deltas,
          strict,
          placement,
        };
      case "code":
        return {
          workspaceId,
          docId,
          type: "code",
          text: operation.text,
          language: operation.language,
          strict,
          placement,
        };
      case "divider":
        return {
          workspaceId,
          docId,
          type: "divider",
          strict,
          placement,
        };
      case "table":
        return {
          workspaceId,
          docId,
          type: "table",
          rows: operation.rows,
          columns: operation.columns,
          tableData: operation.tableData,
          tableCellDeltas: operation.tableCellDeltas,
          strict,
          placement,
        };
      case "bookmark":
        return {
          workspaceId,
          docId,
          type: "bookmark",
          url: operation.url,
          caption: operation.caption,
          strict,
          placement,
        };
      default: {
        const exhaustiveCheck: never = operation;
        throw new Error(`Unsupported markdown operation type: ${(exhaustiveCheck as any).type}`);
      }
    }
  }

  function collectDescendantBlockIds(blocks: Y.Map<any>, startIds: string[]): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const stack = [...startIds];

    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      result.push(current);
      const block = findBlockById(blocks, current);
      if (!block) {
        continue;
      }
      const children = childIdsFrom(block.get("sys:children"));
      for (const childId of children) {
        stack.push(childId);
      }
    }

    return result;
  }

  function asStringOrNull(value: unknown): string | null {
    if (typeof value === "string") {
      return value;
    }
    return null;
  }

  function richTextValueToString(value: unknown): string {
    if (value instanceof Y.Text) {
      return value.toString();
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }
          if (entry && typeof entry === "object" && typeof (entry as any).insert === "string") {
            return (entry as any).insert as string;
          }
          return "";
        })
        .join("");
    }
    if (value && typeof value === "object" && typeof (value as any).insert === "string") {
      return (value as any).insert as string;
    }
    return "";
  }

  function mapEntries(value: unknown): Array<[string, any]> {
    if (value instanceof Y.Map) {
      const entries: Array<[string, any]> = [];
      value.forEach((mapValue: unknown, key: string) => {
        entries.push([key, mapValue]);
      });
      return entries;
    }
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, any>);
    }
    return [];
  }

  function extractTableData(block: Y.Map<any>): string[][] | null {
    const rowsValue = block.get("prop:rows");
    const columnsValue = block.get("prop:columns");
    const cellsValue = block.get("prop:cells");

    let rowEntries = mapEntries(rowsValue)
      .map(([rowId, payload]) => ({
        rowId,
        order:
          payload && typeof payload === "object" && typeof (payload as any).order === "string"
            ? (payload as any).order
            : rowId,
      }))
      .sort((a, b) => a.order.localeCompare(b.order));

    let columnEntries = mapEntries(columnsValue)
      .map(([columnId, payload]) => ({
        columnId,
        order:
          payload && typeof payload === "object" && typeof (payload as any).order === "string"
            ? (payload as any).order
            : columnId,
      }))
      .sort((a, b) => a.order.localeCompare(b.order));

    let cells = new Map<string, string>();

    if (rowEntries.length === 0 || columnEntries.length === 0) {
      // Fallback: AFFiNE self-hosted stores table props as flat dot-notation keys
      // directly on the block Y.Map instead of nested Y.Maps:
      //   prop:rows.{rowId}.order
      //   prop:columns.{colId}.order
      //   prop:cells.{rowId}:{colId}.text  (Y.Text)
      const flatRows = new Map<string, string>(); // rowId -> order
      const flatColumns = new Map<string, string>(); // colId -> order
      const flatCells = new Map<string, string>(); // rowId:colId -> text

      block.forEach((value: unknown, key: string) => {
        const rowMatch = key.match(/^prop:rows\.([^.]+)\.order$/);
        if (rowMatch) {
          flatRows.set(rowMatch[1], typeof value === "string" ? value : rowMatch[1]);
          return;
        }
        const colMatch = key.match(/^prop:columns\.([^.]+)\.order$/);
        if (colMatch) {
          flatColumns.set(colMatch[1], typeof value === "string" ? value : colMatch[1]);
          return;
        }
        const cellMatch = key.match(/^prop:cells\.([^.]+:[^.]+)\.text$/);
        if (cellMatch) {
          flatCells.set(cellMatch[1], richTextValueToString(value));
        }
      });

      if (flatRows.size > 0 && flatColumns.size > 0) {
        rowEntries = Array.from(flatRows.entries())
          .map(([rowId, order]) => ({ rowId, order }))
          .sort((a, b) => a.order.localeCompare(b.order));
        columnEntries = Array.from(flatColumns.entries())
          .map(([columnId, order]) => ({ columnId, order }))
          .sort((a, b) => a.order.localeCompare(b.order));
        cells = flatCells;
      }
    } else {
      for (const [cellKey, payload] of mapEntries(cellsValue)) {
        if (payload instanceof Y.Map) {
          cells.set(cellKey, richTextValueToString(payload.get("text")));
          continue;
        }
        if (payload && typeof payload === "object" && "text" in payload) {
          cells.set(cellKey, richTextValueToString((payload as any).text));
        }
      }
    }

    if (rowEntries.length === 0 || columnEntries.length === 0) {
      return null;
    }

    const tableData: string[][] = [];
    for (const { rowId } of rowEntries) {
      const row: string[] = [];
      for (const { columnId } of columnEntries) {
        row.push(cells.get(`${rowId}:${columnId}`) ?? "");
      }
      tableData.push(row);
    }

    return tableData;
  }

  function collectDocForMarkdown(
    doc: Y.Doc,
    tagOptionsById: Map<string, WorkspaceTagOption> = new Map()
  ): {
    title: string;
    tags: string[];
    rootBlockIds: string[];
    blocksById: Map<string, MarkdownRenderableBlock>;
  } {
    const meta = doc.getMap("meta");
    const tags = resolveTagLabels(getStringArray(getTagArray(meta)), tagOptionsById);

    const blocks = doc.getMap("blocks") as Y.Map<any>;
    const pageId = findBlockIdByFlavour(blocks, "affine:page");
    const noteId = findBlockIdByFlavour(blocks, "affine:note");
    const blocksById = new Map<string, MarkdownRenderableBlock>();
    const visited = new Set<string>();

    let title = "";
    const rootBlockIds: string[] = [];
    if (pageId) {
      const pageBlock = findBlockById(blocks, pageId);
      if (pageBlock) {
        title = asText(pageBlock.get("prop:title"));
        rootBlockIds.push(...childIdsFrom(pageBlock.get("sys:children")));
      }
    } else if (noteId) {
      rootBlockIds.push(noteId);
    }

    if (rootBlockIds.length === 0) {
      for (const [id] of blocks) {
        rootBlockIds.push(String(id));
      }
    }

    const visit = (blockId: string) => {
      if (visited.has(blockId)) {
        return;
      }
      visited.add(blockId);

      const block = findBlockById(blocks, blockId);
      if (!block) {
        return;
      }

      const childIds = childIdsFrom(block.get("sys:children"));
      const entry: MarkdownRenderableBlock = {
        id: blockId,
        parentId: asStringOrNull(block.get("sys:parent")),
        flavour: asStringOrNull(block.get("sys:flavour")),
        type: asStringOrNull(block.get("prop:type")),
        text: asText(block.get("prop:text")) || null,
        checked: typeof block.get("prop:checked") === "boolean" ? Boolean(block.get("prop:checked")) : null,
        language: asStringOrNull(block.get("prop:language")),
        childIds,
        url: asStringOrNull(block.get("prop:url")),
        sourceId: asStringOrNull(block.get("prop:sourceId")),
        caption: asStringOrNull(block.get("prop:caption")),
        tableData: block.get("sys:flavour") === "affine:table" ? extractTableData(block) : null,
      };
      blocksById.set(blockId, entry);

      for (const childId of childIds) {
        visit(childId);
      }
    };

    for (const rootId of rootBlockIds) {
      visit(rootId);
    }

    for (const [id] of blocks) {
      visit(String(id));
    }

    return {
      title,
      tags,
      rootBlockIds,
      blocksById,
    };
  }

  function collectDocBlockRows(doc: Y.Doc): Array<{
    id: string;
    flavour: string | null;
    type: string | null;
    hasText: boolean;
    hasUrl: boolean;
    hasSourceId: boolean;
    childCount: number;
  }> {
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    const rows: Array<{
      id: string;
      flavour: string | null;
      type: string | null;
      hasText: boolean;
      hasUrl: boolean;
      hasSourceId: boolean;
      childCount: number;
    }> = [];

    for (const [id, raw] of blocks) {
      if (!(raw instanceof Y.Map)) {
        continue;
      }
      const textValue = asText(raw.get("prop:text"));
      rows.push({
        id: String(id),
        flavour: asStringOrNull(raw.get("sys:flavour")),
        type: asStringOrNull(raw.get("prop:type")),
        hasText: textValue.length > 0,
        hasUrl: asText(raw.get("prop:url")).trim().length > 0,
        hasSourceId: asText(raw.get("prop:sourceId")).trim().length > 0,
        childCount: childIdsFrom(raw.get("sys:children")).length,
      });
    }

    return rows;
  }

  function summarizeDocFidelity(doc: Y.Doc, tagOptionsById: Map<string, WorkspaceTagOption> = new Map()) {
    const collected = collectDocForMarkdown(doc, tagOptionsById);
    const rendered = renderBlocksToMarkdown({
      rootBlockIds: collected.rootBlockIds,
      blocksById: collected.blocksById,
    });
    const blockRows = collectDocBlockRows(doc);
    const flavourCounts: Record<string, number> = {};
    const unsupportedBlocks: Array<{ id: string; flavour: string | null; reason: string }> = [];
    const conditionallyRiskyBlocks: Array<{ id: string; flavour: string | null; reason: string }> = [];

    for (const block of blockRows) {
      const flavourKey = block.flavour || "unknown";
      flavourCounts[flavourKey] = (flavourCounts[flavourKey] ?? 0) + 1;

      if (!block.flavour) {
        unsupportedBlocks.push({ id: block.id, flavour: null, reason: "Block flavour is missing." });
        continue;
      }

      if (!KNOWN_BLOCK_FLAVOURS.has(block.flavour)) {
        unsupportedBlocks.push({
          id: block.id,
          flavour: block.flavour,
          reason: "Block flavour is unknown to this MCP build.",
        });
        continue;
      }

      if (!MARKDOWN_EXPORT_SUPPORTED_FLAVOURS.has(block.flavour)) {
        unsupportedBlocks.push({
          id: block.id,
          flavour: block.flavour,
          reason: "Markdown export does not have a native renderer for this flavour.",
        });
        continue;
      }

      if (block.flavour === "affine:image" && !block.hasSourceId) {
        conditionallyRiskyBlocks.push({
          id: block.id,
          flavour: block.flavour,
          reason: "Image block has no sourceId; markdown export will skip it.",
        });
      }

      if (
        (block.flavour === "affine:bookmark" ||
          block.flavour === "affine:embed-youtube" ||
          block.flavour === "affine:embed-github" ||
          block.flavour === "affine:embed-figma" ||
          block.flavour === "affine:embed-loom" ||
          block.flavour === "affine:embed-iframe") &&
        !block.hasUrl
      ) {
        conditionallyRiskyBlocks.push({
          id: block.id,
          flavour: block.flavour,
          reason: "Embed/bookmark block has no URL; markdown export will skip it.",
        });
      }
    }

    const overallRisk =
      unsupportedBlocks.length > 0
        ? "high"
        : conditionallyRiskyBlocks.length > 0 || rendered.lossy
          ? "medium"
          : "low";

    return {
      title: collected.title || null,
      tags: collected.tags,
      rootBlockIds: collected.rootBlockIds,
      markdown: rendered.markdown,
      markdownWarnings: rendered.warnings,
      markdownLossy: rendered.lossy,
      flavourCounts,
      unsupportedBlocks,
      conditionallyRiskyBlocks,
      overallRisk,
      recommendedPath:
        overallRisk === "low"
          ? "markdown_export_ok"
          : overallRisk === "medium"
            ? "markdown_export_with_review"
            : "prefer_native_read_or_clone",
      stats: {
        blockCount: blockRows.length,
        markdownUnsupportedCount: rendered.stats.unsupportedCount,
        unsupportedBlockCount: unsupportedBlocks.length,
        conditionallyRiskyBlockCount: conditionallyRiskyBlocks.length,
      },
    };
  }

  type NativeTemplateSupportIssue = {
    path: string;
    reason: string;
  };

  type NativeTemplateBlockSummary = {
    id: string;
    parentId: string | null;
    flavour: string | null;
    type: string | null;
    textPreview: string | null;
    textLength: number;
    childIds: string[];
  };

  type NativeTemplateStructureSummary = {
    workspaceId: string;
    templateDocId: string;
    title: string;
    tags: string[];
    pageId: string | null;
    surfaceId: string | null;
    noteId: string | null;
    rootBlockIds: string[];
    blockCount: number;
    blocks: NativeTemplateBlockSummary[];
    nativeCloneSupported: boolean;
    fallbackReasons: string[];
  };

  type NativeTemplateCloneContext = {
    sourceDocId: string;
    targetDocId: string;
    blockIdMap: Map<string, string>;
    variables: Record<string, string>;
    unresolvedVariables: Set<string>;
    replacedVariableCount: number;
  };

  function truncateTemplatePreview(text: string, maxLength: number = 140): string {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength - 1)}…`;
  }

  function substituteTemplateVariables(input: string, ctx: NativeTemplateCloneContext): string {
    return input.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
      const value = ctx.variables[key];
      if (value === undefined) {
        ctx.unresolvedVariables.add(match);
        return match;
      }
      ctx.replacedVariableCount += 1;
      return value;
    });
  }

  function remapTemplateString(value: string, ctx: NativeTemplateCloneContext): string {
    const remapped = ctx.blockIdMap.get(value) ?? (value === ctx.sourceDocId ? ctx.targetDocId : value);
    return substituteTemplateVariables(remapped, ctx);
  }

  function cloneNativeTemplateValue(value: unknown, ctx: NativeTemplateCloneContext, path: string): unknown {
    if (typeof value === "string") {
      return remapTemplateString(value, ctx);
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
      return value;
    }
    if (value instanceof Y.Text) {
      const next = new Y.Text();
      let offset = 0;
      value.toDelta().forEach((delta: any) => {
        const insert = typeof delta?.insert === "string"
          ? substituteTemplateVariables(delta.insert, ctx)
          : delta?.insert;
        const attributes = delta?.attributes ? cloneNativeTemplateValue(delta.attributes, ctx, `${path}.attributes`) : undefined;
        if (typeof insert === "string") {
          next.insert(offset, insert, (attributes && typeof attributes === "object") ? attributes as any : {});
          offset += insert.length;
        } else if (insert !== undefined) {
          const text = String(insert);
          next.insert(offset, text, (attributes && typeof attributes === "object") ? attributes as any : {});
          offset += text.length;
        }
      });
      return next;
    }
    if (value instanceof Y.Array) {
      const next = new Y.Array<any>();
      value.forEach((entry: unknown) => {
        next.push([cloneNativeTemplateValue(entry, ctx, `${path}[]`)]);
      });
      return next;
    }
    if (value instanceof Y.Map) {
      const next = new Y.Map<any>();
      for (const [key, entry] of value) {
        next.set(String(key), cloneNativeTemplateValue(entry, ctx, `${path}.${String(key)}`));
      }
      return next;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => cloneNativeTemplateValue(entry, ctx, `${path}[${index}]`));
    }
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    if (value instanceof RegExp) {
      return new RegExp(value.source, value.flags);
    }
    if (typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        const next: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          next[key] = cloneNativeTemplateValue(entry, ctx, `${path}.${key}`);
        }
        return next;
      }
      throw new Error(`Unsupported native template value at ${path}: ${value.constructor?.name || "unknown"}.`);
    }
    return value;
  }

  function scanNativeTemplateValue(value: unknown, path: string, issues: NativeTemplateSupportIssue[], seen: WeakSet<object>): void {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return;
    }
    if (value instanceof Y.Text) {
      for (const delta of value.toDelta()) {
        if (delta?.attributes && typeof delta.attributes === "object") {
          scanNativeTemplateValue(delta.attributes, `${path}.attributes`, issues, seen);
        }
      }
      return;
    }
    if (value instanceof Y.Array) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      let index = 0;
      value.forEach((entry: unknown) => {
        scanNativeTemplateValue(entry, `${path}[${index}]`, issues, seen);
        index += 1;
      });
      return;
    }
    if (value instanceof Y.Map) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      for (const [key, entry] of value) {
        scanNativeTemplateValue(entry, `${path}.${String(key)}`, issues, seen);
      }
      return;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      value.forEach((entry, index) => {
        scanNativeTemplateValue(entry, `${path}[${index}]`, issues, seen);
      });
      return;
    }
    if (value instanceof Date || value instanceof RegExp) {
      return;
    }
    if (typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        if (seen.has(value)) {
          return;
        }
        seen.add(value);
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          scanNativeTemplateValue(entry, `${path}.${key}`, issues, seen);
        }
        return;
      }
      issues.push({
        path,
        reason: `Unsupported native template value type: ${value.constructor?.name || "unknown"}.`,
      });
    }
  }

  function summarizeNativeTemplateStructure(
    doc: Y.Doc,
    workspaceId: string,
    templateDocId: string,
    tagLabels: string[],
    supportIssues: NativeTemplateSupportIssue[]
  ): NativeTemplateStructureSummary {
    const meta = doc.getMap("meta");
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    const pageId = findBlockIdByFlavour(blocks, "affine:page");
    const surfaceId = findBlockIdByFlavour(blocks, "affine:surface");
    const noteId = findBlockIdByFlavour(blocks, "affine:note");
    const visited = new Set<string>();
    const summaries: NativeTemplateBlockSummary[] = [];
    const rootBlockIds: string[] = [];

    if (pageId) {
      const pageBlock = findBlockById(blocks, pageId);
      if (pageBlock) {
        rootBlockIds.push(...childIdsFrom(pageBlock.get("sys:children")));
      }
    } else if (noteId) {
      rootBlockIds.push(noteId);
    }
    if (rootBlockIds.length === 0) {
      for (const [id] of blocks) {
        rootBlockIds.push(String(id));
      }
    }

    const visit = (blockId: string) => {
      if (visited.has(blockId)) {
        return;
      }
      visited.add(blockId);

      const block = findBlockById(blocks, blockId);
      if (!block) {
        return;
      }

      const childIds = childIdsFrom(block.get("sys:children"));
      const textValue = asText(block.get("prop:text"));
      summaries.push({
        id: blockId,
        parentId: resolveBlockParentId(blocks, blockId),
        flavour: asStringOrNull(block.get("sys:flavour")),
        type: asStringOrNull(block.get("prop:type")),
        textPreview: textValue.length > 0 ? truncateTemplatePreview(textValue) : null,
        textLength: textValue.length,
        childIds,
      });

      for (const childId of childIds) {
        visit(childId);
      }
    };

    for (const rootId of rootBlockIds) {
      visit(rootId);
    }
    for (const [id] of blocks) {
      visit(String(id));
    }

    const title = asText(meta.get("title")) || "Untitled";

    return {
      workspaceId,
      templateDocId,
      title,
      tags: tagLabels,
      pageId,
      surfaceId,
      noteId,
      rootBlockIds,
      blockCount: summaries.length,
      blocks: summaries,
      nativeCloneSupported: supportIssues.length === 0,
      fallbackReasons: supportIssues.map(issue => `${issue.path}: ${issue.reason}`),
    };
  }

  async function applyMarkdownOperationsInternal(parsed: {
    workspaceId: string;
    docId: string;
    operations: MarkdownOperation[];
    strict?: boolean;
    placement?: AppendPlacement;
    replaceExisting?: boolean;
  }): Promise<{
    appendedCount: number;
    skippedCount: number;
    blockIds: string[];
  }> {
    const strict = parsed.strict !== false;
    const replaceExisting = parsed.replaceExisting === true;
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

    try {
      await joinWorkspace(socket, parsed.workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, parsed.workspaceId, parsed.docId);
      if (!snapshot.missing) {
        throw new Error(`Document ${parsed.docId} was not found in workspace ${parsed.workspaceId}.`);
      }

      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      let anchorPlacement: AppendPlacement | undefined = parsed.placement;
      let lastInsertedBlockId: string | undefined;
      let replaceParentId: string | undefined;
      let skippedCount = 0;
      const blockIds: string[] = [];

      if (replaceExisting) {
        replaceParentId = ensureNoteBlock(blocks);
        const noteBlock = findBlockById(blocks, replaceParentId);
        if (!noteBlock) {
          throw new Error("Unable to resolve note block for markdown replacement.");
        }
        const noteChildren = ensureChildrenArray(noteBlock);
        const existingChildren = childIdsFrom(noteChildren);
        const descendantBlockIds = collectDescendantBlockIds(blocks, existingChildren);
        for (const descendantId of descendantBlockIds) {
          blocks.delete(descendantId);
        }
        if (noteChildren.length > 0) {
          noteChildren.delete(0, noteChildren.length);
        }
      }

      for (const operation of parsed.operations) {
        const placement =
          lastInsertedBlockId
            ? { afterBlockId: lastInsertedBlockId }
            : replaceParentId
              ? { parentId: replaceParentId }
              : anchorPlacement;
        const appendInput = markdownOperationToAppendInput(
          operation,
          parsed.docId,
          parsed.workspaceId,
          strict,
          placement
        );

        try {
          const normalized = normalizeAppendBlockInput(appendInput);
          const context = resolveInsertContext(blocks, normalized);
          const { blockId, block, extraBlocks } = createBlock(normalized);
          blocks.set(blockId, block);
          if (Array.isArray(extraBlocks)) {
            for (const extra of extraBlocks) {
              blocks.set(extra.blockId, extra.block);
            }
          }
          if (context.insertIndex >= context.children.length) {
            context.children.push([blockId]);
          } else {
            context.children.insert(context.insertIndex, [blockId]);
          }
          blockIds.push(blockId);
          lastInsertedBlockId = blockId;
          if (!replaceParentId) {
            anchorPlacement = { afterBlockId: blockId };
          }
        } catch {
          skippedCount += 1;
        }
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, parsed.workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return {
        appendedCount: blockIds.length,
        skippedCount,
        blockIds,
      };
    } finally {
      socket.disconnect();
    }
  }

  async function createDocInternal(parsed: CreateDocInput): Promise<CreateDocResult> {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it or set AFFINE_WORKSPACE_ID.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const docId = generateId();
      const title = parsed.title || "Untitled";
      const ydoc = new Y.Doc();
      const blocks = ydoc.getMap("blocks");
      const pageId = generateId();
      const page = new Y.Map();
      setSysFields(page, pageId, "affine:page");
      const titleText = new Y.Text();
      titleText.insert(0, title);
      page.set("prop:title", titleText);
      const children = new Y.Array();
      page.set("sys:children", children);
      blocks.set(pageId, page);

      const surfaceId = generateId();
      const surface = new Y.Map();
      setSysFields(surface, surfaceId, "affine:surface");
      surface.set("sys:parent", null);
      surface.set("sys:children", new Y.Array());
      const elements = new Y.Map<any>();
      elements.set("type", "$blocksuite:internal:native$");
      elements.set("value", new Y.Map<any>());
      surface.set("prop:elements", elements);
      blocks.set(surfaceId, surface);
      children.push([surfaceId]);

      const noteId = generateId();
      const note = new Y.Map();
      setSysFields(note, noteId, "affine:note");
      note.set("sys:parent", null);
      note.set("prop:displayMode", "both");
      note.set("prop:xywh", DEFAULT_NOTE_XYWH);
      note.set("prop:index", "a0");
      note.set("prop:hidden", false);
      note.set("prop:background", buildDefaultNoteBackground());
      const noteChildren = new Y.Array();
      note.set("sys:children", noteChildren);
      blocks.set(noteId, note);
      children.push([noteId]);

      const paraId = generateId();
      const para = new Y.Map();
      setSysFields(para, paraId, "affine:paragraph");
      para.set("sys:parent", null);
      para.set("sys:children", new Y.Array());
      para.set("prop:type", "text");
      const paragraphText = new Y.Text();
      if (parsed.content) paragraphText.insert(0, parsed.content);
      para.set("prop:text", paragraphText);
      blocks.set(paraId, para);
      noteChildren.push([paraId]);

      const meta = ydoc.getMap("meta");
      meta.set("id", docId);
      meta.set("title", title);
      meta.set("createDate", Date.now());
      meta.set("tags", new Y.Array());

      const updateFull = Y.encodeStateAsUpdate(ydoc);
      const updateBase64 = Buffer.from(updateFull).toString("base64");
      await pushDocUpdate(socket, workspaceId, docId, updateBase64);

      const wsDoc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (snapshot.missing) {
        Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
      }
      const prevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap("meta");
      let pages = wsMeta.get("pages") as Y.Array<Y.Map<any>> | undefined;
      if (!pages) {
        pages = new Y.Array();
        wsMeta.set("pages", pages);
      }
      const entry = new Y.Map();
      entry.set("id", docId);
      entry.set("title", title);
      entry.set("createDate", Date.now());
      entry.set("tags", new Y.Array());
      pages.push([entry as any]);
      const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      const wsDeltaBase64 = Buffer.from(wsDelta).toString("base64");
      await pushDocUpdate(socket, workspaceId, workspaceId, wsDeltaBase64);

      return {
        workspaceId,
        docId,
        title,
        parentDocId: null,
        linkedToParent: false,
        warnings: [],
      };
    } finally {
      socket.disconnect();
    }
  }

  async function finalizeDocPlacement(parsed: {
    workspaceId: string;
    docId: string;
    parentDocId?: string;
    context: string;
  }): Promise<{ parentDocId: string | null; linkedToParent: boolean; warnings: string[] }> {
    const parentDocId = parsed.parentDocId?.trim();
    if (!parentDocId) {
      return { parentDocId: null, linkedToParent: false, warnings: [] };
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, parsed.workspaceId);
      const workspaceSnapshot = await loadDoc(socket, parsed.workspaceId, parsed.workspaceId);
      if (!workspaceSnapshot.missing) {
        return {
          parentDocId,
          linkedToParent: false,
          warnings: [`${parsed.context}: workspace metadata could not be loaded to verify parent doc "${parentDocId}". Link it manually.`],
        };
      }

      const workspaceDoc = new Y.Doc();
      Y.applyUpdate(workspaceDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
      const parentExists = getWorkspacePageEntries(workspaceDoc.getMap("meta")).some(page => page.id === parentDocId);
      if (!parentExists) {
        return {
          parentDocId,
          linkedToParent: false,
          warnings: [`${parsed.context}: parent doc "${parentDocId}" was not found in workspace "${parsed.workspaceId}". Doc was left at the workspace root.`],
        };
      }

      try {
        await appendBlockInternal({
          workspaceId: parsed.workspaceId,
          docId: parentDocId,
          type: "embed_linked_doc",
          pageId: parsed.docId,
        });
        return { parentDocId, linkedToParent: true, warnings: [] };
      } catch {
        return {
          parentDocId,
          linkedToParent: false,
          warnings: [`${parsed.context}: doc created but could not be linked to parent doc "${parentDocId}". Link it manually.`],
        };
      }
    } finally {
      socket.disconnect();
    }
  }

  function createDocSkeleton(title: string, docId: string): {
    doc: Y.Doc;
    blocks: Y.Map<any>;
    pageId: string;
    surfaceId: string;
    noteId: string;
  } {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks");
    const pageId = generateId();
    const page = new Y.Map();
    setSysFields(page, pageId, "affine:page");
    const titleText = new Y.Text();
    titleText.insert(0, title);
    page.set("prop:title", titleText);
    page.set("sys:children", new Y.Array());
    blocks.set(pageId, page);

    const surfaceId = generateId();
    const surface = new Y.Map();
    setSysFields(surface, surfaceId, "affine:surface");
    surface.set("sys:parent", null);
    surface.set("sys:children", new Y.Array());
    const elements = new Y.Map<any>();
    elements.set("type", "$blocksuite:internal:native$");
    elements.set("value", new Y.Map<any>());
    surface.set("prop:elements", elements);
    blocks.set(surfaceId, surface);
    (page.get("sys:children") as Y.Array<any>).push([surfaceId]);

    const noteId = generateId();
    const note = new Y.Map();
    setSysFields(note, noteId, "affine:note");
    note.set("sys:parent", null);
    note.set("prop:displayMode", "both");
    note.set("prop:xywh", DEFAULT_NOTE_XYWH);
    note.set("prop:index", "a0");
    note.set("prop:hidden", false);
    note.set("prop:background", buildDefaultNoteBackground());
    const skeletonNoteChildren = new Y.Array<string>();
    note.set("sys:children", skeletonNoteChildren);
    blocks.set(noteId, note);
    (page.get("sys:children") as Y.Array<any>).push([noteId]);

    const skeletonParaId = generateId();
    const skeletonPara = new Y.Map();
    setSysFields(skeletonPara, skeletonParaId, "affine:paragraph");
    skeletonPara.set("sys:parent", null);
    skeletonPara.set("sys:children", new Y.Array());
    skeletonPara.set("prop:type", "text");
    skeletonPara.set("prop:text", new Y.Text());
    blocks.set(skeletonParaId, skeletonPara);
    skeletonNoteChildren.push([skeletonParaId]);

    const meta = doc.getMap("meta");
    meta.set("id", docId);
    meta.set("title", title);
    meta.set("createDate", Date.now());
    meta.set("tags", new Y.Array());

    return { doc, blocks, pageId, surfaceId, noteId };
  }

  function makeWorkspacePageEntry(docId: string, title: string): Y.Map<any> {
    const entry = new Y.Map();
    entry.set("id", docId);
    entry.set("title", title);
    entry.set("createDate", Date.now());
    entry.set("tags", new Y.Array());
    return entry;
  }

  function defaultSemanticSections(pageType: SemanticPageType): SemanticSectionInput[] {
    switch (pageType) {
      case "meeting_notes":
        return [
          { title: "Attendees" },
          { title: "Agenda" },
          { title: "Notes" },
          { title: "Action Items" },
        ];
      case "project_hub":
        return [
          { title: "Overview" },
          { title: "Milestones" },
          { title: "Risks" },
          { title: "References" },
        ];
      case "spec_page":
        return [
          { title: "Context" },
          { title: "Goals" },
          { title: "Non-Goals" },
          { title: "Proposal" },
          { title: "Open Questions" },
        ];
      case "wiki_page":
      default:
        return [
          { title: "Summary" },
          { title: "Details" },
          { title: "Related Resources" },
        ];
    }
  }

  function normalizeSemanticSections(
    pageType: SemanticPageType | undefined,
    sections: SemanticSectionInput[] | undefined
  ): SemanticSectionInput[] {
    const source = sections?.length ? sections : defaultSemanticSections(pageType ?? "wiki_page");
    return source.map((section) => ({
      title: section.title.trim(),
      paragraphs: section.paragraphs?.map((paragraph) => paragraph.trim()).filter(Boolean),
      bullets: section.bullets?.map((bullet) => bullet.trim()).filter(Boolean),
      callouts: section.callouts?.map((callout) => callout.trim()).filter(Boolean),
    }));
  }

  function semanticSectionToAppendInputs(section: SemanticSectionInput): SemanticBlockDraft[] {
    const inputs: SemanticBlockDraft[] = [
      {
        type: "heading",
        text: section.title,
        level: 2,
      },
    ];

    for (const paragraph of section.paragraphs ?? []) {
      inputs.push({
        type: "paragraph",
        text: paragraph,
      });
    }

    for (const bullet of section.bullets ?? []) {
      inputs.push({
        type: "list",
        text: bullet,
        style: "bulleted",
      });
    }

    for (const callout of section.callouts ?? []) {
      inputs.push({
        type: "callout",
        text: callout,
      });
    }

    return inputs;
  }

  function appendNativeBlocks(
    blocks: Y.Map<any>,
    parentId: string,
    inputs: SemanticBlockDraft[],
    workspaceId: string,
    docId: string,
    strict: boolean = true,
    initialPlacement?: AppendPlacement
  ): { blockIds: string[]; headingIds: string[] } {
    const parentBlock = findBlockById(blocks, parentId);
    if (!parentBlock) {
      throw new Error(`Target parent block '${parentId}' was not found.`);
    }
    let anchorPlacement: AppendPlacement | undefined = initialPlacement ?? { parentId };
    const blockIds: string[] = [];
    const headingIds: string[] = [];

    for (const input of inputs) {
      const normalized = normalizeAppendBlockInput({
        workspaceId,
        docId,
        strict,
        placement: anchorPlacement,
        ...input,
      });
      const context = resolveInsertContext(blocks, normalized);
      const { blockId, block, extraBlocks } = createBlock(normalized);
      blocks.set(blockId, block);
      if (Array.isArray(extraBlocks)) {
        for (const extra of extraBlocks) {
          blocks.set(extra.blockId, extra.block);
        }
      }
      if (context.insertIndex >= context.children.length) {
        context.children.push([blockId]);
      } else {
        context.children.insert(context.insertIndex, [blockId]);
      }
      blockIds.push(blockId);
      if (normalized.type === "heading") {
        headingIds.push(blockId);
      }
      anchorPlacement = { afterBlockId: blockId };
    }

    return { blockIds, headingIds };
  }

  function isHeadingBlock(block: Y.Map<any>): boolean {
    return block.get("sys:flavour") === "affine:paragraph" && /^h[1-6]$/.test(String(block.get("prop:type") || ""));
  }

  function getHeadingLevel(block: Y.Map<any>): number | null {
    const type = String(block.get("prop:type") || "");
    const match = type.match(/^h([1-6])$/);
    return match ? Number(match[1]) : null;
  }

  function normalizedText(value: unknown): string {
    return richTextValueToString(value).trim().toLocaleLowerCase();
  }

  function findSectionInsertionIndex(blocks: Y.Map<any>, noteId: string, sectionTitle: string): number {
    const noteBlock = findBlockById(blocks, noteId);
    if (!noteBlock) {
      throw new Error(`Note block '${noteId}' was not found.`);
    }
    const children = childIdsFrom(noteBlock.get("sys:children"));
    const target = normalizedText(sectionTitle);
    for (let i = 0; i < children.length; i += 1) {
      const childBlock = findBlockById(blocks, children[i]);
      if (!childBlock || !isHeadingBlock(childBlock)) {
        continue;
      }
      if (normalizedText(childBlock.get("prop:text")) !== target) {
        continue;
      }
      const targetLevel = getHeadingLevel(childBlock) ?? 2;
      let endIndex = i + 1;
      while (endIndex < children.length) {
        const nextBlock = findBlockById(blocks, children[endIndex]);
        if (nextBlock && isHeadingBlock(nextBlock)) {
          const nextLevel = getHeadingLevel(nextBlock) ?? 2;
          if (nextLevel <= targetLevel) {
            break;
          }
        }
        endIndex += 1;
      }
      return endIndex;
    }
    throw new Error(`Section heading '${sectionTitle}' was not found.`);
  }

  async function commitNewDocument(
    socket: any,
    workspaceId: string,
    docId: string,
    title: string,
    doc: Y.Doc
  ) {
    const updateFull = Y.encodeStateAsUpdate(doc);
    await pushDocUpdate(socket, workspaceId, docId, Buffer.from(updateFull).toString("base64"));

    const wsDoc = new Y.Doc();
    const snapshot = await loadDoc(socket, workspaceId, workspaceId);
    if (snapshot.missing) {
      Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
    }
    const prevSV = Y.encodeStateVector(wsDoc);
    const wsMeta = wsDoc.getMap("meta");
    let pages = wsMeta.get("pages") as Y.Array<Y.Map<any>> | undefined;
    if (!pages) {
      pages = new Y.Array();
      wsMeta.set("pages", pages);
    }
    pages.push([makeWorkspacePageEntry(docId, title)]);
    const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
    await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString("base64"));
  }

  async function createSemanticPageInternal(parsed: SemanticPageInput): Promise<{
    workspaceId: string;
    docId: string;
    title: string;
    pageType: SemanticPageType;
    noteId: string;
    pageId: string;
    sectionHeadingIds: string[];
    blockIds: string[];
    parentLinked: boolean;
    warnings: string[];
  }> {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it or set AFFINE_WORKSPACE_ID.");
    }
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

    try {
      await joinWorkspace(socket, workspaceId);

      const docId = generateId();
      const title = parsed.title || "Untitled";
      const pageType = parsed.pageType ?? "wiki_page";
      const sections = normalizeSemanticSections(pageType, parsed.sections);
      const docShell = createDocSkeleton(title, docId);
      const { blockIds, headingIds } = appendNativeBlocks(
        docShell.blocks,
        docShell.noteId,
        sections.flatMap(semanticSectionToAppendInputs),
        workspaceId,
        docId
      );

      await commitNewDocument(socket, workspaceId, docId, title, docShell.doc);

      let parentLinked = false;
      const warnings: string[] = [];
      if (parsed.parentDocId) {
        try {
          await appendBlockInternal({
            workspaceId,
            docId: parsed.parentDocId,
            type: "embed_linked_doc",
            pageId: docId,
          });
          parentLinked = true;
        } catch {
          warnings.push(`Semantic page created but could not be linked to parent doc "${parsed.parentDocId}". Link it manually.`);
        }
      }

      return {
        workspaceId,
        docId,
        title,
        pageType,
        noteId: docShell.noteId,
        pageId: docShell.pageId,
        sectionHeadingIds: headingIds,
        blockIds,
        parentLinked,
        warnings,
      };
    } finally {
      socket.disconnect();
    }
  }

  async function appendSemanticSectionInternal(parsed: AppendSemanticSectionInput): Promise<{
    workspaceId: string;
    docId: string;
    noteId: string;
    sectionTitle: string;
    sectionHeadingId: string;
    afterSectionTitle: string | null;
    blockIds: string[];
  }> {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it or set AFFINE_WORKSPACE_ID.");
    }
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) {
        throw new Error(`Document ${parsed.docId} was not found in workspace ${workspaceId}.`);
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);

      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const noteId = ensureNoteBlock(blocks);
      const insertionIndex = parsed.afterSectionTitle
        ? findSectionInsertionIndex(blocks, noteId, parsed.afterSectionTitle)
        : childIdsFrom(findBlockById(blocks, noteId)?.get("sys:children")).length;
      const { blockIds, headingIds } = appendNativeBlocks(
        blocks,
        noteId,
        semanticSectionToAppendInputs({
          title: parsed.sectionTitle,
          paragraphs: parsed.paragraphs,
          bullets: parsed.bullets,
          callouts: parsed.callouts,
        }),
        workspaceId,
        parsed.docId,
        true,
        { parentId: noteId, index: insertionIndex }
      );

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return {
        workspaceId,
        docId: parsed.docId,
        noteId,
        sectionTitle: parsed.sectionTitle,
        sectionHeadingId: headingIds[0] || blockIds[0],
        afterSectionTitle: parsed.afterSectionTitle ?? null,
        blockIds,
      };
    } finally {
      socket.disconnect();
    }
  }

  const listDocsHandler = async (parsed: { workspaceId?: string; first?: number; offset?: number; after?: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const query = `query ListDocs($workspaceId: String!, $first: Int, $offset: Int, $after: String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      const docs = data.workspace.docs;

      const tagsByDocId = new Map<string, string[]>();
      const titlesByDocId = new Map<string, string>();
      let workspacePageCount: number | null = null;
      let workspacePageIds: Set<string> | null = null;
      const deletedDocIds = new Set<string>();
      try {
        const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
        const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
        try {
          await joinWorkspace(socket, workspaceId);
          const snapshot = await loadDoc(socket, workspaceId, workspaceId);
          if (snapshot.missing) {
            const wsDoc = new Y.Doc();
            Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
            const meta = wsDoc.getMap("meta");
            const pages = getWorkspacePageEntries(meta);
            workspacePageCount = pages.length;
            workspacePageIds = new Set(pages.map(page => page.id));
            const { byId } = getWorkspaceTagOptionMaps(meta);
            for (const page of pages) {
              if (page.title) {
                titlesByDocId.set(page.id, page.title);
              }
              const tagEntries = getStringArray(page.tagsArray);
              tagsByDocId.set(page.id, resolveTagLabels(tagEntries, byId));
            }
          }
          const graphEdges = Array.isArray(docs?.edges) ? docs.edges : [];
          if (workspacePageIds && graphEdges.length > workspacePageIds.size) {
            for (const edge of graphEdges) {
              const nodeId = edge?.node?.id;
              if (typeof nodeId !== "string" || workspacePageIds.has(nodeId)) {
                continue;
              }
              const edgeSnapshot = await loadDoc(socket, workspaceId, nodeId);
              // Treat timestamp-only responses as deleted tombstones so list_docs can
              // hide stale GraphQL edges after delete_doc eventually converges.
              const edgeExists = Boolean(edgeSnapshot.missing || edgeSnapshot.state);
              if (!edgeExists) {
                deletedDocIds.add(nodeId);
              }
            }
          }
        } finally {
          socket.disconnect();
        }
      } catch {
        // Keep list_docs available even when workspace snapshot fetch fails.
      }

      const mergedEdges = Array.isArray(docs?.edges)
        ? docs.edges.map((edge: any) => {
            const node = edge?.node;
            if (!node || typeof node.id !== "string") {
              return edge;
            }
            return {
              ...edge,
              node: {
                ...node,
                title: titlesByDocId.get(node.id) || node.title,
                tags: tagsByDocId.get(node.id) || [],
              },
            };
          })
        : [];

      const visibleEdges = deletedDocIds.size > 0
        ? mergedEdges.filter((edge: any) => !deletedDocIds.has(edge?.node?.id))
        : mergedEdges;

      const correctedTotalCount =
        typeof docs?.totalCount === "number" &&
        typeof workspacePageCount === "number" &&
        (
          deletedDocIds.size > 0 ||
          visibleEdges.length === workspacePageCount
        ) &&
        workspacePageCount < docs.totalCount
          ? workspacePageCount
          : docs?.totalCount;

      const correctedPageInfo = docs?.pageInfo
        ? {
            ...docs.pageInfo,
            endCursor: visibleEdges.length > 0 ? visibleEdges[visibleEdges.length - 1]?.cursor ?? null : null,
            hasNextPage:
              typeof correctedTotalCount === "number" && !parsed.after
                ? (parsed.offset ?? 0) + visibleEdges.length < correctedTotalCount
                : docs.pageInfo.hasNextPage,
          }
        : docs?.pageInfo;

      const mergedDocs = {
        ...docs,
        totalCount: correctedTotalCount,
        pageInfo: correctedPageInfo,
        edges: visibleEdges,
      };

      return text(mergedDocs);
    };
  server.registerTool(
    "list_docs",
    {
      title: "List Documents",
      description: "List documents in a workspace (GraphQL).",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    listDocsHandler as any
  );

  const listTagsHandler = async (parsed: { workspaceId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!snapshot.missing) {
        return text({ workspaceId, totalTags: 0, tags: [] });
      }

      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
      const meta = wsDoc.getMap("meta");
      const pages = getWorkspacePageEntries(meta);
      const { options, byId } = getWorkspaceTagOptionMaps(meta);

      const tagCounts = new Map<string, number>();
      for (const option of options) {
        const normalized = option.value.trim();
        if (!normalized || tagCounts.has(normalized)) {
          continue;
        }
        tagCounts.set(normalized, 0);
      }

      for (const page of pages) {
        const uniqueTags = new Set<string>();
        const resolved = resolveTagLabels(getStringArray(page.tagsArray), byId);
        for (const tag of resolved) {
          const normalized = tag.trim();
          if (!normalized) {
            continue;
          }
          uniqueTags.add(normalized);
        }
        for (const tag of uniqueTags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }

      const tags = [...tagCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, docCount]) => ({ name, docCount }));

      return text({
        workspaceId,
        totalTags: tags.length,
        tags,
      });
    } finally {
      socket.disconnect();
    }
  };
  const getSearchMatchRank = (
    title: string | null,
    normalizedQuery: string,
    matchMode: "substring" | "prefix" | "exact",
  ): number | null => {
    if (!title) return null;
    const normalizedTitle = title.toLocaleLowerCase();
    const isExact = normalizedTitle === normalizedQuery;
    const isPrefix = normalizedTitle.startsWith(normalizedQuery);
    const isSubstring = normalizedTitle.includes(normalizedQuery);

    if (matchMode === "exact") {
      return isExact ? 0 : null;
    }
    if (matchMode === "prefix") {
      return isPrefix ? (isExact ? 0 : 1) : null;
    }
    if (isExact) return 0;
    if (isPrefix) return 1;
    if (isSubstring) return 2;
    return null;
  };

  // search_docs: fast title search via workspace metadata (no per-doc loading needed)
  const searchDocsHandler = async (parsed: {
    workspaceId?: string;
    query: string;
    limit?: number;
    matchMode?: "substring" | "prefix" | "exact";
    tag?: string;
    sortBy?: "relevance" | "updatedAt";
    sortDirection?: "asc" | "desc";
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const q = (parsed.query ?? "").toLocaleLowerCase().trim();
    if (!q) throw new Error("query is required.");
    const limit = parsed.limit ?? 20;
    const matchMode = parsed.matchMode ?? "substring";
    const sortBy = parsed.sortBy ?? "relevance";
    const sortDirection = parsed.sortDirection ?? "desc";
    const normalizedTag = (parsed.tag ?? "").toLocaleLowerCase().trim();

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!snapshot.missing) {
        return text({ query: q, results: [], totalCount: 0 });
      }
      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
      const meta = wsDoc.getMap("meta");
      const pages = getWorkspacePageEntries(meta);
      const { byId } = getWorkspaceTagOptionMaps(meta);

      const baseUrl = (process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, '')).replace(/\/$/, '');
      const filtered = pages
        .map((page) => {
          const rank = getSearchMatchRank(page.title, q, matchMode);
          if (rank === null) {
            return null;
          }
          const tags = resolveTagLabels(getStringArray(page.tagsArray), byId);
          if (normalizedTag && !tags.some((tag) => tag.toLocaleLowerCase().includes(normalizedTag))) {
            return null;
          }
          const updatedTimestamp = page.updatedDate ?? page.createDate ?? 0;
          return {
            docId: page.id,
            title: page.title,
            tags,
            updatedAt: updatedTimestamp > 0 ? new Date(updatedTimestamp).toISOString() : null,
            updatedTimestamp,
            url: `${baseUrl}/workspace/${workspaceId}/${page.id}`,
            rank,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      filtered.sort((a, b) => {
        if (sortBy === "updatedAt") {
          const diff = a.updatedTimestamp - b.updatedTimestamp;
          if (diff !== 0) {
            return sortDirection === "asc" ? diff : -diff;
          }
        } else if (a.rank !== b.rank) {
          return a.rank - b.rank;
        } else if (a.updatedTimestamp !== b.updatedTimestamp) {
          return b.updatedTimestamp - a.updatedTimestamp;
        }
        return (a.title ?? "").localeCompare(b.title ?? "");
      });

      const totalCount = filtered.length;
      const matches = filtered
        .slice(0, limit)
        .map((entry) => ({
          docId: entry.docId,
          title: entry.title,
          tags: entry.tags,
          updatedAt: entry.updatedAt,
          url: entry.url,
        }));

      return text({
        query: parsed.query,
        tag: parsed.tag ?? null,
        matchMode,
        sortBy,
        sortDirection,
        totalCount,
        results: matches,
      });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "search_docs",
    {
      title: "Search Documents by Title",
      description: "Fast search for documents by title using workspace metadata. Much faster than exporting each doc. Returns docId, title, and direct URL for each match.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)."),
        query: z.string().describe("Search query — matched case-insensitively against doc titles."),
        limit: z.number().optional().describe("Max results to return (default: 20)."),
        matchMode: z.enum(["substring", "prefix", "exact"]).optional().describe("How to match titles (default: substring)."),
        tag: z.string().optional().describe("Optional tag filter (case-insensitive substring match against resolved tag names)."),
        sortBy: z.enum(["relevance", "updatedAt"]).optional().describe("Sort by match relevance (default) or by updatedAt."),
        sortDirection: z.enum(["asc", "desc"]).optional().describe("Sort direction for updatedAt sorting (default: desc)."),
      },
    },
    searchDocsHandler as any
  );

  server.registerTool(
    "list_tags",
    {
      title: "List Tags",
      description: "List all tags in a workspace and the number of docs attached to each tag.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
      },
    },
    listTagsHandler as any
  );

  const listDocsByTagHandler = async (parsed: { workspaceId?: string; tag: string; ignoreCase?: boolean }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }
    const tag = normalizeTag(parsed.tag);
    const ignoreCase = parsed.ignoreCase ?? true;

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!snapshot.missing) {
        return text({ workspaceId, tag, ignoreCase, totalDocs: 0, docs: [] });
      }

      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
      const meta = wsDoc.getMap("meta");
      const pages = getWorkspacePageEntries(meta);
      const { byId } = getWorkspaceTagOptionMaps(meta);
      const docs = pages
        .map((page) => {
          const rawTags = getStringArray(page.tagsArray);
          const tags = resolveTagLabels(rawTags, byId);
          return {
            id: page.id,
            title: page.title,
            createDate: page.createDate,
            updatedDate: page.updatedDate,
            tags,
            rawTags,
          };
        })
        .filter((page) => hasTag(page.tags, tag, ignoreCase) || hasTag(page.rawTags, tag, ignoreCase))
        .map(({ rawTags: _rawTags, ...page }) => page);

      return text({
        workspaceId,
        tag,
        ignoreCase,
        totalDocs: docs.length,
        docs,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "list_docs_by_tag",
    {
      title: "List Documents By Tag",
      description: "List documents that contain the requested tag.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        tag: z.string().min(1).describe("Tag name"),
        ignoreCase: z.boolean().optional().describe("Case-insensitive tag matching (default: true)."),
      },
    },
    listDocsByTagHandler as any
  );

  const createTagHandler = async (parsed: { workspaceId?: string; tag: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }
    const tag = normalizeTag(parsed.tag);

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!snapshot.missing) {
        throw new Error(`Workspace root document not found for workspace ${workspaceId}`);
      }

      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(wsDoc);
      const meta = wsDoc.getMap("meta");
      const { created } = ensureWorkspaceTagOption(meta, tag);
      if (!created) {
        return text({ workspaceId, tag, created: false });
      }

      const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(delta).toString("base64"));
      return text({ workspaceId, tag, created: true });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "create_tag",
    {
      title: "Create Tag",
      description: "Create a workspace-level tag entry for future reuse.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        tag: z.string().min(1).describe("Tag name"),
      },
    },
    createTagHandler as any
  );

  const addTagToDocHandler = async (parsed: { workspaceId?: string; docId: string; tag: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }
    const tag = normalizeTag(parsed.tag);

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const wsSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!wsSnapshot.missing) {
        throw new Error(`Workspace root document not found for workspace ${workspaceId}`);
      }

      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(wsSnapshot.missing, "base64"));
      const wsPrevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap("meta");
      const page = getWorkspacePageEntries(wsMeta).find((entry) => entry.id === parsed.docId);
      if (!page) {
        throw new Error(`docId ${parsed.docId} is not present in workspace ${workspaceId}`);
      }

      const { option, created: optionCreated } = ensureWorkspaceTagOption(wsMeta, tag);
      const pageTags = ensureTagArray(page.entry);
      const pageSync = syncTagArrayToOption(pageTags, tag, option);
      const wsChanged = optionCreated || pageSync.changed;
      if (wsChanged) {
        const wsDelta = Y.encodeStateAsUpdate(wsDoc, wsPrevSV);
        await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString("base64"));
      }

      let docMetaSynced = false;
      let warning: string | null = null;
      const docSnapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!docSnapshot.missing) {
        warning = `Document ${parsed.docId} snapshot not found; workspace tag map was updated only.`;
      } else {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(docSnapshot.missing, "base64"));
        const docPrevSV = Y.encodeStateVector(doc);
        const docMeta = doc.getMap("meta");
        const docTags = ensureTagArray(docMeta);
        const docSync = syncTagArrayToOption(docTags, tag, option);
        if (docSync.changed) {
          const docDelta = Y.encodeStateAsUpdate(doc, docPrevSV);
          await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(docDelta).toString("base64"));
        }
        docMetaSynced = true;
      }

      const { byId } = getWorkspaceTagOptionMaps(wsMeta);

      return text({
        workspaceId,
        docId: parsed.docId,
        tag,
        added: !pageSync.existed,
        tags: resolveTagLabels(getStringArray(pageTags), byId),
        docMetaSynced,
        warning,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "add_tag_to_doc",
    {
      title: "Add Tag To Document",
      description: "Add a tag to a document.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        tag: z.string().min(1).describe("Tag name"),
      },
    },
    addTagToDocHandler as any
  );

  const removeTagFromDocHandler = async (parsed: { workspaceId?: string; docId: string; tag: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }
    const tag = normalizeTag(parsed.tag);

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const wsSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!wsSnapshot.missing) {
        throw new Error(`Workspace root document not found for workspace ${workspaceId}`);
      }

      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(wsSnapshot.missing, "base64"));
      const wsPrevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap("meta");
      const page = getWorkspacePageEntries(wsMeta).find((entry) => entry.id === parsed.docId);
      if (!page) {
        throw new Error(`docId ${parsed.docId} is not present in workspace ${workspaceId}`);
      }

      const option = getWorkspaceTagOptionMaps(wsMeta).byValueLower.get(tag.toLocaleLowerCase()) || null;
      const pageTags = ensureTagArray(page.entry);
      const pageTagIndexes = collectMatchingTagIndexes(pageTags, tag, option, true);
      const pageRemoved = deleteArrayIndexes(pageTags, pageTagIndexes);
      if (pageRemoved) {
        const wsDelta = Y.encodeStateAsUpdate(wsDoc, wsPrevSV);
        await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString("base64"));
      }

      let docMetaSynced = false;
      let warning: string | null = null;
      const docSnapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!docSnapshot.missing) {
        warning = `Document ${parsed.docId} snapshot not found; workspace tag map was updated only.`;
      } else {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(docSnapshot.missing, "base64"));
        const docPrevSV = Y.encodeStateVector(doc);
        const docMeta = doc.getMap("meta");
        const docTags = ensureTagArray(docMeta);
        const docTagIndexes = collectMatchingTagIndexes(docTags, tag, option, true);
        if (deleteArrayIndexes(docTags, docTagIndexes)) {
          const docDelta = Y.encodeStateAsUpdate(doc, docPrevSV);
          await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(docDelta).toString("base64"));
        }
        docMetaSynced = true;
      }

      const { byId } = getWorkspaceTagOptionMaps(wsMeta);

      return text({
        workspaceId,
        docId: parsed.docId,
        tag,
        removed: pageRemoved,
        tags: resolveTagLabels(getStringArray(pageTags), byId),
        docMetaSynced,
        warning,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "remove_tag_from_doc",
    {
      title: "Remove Tag From Document",
      description: "Remove a tag from a document.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        tag: z.string().min(1).describe("Tag name"),
      },
    },
    removeTagFromDocHandler as any
  );

  const getDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const query = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id workspaceId title summary public defaultRole createdAt updatedAt } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId });
      return text(data.workspace.doc);
    };
  server.registerTool(
    "get_doc",
    {
      title: "Get Document",
      description: "Get a document by ID (GraphQL metadata).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: DocId
      }
    },
    getDocHandler as any
  );

  const readDocHandler = async (parsed: { workspaceId?: string; docId: string; includeMarkdown?: boolean }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      let tagOptionsById = new Map<string, WorkspaceTagOption>();
      const workspaceSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (workspaceSnapshot.missing) {
        const workspaceDoc = new Y.Doc();
        Y.applyUpdate(workspaceDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
        tagOptionsById = getWorkspaceTagOptionMaps(workspaceDoc.getMap("meta")).byId;
      }

      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);

      if (!snapshot.missing) {
        return text({
          docId: parsed.docId,
          title: null,
          tags: [],
          exists: false,
          blockCount: 0,
          blocks: [],
          plainText: "",
        });
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const meta = doc.getMap("meta");
      const tags = resolveTagLabels(getStringArray(getTagArray(meta)), tagOptionsById);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const pageId = findBlockIdByFlavour(blocks, "affine:page");
      const noteId = findBlockIdByFlavour(blocks, "affine:note");
      const visited = new Set<string>();
      const blockRows: Array<{
        id: string;
        parentId: string | null;
        flavour: string | null;
        type: string | null;
        text: string | null;
        checked: boolean | null;
        language: string | null;
        childIds: string[];
      }> = [];
      const plainTextLines: string[] = [];
      let title = "";

      const visit = (blockId: string) => {
        if (visited.has(blockId)) return;
        visited.add(blockId);

        const raw = blocks.get(blockId);
        if (!(raw instanceof Y.Map)) return;

        const flavour = raw.get("sys:flavour");
        const parentId = raw.get("sys:parent");
        const type = raw.get("prop:type");
        const textValue = asText(raw.get("prop:text"));
        const language = raw.get("prop:language");
        const checked = raw.get("prop:checked");
        const childIds = childIdsFrom(raw.get("sys:children"));

        if (flavour === "affine:page") {
          title = asText(raw.get("prop:title")) || title;
        }
        if (textValue.length > 0) {
          plainTextLines.push(textValue);
        }

        blockRows.push({
          id: blockId,
          parentId: typeof parentId === "string" ? parentId : null,
          flavour: typeof flavour === "string" ? flavour : null,
          type: typeof type === "string" ? type : null,
          text: textValue.length > 0 ? textValue : null,
          checked: typeof checked === "boolean" ? checked : null,
          language: typeof language === "string" ? language : null,
          childIds,
        });

        for (const childId of childIds) {
          visit(childId);
        }
      };

      if (pageId) {
        visit(pageId);
      } else if (noteId) {
        visit(noteId);
      }
      for (const [id] of blocks) {
        const blockId = String(id);
        if (!visited.has(blockId)) {
          visit(blockId);
        }
      }

      // If includeMarkdown is requested, reuse the same render path as export_doc_markdown
      let markdown: string | undefined;
      if (parsed.includeMarkdown) {
        const collected = collectDocForMarkdown(doc, new Map());
        const rendered = renderBlocksToMarkdown({
          rootBlockIds: collected.rootBlockIds,
          blocksById: collected.blocksById,
        });
        markdown = rendered.markdown;
      }

      return text({
        docId: parsed.docId,
        title: title || null,
        tags,
        exists: true,
        blockCount: blockRows.length,
        blocks: blockRows,
        plainText: plainTextLines.join("\n"),
        ...(markdown !== undefined ? { markdown } : {}),
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "read_doc",
    {
      title: "Read Document Content",
      description: "Read document block content via WebSocket snapshot (blocks + plain text). Set includeMarkdown: true to also get the rendered markdown — useful when you need to read content without a separate export_doc_markdown call.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        includeMarkdown: z.boolean().optional().describe("If true, includes rendered markdown in the response. Equivalent to also calling export_doc_markdown."),
      },
    },
    readDocHandler as any
  );

  const getCapabilitiesHandler = async () => {
    return text({
      server: {
        name: "affine-mcp",
        capabilityVersion: 1,
      },
      docs: {
        canonicalBlockTypes: [...APPEND_BLOCK_CANONICAL_TYPE_VALUES],
        legacyBlockAliases: Object.keys(APPEND_BLOCK_LEGACY_ALIAS_MAP),
        markdownImport: {
          supported: true,
          lossy: true,
          knownLosses: [
            "Nested markdown lists are flattened during import.",
            "Markdown images are converted into bookmark blocks unless blobs are uploaded separately.",
            "HTML blocks are imported as plain paragraph text.",
          ],
        },
        markdownExport: {
          supportedFlavours: [...MARKDOWN_EXPORT_SUPPORTED_FLAVOURS].sort(),
          lossyForUnsupportedFlavours: true,
          knownUnsupportedFlavours: [...KNOWN_BLOCK_FLAVOURS].filter(
            flavour => !MARKDOWN_EXPORT_SUPPORTED_FLAVOURS.has(flavour)
          ).sort(),
        },
        highLevelAuthoring: {
          semanticPageComposer: false,
          nativeTemplateInstantiation: false,
          createDocWithPlacement: false,
          semanticSectionEditing: false,
        },
      },
      database: {
        supported: true,
        columnTypes: [...DATABASE_COLUMN_TYPE_VALUES],
        initialViewModes: [...APPEND_BLOCK_DATA_VIEW_MODE_VALUES],
        advancedViewMutation: false,
        intentDrivenComposition: false,
        linkedDocRows: true,
      },
      workspace: {
        organizeToolsExperimental: true,
        ruleBackedCollections: false,
        workspaceBlueprints: false,
      },
      collaboration: {
        docComments: true,
        repliesListed: true,
        replyCreation: false,
        anchoredComments: false,
        selectionRangeComments: false,
        sharePolicyManagement: false,
      },
      export: {
        markdown: true,
        html: false,
        fidelityReport: true,
        snapshotBundle: false,
      },
    });
  };
  server.registerTool(
    "get_capabilities",
    {
      title: "Get Capabilities",
      description: "Return machine-readable capability flags for this MCP server, including block, database, collaboration, and export support.",
      inputSchema: {},
    },
    getCapabilitiesHandler as any
  );

  const analyzeDocFidelityHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      let tagOptionsById = new Map<string, WorkspaceTagOption>();
      const workspaceSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (workspaceSnapshot.missing) {
        const workspaceDoc = new Y.Doc();
        Y.applyUpdate(workspaceDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
        tagOptionsById = getWorkspaceTagOptionMaps(workspaceDoc.getMap("meta")).byId;
      }

      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) {
        return text({
          docId: parsed.docId,
          exists: false,
          unsupportedBlocks: [],
          conditionallyRiskyBlocks: [],
        });
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const summary = summarizeDocFidelity(doc, tagOptionsById);

      return text({
        docId: parsed.docId,
        exists: true,
        ...summary,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "analyze_doc_fidelity",
    {
      title: "Analyze Document Fidelity",
      description: "Inspect a document for markdown export fidelity risk, including unsupported AFFiNE block flavours and risky content paths.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
      },
    },
    analyzeDocFidelityHandler as any
  );

  // move_doc: move a doc in the sidebar by removing its embed_linked_doc from the old parent
  // and adding it to the new parent. fromParentDocId is optional — if omitted, only adds to new parent.
  const moveDocHandler = async (parsed: { workspaceId?: string; docId: string; toParentDocId: string; fromParentDocId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

    try {
      await joinWorkspace(socket, workspaceId);

      let removedFromParent = false;

      // Step 1: remove embed_linked_doc from old parent (if provided)
      if (parsed.fromParentDocId) {
        const parentDoc = new Y.Doc();
        const parentSnapshot = await loadDoc(socket, workspaceId, parsed.fromParentDocId);
        if (parentSnapshot.missing) {
          Y.applyUpdate(parentDoc, Buffer.from(parentSnapshot.missing, "base64"));
          const prevSV = Y.encodeStateVector(parentDoc);
          const blocks = parentDoc.getMap("blocks") as Y.Map<any>;

          // Find the embed_linked_doc block pointing to our docId
          let embedBlockId: string | null = null;
          let embedParentChildren: Y.Array<any> | null = null;
          let embedIndex = -1;

          for (const [id, raw] of blocks) {
            if (!(raw instanceof Y.Map)) continue;
            const flavour = raw.get("sys:flavour");
            const pageId = raw.get("prop:pageId");
            if (flavour === "affine:embed-linked-doc" && pageId === parsed.docId) {
              embedBlockId = String(id);
              break;
            }
          }

          if (embedBlockId) {
            // Find the parent block whose sys:children contains embedBlockId
            for (const [, raw] of blocks) {
              if (!(raw instanceof Y.Map)) continue;
              const children = raw.get("sys:children");
              if (!(children instanceof Y.Array)) continue;
              const arr = children.toArray() as string[];
              const idx = arr.indexOf(embedBlockId);
              if (idx >= 0) {
                embedParentChildren = children;
                embedIndex = idx;
                break;
              }
            }
            if (embedParentChildren && embedIndex >= 0) {
              embedParentChildren.delete(embedIndex, 1);
            }
            blocks.delete(embedBlockId);
            const delta = Y.encodeStateAsUpdate(parentDoc, prevSV);
            await pushDocUpdate(socket, workspaceId, parsed.fromParentDocId, Buffer.from(delta).toString("base64"));
            removedFromParent = true;
          }
        }
      }

      // Step 2: add embed_linked_doc to new parent
      await appendBlockInternal({
        workspaceId,
        docId: parsed.toParentDocId,
        type: "embed_linked_doc",
        pageId: parsed.docId,
      });

      return receipt("doc.move", {
        workspaceId,
        moved: true,
        docId: parsed.docId,
        toParentDocId: parsed.toParentDocId,
        removedFromParent,
      });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "move_doc",
    {
      title: "Move Document in Sidebar",
      description: "Move a doc in the AFFiNE sidebar by embedding it under a new parent. Optionally removes it from the old parent (fromParentDocId). If fromParentDocId is omitted, the doc is added to the new parent but not removed from the old one.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().describe("The doc to move."),
        toParentDocId: z.string().describe("The new parent doc that will contain the embed."),
        fromParentDocId: z.string().optional().describe("The current parent doc to remove the embed from. If omitted, only adds to new parent."),
      },
    },
    moveDocHandler as any
  );

  const publishDocHandler = async (parsed: { workspaceId?: string; docId: string; mode?: "Page" | "Edgeless" }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const mutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
      const data = await gql.request<{ publishDoc: any }>(mutation, { workspaceId, docId: parsed.docId, mode: parsed.mode });
      return receipt("doc.publish", {
        workspaceId,
        docId: parsed.docId,
        ...data.publishDoc,
      });
    };
  server.registerTool(
    "publish_doc",
    {
      title: "Publish Document",
      description: "Publish a doc (make public).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        mode: z.enum(["Page","Edgeless"]).optional()
      }
    },
    publishDocHandler as any
  );

  const revokeDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const mutation = `mutation RevokeDoc($workspaceId:String!,$docId:String!){ revokePublicDoc(workspaceId:$workspaceId, docId:$docId){ id workspaceId public } }`;
      const data = await gql.request<{ revokePublicDoc: any }>(mutation, { workspaceId, docId: parsed.docId });
      return receipt("doc.revoke_public", {
        workspaceId,
        docId: parsed.docId,
        ...data.revokePublicDoc,
      });
    };
  server.registerTool(
    "revoke_doc",
    {
      title: "Revoke Document",
      description: "Revoke a doc's public access.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string()
      }
    },
    revokeDocHandler as any
  );

  // CREATE DOC (high-level)
  const createDocHandler = async (parsed: { workspaceId?: string; title?: string; content?: string; parentDocId?: string }) => {
    const created = await createDocInternal(parsed);
    const placement = await finalizeDocPlacement({
      workspaceId: created.workspaceId,
      docId: created.docId,
      parentDocId: parsed.parentDocId,
      context: "create_doc",
    });
    return receipt("doc.create", {
      workspaceId: created.workspaceId,
      docId: created.docId,
      title: created.title,
      parentDocId: placement.parentDocId,
      linkedToParent: placement.linkedToParent,
      warnings: mergeWarnings(created.warnings ?? [], placement.warnings),
    });
  };
  server.registerTool(
    'create_doc',
    {
      title: 'Create Document',
      description: 'Create a new AFFiNE document with optional content. If parentDocId is provided, the new doc is linked into the sidebar tree immediately.',
      inputSchema: {
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        parentDocId: z.string().optional().describe("Optional parent doc to link the new doc under in the sidebar."),
      },
    },
    createDocHandler as any
  );

  const semanticSectionSchema = z.object({
    title: z.string().min(1).describe("Semantic section title."),
    paragraphs: z.array(z.string().min(1)).optional().describe("Paragraphs to append under the section heading."),
    bullets: z.array(z.string().min(1)).optional().describe("Bulleted items to append under the section heading."),
    callouts: z.array(z.string().min(1)).optional().describe("Callout blocks to append under the section heading."),
  });

  const createSemanticPageHandler = async (parsed: {
    workspaceId?: string;
    title?: string;
    pageType?: SemanticPageType;
    parentDocId?: string;
    sections?: SemanticSectionInput[];
  }) => {
    const created = await createSemanticPageInternal(parsed);
    return text({
      workspaceId: created.workspaceId,
      docId: created.docId,
      title: created.title,
      pageType: created.pageType,
      pageId: created.pageId,
      noteId: created.noteId,
      sectionCount: created.sectionHeadingIds.length,
      sectionHeadingIds: created.sectionHeadingIds,
      blockIds: created.blockIds,
      parentLinked: created.parentLinked,
      warnings: created.warnings,
    });
  };
  server.registerTool(
    "create_semantic_page",
    {
      title: "Create Semantic Page",
      description: "Create an AFFiNE-native page with intentional section structure and native block composition.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        title: z.string().optional().describe("Page title."),
        pageType: z.enum(["meeting_notes", "project_hub", "spec_page", "wiki_page"]).optional().describe("Semantic page template to seed default sections."),
        parentDocId: z.string().optional().describe("Optional parent doc to link the new page under in the sidebar."),
        sections: z.array(semanticSectionSchema).optional().describe("Optional explicit section structure. If omitted, the page type defaults are used."),
      },
    },
    createSemanticPageHandler as any
  );

  const appendSemanticSectionHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    sectionTitle: string;
    afterSectionTitle?: string;
    paragraphs?: string[];
    bullets?: string[];
    callouts?: string[];
  }) => {
    const result = await appendSemanticSectionInternal(parsed);
    return text({
      workspaceId: result.workspaceId,
      docId: result.docId,
      noteId: result.noteId,
      sectionTitle: result.sectionTitle,
      sectionHeadingId: result.sectionHeadingId,
      afterSectionTitle: result.afterSectionTitle,
      blockIds: result.blockIds,
      appendedCount: result.blockIds.length,
    });
  };
  server.registerTool(
    "append_semantic_section",
    {
      title: "Append Semantic Section",
      description: "Append a semantic section to an existing AFFiNE document by heading title and native block composition.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        sectionTitle: z.string().min(1).describe("Heading text for the new semantic section."),
        afterSectionTitle: z.string().optional().describe("Optional existing section heading to append after."),
        paragraphs: z.array(z.string().min(1)).optional().describe("Paragraphs to append under the new section."),
        bullets: z.array(z.string().min(1)).optional().describe("Bulleted items to append under the new section."),
        callouts: z.array(z.string().min(1)).optional().describe("Callout blocks to append under the new section."),
      },
    },
    appendSemanticSectionHandler as any
  );

  // APPEND PARAGRAPH
  const appendParagraphHandler = async (parsed: { workspaceId?: string; docId: string; text: string }) => {
    const result = await appendBlockInternal({
      workspaceId: parsed.workspaceId,
      docId: parsed.docId,
      type: "paragraph",
      text: parsed.text,
    });
    return receipt("doc.append_paragraph", {
      workspaceId: parsed.workspaceId || defaults.workspaceId || null,
      docId: parsed.docId,
      appended: result.appended,
      blockId: result.blockId,
      paragraphId: result.blockId,
      blockType: result.blockType || null,
      normalizedType: result.normalizedType,
      legacyType: result.legacyType,
    });
  };
  server.registerTool(
    'append_paragraph',
    {
      title: 'Append Paragraph',
      description: 'Append a text paragraph block to a document',
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        text: z.string(),
      },
    },
    appendParagraphHandler as any
  );

  const appendBlockHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    type: string;
    text?: string;
    url?: string;
    pageId?: string;
    iframeUrl?: string;
    html?: string;
    design?: string;
    reference?: string;
    refFlavour?: string;
    width?: number;
    height?: number;
    background?: string;
    sourceId?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    embed?: boolean;
    rows?: number;
    columns?: number;
    latex?: string;
    checked?: boolean;
    language?: string;
    caption?: string;
    level?: number;
    style?: AppendBlockListStyle;
    bookmarkStyle?: AppendBlockBookmarkStyle;
    viewMode?: AppendBlockDataViewMode;
    strict?: boolean;
    placement?: AppendPlacement;
    markdown?: string;
    childElementIds?: string[];
    stackAfter?: { blockId: string | string[]; direction?: "down" | "up" | "right" | "left"; gap?: number };
    padding?: number;
  }) => {
    // Drop `text` when `markdown` is set so markdown-parsed children don't
    // sit next to a stale one-paragraph echo.
    const shouldApplyMarkdown = parsed.type === "note" && !!parsed.markdown;
    const coreParsed = shouldApplyMarkdown ? { ...parsed, text: undefined } : parsed;
    const result = await appendBlockInternal(coreParsed);

    let markdownApplied: {
      appendedCount: number;
      skippedCount: number;
      blockIds: string[];
      warnings: string[];
    } | undefined;
    if (shouldApplyMarkdown && result.appended && result.blockId) {
      const parsedMd = parseMarkdownToOperations(parsed.markdown!);
      if (parsedMd.operations.length > 0) {
        const applied = await applyMarkdownOperationsInternal({
          workspaceId: parsed.workspaceId || defaults.workspaceId!,
          docId: parsed.docId,
          operations: parsedMd.operations,
          strict: parsed.strict,
          placement: { parentId: result.blockId },
        });
        markdownApplied = {
          appendedCount: applied.appendedCount,
          skippedCount: applied.skippedCount,
          blockIds: applied.blockIds,
          warnings: parsedMd.warnings,
        };
      }
    }

    return receipt("doc.append_block", {
      workspaceId: parsed.workspaceId || defaults.workspaceId || null,
      docId: parsed.docId,
      appended: result.appended,
      blockId: result.blockId,
      flavour: result.flavour,
      type: result.blockType || null,
      blockType: result.blockType || null,
      normalizedType: result.normalizedType,
      legacyType: result.legacyType,
      ...(result.ownedIds ? { ownedIds: result.ownedIds } : {}),
      ...(result.missing ? { missing: result.missing } : {}),
      ...(markdownApplied ? { markdown: markdownApplied } : {}),
    });
  };
  server.registerTool(
    "append_block",
    {
      title: "Append Block",
      description: "Append document blocks with canonical types and legacy aliases (supports placement + strict validation).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        type: z.string().min(1).describe("Block type. Canonical: paragraph|heading|quote|list|code|divider|callout|latex|table|bookmark|image|attachment|embed_youtube|embed_github|embed_figma|embed_loom|embed_html|embed_linked_doc|embed_synced_doc|embed_iframe|database|data_view|surface_ref|frame|edgeless_text|note. Legacy aliases remain supported."),
        text: z.string().optional().describe("Block content text"),
        url: z.string().optional().describe("URL for bookmark/embeds"),
        pageId: z.string().optional().describe("Target page/doc id for linked/synced doc embeds"),
        iframeUrl: z.string().optional().describe("Override iframe src for embed_iframe"),
        html: z.string().optional().describe("Raw html for embed_html"),
        design: z.string().optional().describe("Design payload for embed_html"),
        reference: z.string().optional().describe("Target id for surface_ref"),
        refFlavour: z.string().optional().describe("Target flavour for surface_ref (e.g. affine:frame)"),
        x: z.number().int().optional().describe("X position on the edgeless canvas for frame/edgeless_text/note (default 0). Prefer ≥40px between sibling bounds; BlockSuite does not auto-arrange."),
        y: z.number().int().optional().describe("Y position on the edgeless canvas for frame/edgeless_text/note (default 0)."),
        width: z.number().int().min(1).max(10000).optional().describe("Width for frame/edgeless_text/note."),
        height: z.number().int().min(1).max(10000).optional().describe("Height for frame/edgeless_text/note. When `markdown` is set and height is omitted, an over-estimate is computed from the content — AFFiNE's render-time ResizeObserver corrects `prop:xywh` to the true DOM-measured height on first browser open."),
        background: z.any().optional().describe("Background for frame/note. Frame default 'transparent'. For notes, prefer AFFiNE's adaptive `--affine-note-background-<color>` family — `blue` / `purple` / `yellow` / `green` / `teal` / `red` / `orange` / `magenta` / `grey` / `white` / `black`. For specific per-theme colors, pass a `{light, dark}` hex object like `{light:'#fff', dark:'#252525'}`."),
        markdown: z.string().optional().describe("When type='note', parse this markdown into heading/paragraph/list/code child blocks inside the note (BlockSuite-native: mirrors what happens when you paste markdown into an edgeless note). Takes precedence over 'text' for note children. Ignored for other block types."),
        childElementIds: z.array(z.string()).optional().describe("For type='frame' only. The frame's contents. Accepts ids of surface elements (shapes/connectors/groups) AND edgeless blocks (notes/frames/edgeless-text) — BlockSuite's prop:childElementIds holds both, matching what the editor writes when you drag a note into a frame. Dragging the frame drags every owned member. Ids that don't resolve come back under 'missing'. When width/height are omitted the frame is sized to the union of resolvable child bounds + padding + a 30px title band."),
        stackAfter: z.object({
          blockId: z.union([z.string(), z.array(z.string())]).describe("Block(s) to stack relative to. String = a single anchor; array = pick whichever is furthest in the stack direction (bottommost for 'down', rightmost for 'right', etc.)."),
          direction: z.enum(["down", "up", "right", "left"]).optional().describe("Direction (default 'down')"),
          gap: z.number().int().optional().describe("Gap in px between the anchor and the new block. Default is direction-aware: 80 for left/right, 40 for down/up — mirrors native-flowchart spacing where the flow axis gets more breathing room than the cross axis. Explicit `padding` on the block overrides this default; explicit `gap` wins over both."),
        }).optional().describe("Layout helper — position this block relative to one or more existing edgeless blocks. Picks the furthest anchor in `direction` for the stack axis, and centers the new block on the anchor group's union on the orthogonal axis (matches how BlockSuite aligns selection-derived blocks; reduces to inherit-anchor-x when widths match). Caller-provided x/y on the orthogonal axis still wins. Works for frame/note/edgeless_text. Example: `stackAfter: { blockId: [f1, f2, f3], gap: 80 }` stacks below whichever column frame ends lowest, centered across all three. Note heights shift at first render (page-root grows with the title, content notes shrink/grow with their children); give extra gap and fix up with `update_edgeless_block` if the down/right chain drifts."),
        padding: z.number().int().optional().describe("Default padding (px) for `childElementIds` auto-sizing on frames (each side, plus +30px title band) and fallback gap for `stackAfter` (default 40)."),
        sourceId: z.string().optional().describe("Blob source id for image/attachment"),
        name: z.string().optional().describe("Attachment file name"),
        mimeType: z.string().optional().describe("Attachment mime type"),
        size: z.number().optional().describe("Attachment/image file size in bytes"),
        embed: z.boolean().optional().describe("Attachment embed mode"),
        rows: z.number().int().min(1).max(20).optional().describe("Table row count"),
        columns: z.number().int().min(1).max(20).optional().describe("Table column count"),
        latex: z.string().optional().describe("Latex expression"),
        level: z.number().int().min(1).max(6).optional().describe("Heading level for type=heading"),
        style: AppendBlockListStyle.optional().describe("List style for type=list"),
        bookmarkStyle: AppendBlockBookmarkStyle.optional().describe("Bookmark card style"),
        viewMode: AppendBlockDataViewMode.optional().describe("Initial data view preset for type=database or type=data_view. Defaults: database=table, data_view=kanban"),
        checked: z.boolean().optional().describe("Todo state when type is todo"),
        language: z.string().optional().describe("Code language when type is code"),
        caption: z.string().optional().describe("Code caption when type is code"),
        strict: z.boolean().optional().describe("Strict validation mode (default true)"),
        placement: z
          .object({
            parentId: z.string().optional(),
            afterBlockId: z.string().optional(),
            beforeBlockId: z.string().optional(),
            index: z.number().int().min(0).optional(),
          })
          .optional()
          .describe("Optional insertion target/position"),
      },
    },
    appendBlockHandler as any
  );

  const exportDocMarkdownHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    includeFrontmatter?: boolean;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

    try {
      await joinWorkspace(socket, workspaceId);
      let tagOptionsById = new Map<string, WorkspaceTagOption>();
      const workspaceSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (workspaceSnapshot.missing) {
        const wsDoc = new Y.Doc();
        Y.applyUpdate(wsDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
        tagOptionsById = getWorkspaceTagOptionMaps(wsDoc.getMap("meta")).byId;
      }

      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) {
        return text({
          docId: parsed.docId,
          title: null,
          tags: [],
          exists: false,
          markdown: "",
          warnings: [`Document ${parsed.docId} was not found in workspace ${workspaceId}.`],
          lossy: false,
          stats: {
            blockCount: 0,
            unsupportedCount: 0,
          },
        });
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const collected = collectDocForMarkdown(doc, tagOptionsById);
      const rendered = renderBlocksToMarkdown({
        rootBlockIds: collected.rootBlockIds,
        blocksById: collected.blocksById,
      });

      let markdown = rendered.markdown;
      if (parsed.includeFrontmatter) {
        const escapedTitle = (collected.title || "Untitled").replace(/\"/g, "\\\"");
        const frontmatterLines = [
          "---",
          `docId: \"${parsed.docId}\"`,
          `title: \"${escapedTitle}\"`,
          "tags:",
          ...(collected.tags.length > 0 ? collected.tags.map(tag => `  - \"${tag.replace(/\"/g, "\\\"")}\"`) : ["  -"]),
          `lossy: ${rendered.lossy ? "true" : "false"}`,
          "---",
        ];
        markdown = `${frontmatterLines.join("\n")}\n\n${markdown}`;
      }

      return text({
        docId: parsed.docId,
        title: collected.title || null,
        tags: collected.tags,
        exists: true,
        markdown,
        warnings: rendered.warnings,
        lossy: rendered.lossy,
        stats: rendered.stats,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "export_doc_markdown",
    {
      title: "Export Document Markdown",
      description: "Export AFFiNE document content to markdown.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        includeFrontmatter: z.boolean().optional(),
      },
    },
    exportDocMarkdownHandler as any
  );

  const exportWithFidelityReportHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    includeFrontmatter?: boolean;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

    try {
      await joinWorkspace(socket, workspaceId);
      let tagOptionsById = new Map<string, WorkspaceTagOption>();
      const workspaceSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (workspaceSnapshot.missing) {
        const wsDoc = new Y.Doc();
        Y.applyUpdate(wsDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
        tagOptionsById = getWorkspaceTagOptionMaps(wsDoc.getMap("meta")).byId;
      }

      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) {
        return text({
          docId: parsed.docId,
          exists: false,
          markdown: "",
          fidelity: {
            overallRisk: "high",
            recommendedPath: "prefer_native_read_or_clone",
            unsupportedBlocks: [],
            conditionallyRiskyBlocks: [],
          },
        });
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const summary = summarizeDocFidelity(doc, tagOptionsById);
      let markdown = summary.markdown;

      if (parsed.includeFrontmatter) {
        const escapedTitle = (summary.title || "Untitled").replace(/\"/g, "\\\"");
        const frontmatterLines = [
          "---",
          `docId: \"${parsed.docId}\"`,
          `title: \"${escapedTitle}\"`,
          "tags:",
          ...(summary.tags.length > 0 ? summary.tags.map(tag => `  - \"${tag.replace(/\"/g, "\\\"")}\"`) : ["  -"]),
          `lossy: ${summary.markdownLossy ? "true" : "false"}`,
          `fidelityRisk: \"${summary.overallRisk}\"`,
          "---",
        ];
        markdown = `${frontmatterLines.join("\n")}\n\n${markdown}`;
      }

      return text({
        docId: parsed.docId,
        exists: true,
        markdown,
        fidelity: {
          overallRisk: summary.overallRisk,
          recommendedPath: summary.recommendedPath,
          unsupportedBlocks: summary.unsupportedBlocks,
          conditionallyRiskyBlocks: summary.conditionallyRiskyBlocks,
          markdownWarnings: summary.markdownWarnings,
          markdownLossy: summary.markdownLossy,
          flavourCounts: summary.flavourCounts,
          stats: summary.stats,
        },
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "export_with_fidelity_report",
    {
      title: "Export With Fidelity Report",
      description: "Export document markdown together with a structured fidelity report that highlights markdown loss risk and unsupported AFFiNE-native content.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        includeFrontmatter: z.boolean().optional(),
      },
    },
    exportWithFidelityReportHandler as any
  );

  // Core logic for creating a doc from markdown — returns structured data, no MCP envelope.
  // Used by both createDocFromMarkdownHandler and batchCreateDocsHandler.
  const createDocFromMarkdownCore = async (parsed: {
    workspaceId?: string;
    title?: string;
    markdown: string;
    strict?: boolean;
    parentDocId?: string;
  }) => {
    const parsedMarkdown = parseMarkdownToOperations(parsed.markdown);
    let operations = [...parsedMarkdown.operations];
    let title = (parsed.title ?? "").trim();
    if (!title && operations.length > 0) {
      const first = operations[0];
      if (first.type === "heading" && first.level === 1) {
        title = first.text.trim() || "Untitled";
        operations = operations.slice(1);
      }
    }
    if (!title) {
      title = "Untitled";
    }

    const created = await createDocInternal({
      workspaceId: parsed.workspaceId,
      title,
    });

    let applied = {
      appendedCount: 0,
      skippedCount: 0,
      blockIds: [] as string[],
    };

    if (operations.length > 0) {
      applied = await applyMarkdownOperationsInternal({
        workspaceId: created.workspaceId,
        docId: created.docId,
        operations,
        strict: parsed.strict,
      });
    }

    const placement = await finalizeDocPlacement({
      workspaceId: created.workspaceId,
      docId: created.docId,
      parentDocId: parsed.parentDocId,
      context: "create_doc_from_markdown",
    });

    const applyWarnings: string[] = [];
    if (applied.skippedCount > 0) {
      applyWarnings.push(`${applied.skippedCount} markdown block(s) could not be applied to AFFiNE and were skipped.`);
    }

    return {
      workspaceId: created.workspaceId,
      docId: created.docId,
      title: created.title,
      parentDocId: placement.parentDocId,
      linkedToParent: placement.linkedToParent,
      warnings: mergeWarnings(parsedMarkdown.warnings, applyWarnings, placement.warnings),
      lossy: parsedMarkdown.lossy || applied.skippedCount > 0,
      stats: {
        parsedBlocks: parsedMarkdown.operations.length,
        appliedBlocks: applied.appendedCount,
        skippedBlocks: applied.skippedCount,
      },
    };
  };

  const createDocFromMarkdownHandler = async (parsed: {
    workspaceId?: string;
    title?: string;
    markdown: string;
    strict?: boolean;
    parentDocId?: string;
  }) => {
    return receipt("doc.create_from_markdown", await createDocFromMarkdownCore(parsed));
  };
  server.registerTool(
    "create_doc_from_markdown",
    {
      title: "Create Document From Markdown",
      description: "Create a new AFFiNE document and import markdown content. Use parentDocId to automatically embed the new doc into a parent, making it visible in the sidebar instead of being an orphan.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        title: z.string().optional(),
        markdown: MarkdownContent.describe("Markdown content to import"),
        strict: z.boolean().optional(),
        parentDocId: z.string().optional().describe("If provided, the new doc is automatically embedded into this parent doc as a linked child (visible in sidebar)."),
      },
    },
    createDocFromMarkdownHandler as any
  );

  // batch_create_docs: create up to 20 docs in one call
  const batchCreateDocsHandler = async (parsed: {
    workspaceId?: string;
    docs: Array<{ title: string; markdown: string; parentDocId?: string }>;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    if (!Array.isArray(parsed.docs) || parsed.docs.length === 0) throw new Error("docs array is required.");
    if (parsed.docs.length > 20) throw new Error("Maximum 20 docs per batch.");

    const results: Array<{ title: string; docId: string; parentDocId: string | null; linkedToParent: boolean; warnings: string[] }> = [];

    for (const item of parsed.docs) {
      try {
        const d = await createDocFromMarkdownCore({ workspaceId, title: item.title, markdown: item.markdown, parentDocId: item.parentDocId });
        results.push({
          title: d.title,
          docId: d.docId,
          parentDocId: d.parentDocId,
          linkedToParent: d.linkedToParent,
          warnings: d.warnings ?? [],
        });
      } catch (err: any) {
        results.push({ title: item.title, docId: "", parentDocId: item.parentDocId ?? null, linkedToParent: false, warnings: [`Failed: ${err?.message ?? String(err)}`] });
      }
    }

    const failed = results.filter(r => !r.docId).length;
    return text({ created: results.length - failed, failed, results });
  };

  server.registerTool(
    "batch_create_docs",
    {
      title: "Batch Create Documents",
      description: "Create multiple AFFiNE documents in a single call. Each doc can optionally be linked to a parent (parentDocId) to appear in the sidebar. Max 20 docs per batch.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docs: z.array(z.object({
          title: z.string().describe("Document title."),
          markdown: z.string().describe("Markdown content."),
          parentDocId: z.string().optional().describe("Parent doc ID — if provided, the new doc is embedded under this parent in the sidebar."),
        })).min(1).max(20).describe("Array of docs to create (max 20)."),
      },
    },
    batchCreateDocsHandler as any
  );

  const appendMarkdownHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    markdown: string;
    strict?: boolean;
    placement?: AppendPlacement;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const parsedMarkdown = parseMarkdownToOperations(parsed.markdown);
    const applied = await applyMarkdownOperationsInternal({
      workspaceId,
      docId: parsed.docId,
      operations: parsedMarkdown.operations,
      strict: parsed.strict,
      placement: parsed.placement,
    });

    const applyWarnings =
      applied.skippedCount > 0
        ? [`${applied.skippedCount} markdown block(s) could not be applied to AFFiNE and were skipped.`]
        : [];

    return receipt("doc.append_markdown", {
      workspaceId,
      docId: parsed.docId,
      appended: applied.appendedCount > 0,
      appendedCount: applied.appendedCount,
      blockIds: applied.blockIds,
      warnings: mergeWarnings(parsedMarkdown.warnings, applyWarnings),
      lossy: parsedMarkdown.lossy || applied.skippedCount > 0,
      stats: {
        parsedBlocks: parsedMarkdown.operations.length,
        appliedBlocks: applied.appendedCount,
        skippedBlocks: applied.skippedCount,
      },
    });
  };
  server.registerTool(
    "append_markdown",
    {
      title: "Append Markdown",
      description: "Append markdown content to an existing AFFiNE document.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        markdown: MarkdownContent.describe("Markdown content to append"),
        strict: z.boolean().optional(),
        placement: z
          .object({
            parentId: z.string().optional(),
            afterBlockId: z.string().optional(),
            beforeBlockId: z.string().optional(),
            index: z.number().int().min(0).optional(),
          })
          .optional()
          .describe("Optional insertion target/position"),
      },
    },
    appendMarkdownHandler as any
  );

  const replaceDocWithMarkdownHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    markdown: string;
    strict?: boolean;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const parsedMarkdown = parseMarkdownToOperations(parsed.markdown);
    const applied = await applyMarkdownOperationsInternal({
      workspaceId,
      docId: parsed.docId,
      operations: parsedMarkdown.operations,
      strict: parsed.strict,
      replaceExisting: true,
    });

    const applyWarnings =
      applied.skippedCount > 0
        ? [`${applied.skippedCount} markdown block(s) could not be applied to AFFiNE and were skipped.`]
        : [];

    return receipt("doc.replace_with_markdown", {
      workspaceId,
      docId: parsed.docId,
      replaced: true,
      warnings: mergeWarnings(parsedMarkdown.warnings, applyWarnings),
      lossy: parsedMarkdown.lossy || applied.skippedCount > 0,
      stats: {
        parsedBlocks: parsedMarkdown.operations.length,
        appliedBlocks: applied.appendedCount,
        skippedBlocks: applied.skippedCount,
      },
    });
  };
  server.registerTool(
    "replace_doc_with_markdown",
    {
      title: "Replace Document With Markdown",
      description: "Replace the main note content of a document with markdown content.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        markdown: MarkdownContent.describe("Markdown content to replace with"),
        strict: z.boolean().optional(),
      },
    },
    replaceDocWithMarkdownHandler as any
  );

  // DELETE DOC
  const deleteDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error('workspaceId is required');
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      // remove from workspace pages
      const wsDoc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (snapshot.missing) Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, 'base64'));
      const prevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap('meta');
      const pages = wsMeta.get('pages') as Y.Array<Y.Map<any>> | undefined;
      if (pages) {
        // find by id
        let idx = -1;
        pages.forEach((m: any, i: number) => {
          if (idx >= 0) return;
          if (m.get && m.get('id') === parsed.docId) idx = i;
        });
        if (idx >= 0) pages.delete(idx, 1);
      }
      const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString('base64'));
      // delete doc content
      wsDeleteDoc(socket, workspaceId, parsed.docId);
      return receipt("doc.delete", {
        workspaceId,
        docId: parsed.docId,
        deleted: true,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    'delete_doc',
    {
      title: 'Delete Document',
      description: 'Delete a document and remove from workspace list',
      inputSchema: { workspaceId: z.string().optional(), docId: z.string() },
    },
    deleteDocHandler as any
  );

  // ─── cleanup_orphan_embeds ──────────────────────────────────────────────────
  const cleanupOrphanEmbedsHandler = async (parsed: { workspaceId?: string; docId: string; dryRun?: boolean }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snap = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snap.missing) throw new Error(`Doc ${parsed.docId} not found.`);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const orphans: Array<{ blockId: string; targetDocId: string }> = [];
      for (const [blockId, raw] of blocks) {
        if (!(raw instanceof Y.Map)) continue;
        if (raw.get("sys:flavour") !== "affine:embed-linked-doc") continue;
        const targetId = raw.get("prop:pageId");
        if (typeof targetId !== "string" || !targetId) { orphans.push({ blockId, targetDocId: targetId ?? "" }); continue; }
        const targetSnap = await loadDoc(socket, workspaceId, targetId);
        if (!targetSnap.missing) orphans.push({ blockId, targetDocId: targetId });
      }
      if (parsed.dryRun || orphans.length === 0) {
        return text({ docId: parsed.docId, dryRun: parsed.dryRun ?? false, orphansFound: orphans.length, orphans });
      }
      const prevSV = Y.encodeStateVector(doc);
      for (const { blockId } of orphans) {
        for (const [, parentRaw] of blocks) {
          if (!(parentRaw instanceof Y.Map)) continue;
          const children = parentRaw.get("sys:children");
          if (!(children instanceof Y.Array)) continue;
          const ids = childIdsFrom(children);
          const idx = ids.indexOf(blockId);
          if (idx !== -1) { children.delete(idx, 1); break; }
        }
        blocks.delete(blockId);
      }
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));
      return text({ docId: parsed.docId, dryRun: false, orphansRemoved: orphans.length, orphans });
    } finally { socket.disconnect(); }
  };
  server.registerTool("cleanup_orphan_embeds", {
    title: "Cleanup Orphan Embed Links",
    description: "Remove embed_linked_doc blocks that point to deleted/non-existent docs. Use dryRun=true to preview without making changes.",
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().describe("The doc to clean up orphan embeds from."),
      dryRun: z.boolean().optional().describe("If true, only report orphans without deleting (default: false)."),
    },
  }, cleanupOrphanEmbedsHandler as any);

  // ─── find_and_replace ───────────────────────────────────────────────────────
  const findAndReplaceHandler = async (parsed: {
    workspaceId?: string; docId: string; search: string; replace: string; matchAll?: boolean; dryRun?: boolean;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snap = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snap.missing) throw new Error(`Doc ${parsed.docId} not found.`);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      let totalMatches = 0;
      const matchLog: Array<{ blockId: string; flavour: string; original: string; replaced: string }> = [];
      const matchAll = parsed.matchAll !== false;
      for (const [blockId, raw] of blocks) {
        if (!(raw instanceof Y.Map)) continue;
        const flavour = raw.get("sys:flavour") as string | undefined;
        for (const [, val] of raw) {
          if (!(val instanceof Y.Text)) continue;
          const original = val.toString();
          if (!original.includes(parsed.search)) continue;
          const replaced = matchAll
            ? original.split(parsed.search).join(parsed.replace)
            : original.replace(parsed.search, parsed.replace);
          const count = matchAll ? original.split(parsed.search).length - 1 : 1;
          totalMatches += count;
          matchLog.push({ blockId, flavour: flavour ?? "unknown", original, replaced });
          if (!parsed.dryRun) {
            const prevSV = Y.encodeStateVector(doc);
            val.delete(0, val.length);
            val.insert(0, replaced);
            const delta = Y.encodeStateAsUpdate(doc, prevSV);
            await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));
          }
        }
      }
      return text({
        docId: parsed.docId, search: parsed.search, replace: parsed.replace,
        dryRun: parsed.dryRun ?? false, totalMatches, blocksAffected: matchLog.length, matches: matchLog,
      });
    } finally { socket.disconnect(); }
  };
  server.registerTool("find_and_replace", {
    title: "Find and Replace in Document",
    description: "Find and replace text across all Y.Text fields in a document (paragraphs, headings, titles). matchAll defaults to true. Use dryRun=true to preview before applying.",
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().describe("The doc to search in."),
      search: z.string().min(1).describe("Text to find (must not be empty)."),
      replace: z.string().describe("Replacement text."),
      matchAll: z.boolean().optional().describe("Replace all occurrences (default: true)."),
      dryRun: z.boolean().optional().describe("If true, only report matches without replacing (default: false)."),
    },
  }, findAndReplaceHandler as any);

  // ─── get_docs_by_tag ────────────────────────────────────────────────────────
  const getDocsByTagHandler = async (parsed: { workspaceId?: string; tag: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (!wsSnap.missing) return text({ tag: parsed.tag, count: 0, docs: [] });
      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
      const meta = wsDoc.getMap("meta");
      const { byId, options } = getWorkspaceTagOptionMaps(meta);
      const q = parsed.tag.toLowerCase();
      const matchingTagIds = new Set(
        options.filter(o => o.value.toLowerCase().includes(q)).map(o => o.id)
      );
      if (matchingTagIds.size === 0) {
        return text({
          tag: parsed.tag,
          count: 0,
          docs: [],
          availableTags: options.map(o => o.value),
        });
      }
      const pages = getWorkspacePageEntries(meta);
      const baseUrl = (process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, '')).replace(/\/$/, '');
      const matched = pages
        .map(p => {
          const rawTagIds = getStringArray(p.tagsArray);
          return { p, rawTagIds };
        })
        .filter(({ rawTagIds }) => rawTagIds.some(tid => matchingTagIds.has(tid)))
        .map(({ p, rawTagIds }) => ({
          docId: p.id,
          title: p.title ?? "Untitled",
          tags: resolveTagLabels(rawTagIds, byId),
          url: `${baseUrl}/workspace/${workspaceId}/${p.id}`,
        }));
      return text({ tag: parsed.tag, count: matched.length, docs: matched });
    } finally { socket.disconnect(); }
  };
  server.registerTool("get_docs_by_tag", {
    title: "Get Documents by Tag",
    description: "Filter documents by tag name (case-insensitive substring match). Returns matching docs with their full tag list. If no match, also returns availableTags for discoverability.",
    inputSchema: {
      workspaceId: z.string().optional(),
      tag: z.string().describe("Tag name to filter by (substring match, case-insensitive)."),
    },
  }, getDocsByTagHandler as any);

  // ─── list_workspace_tree ────────────────────────────────────────────────────
  const listWorkspaceTreeHandler = async (parsed: { workspaceId?: string; depth?: number }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const maxDepth = parsed.depth ?? 3;
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (!wsSnap.missing) return text({ workspaceId, tree: [] });
      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
      const pages = getWorkspacePageEntries(wsDoc.getMap("meta"));
      const titleById = new Map(pages.map(p => [p.id, p.title ?? "Untitled"]));
      const childrenOf = new Map<string, string[]>();
      const allChildren = new Set<string>();
      for (const page of pages) {
        const snap = await loadDoc(socket, workspaceId, page.id);
        if (!snap.missing) continue;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
        const blocks = doc.getMap("blocks") as Y.Map<any>;
        const kids: string[] = [];
        for (const [, raw] of blocks) {
          if (!(raw instanceof Y.Map)) continue;
          if (raw.get("sys:flavour") !== "affine:embed-linked-doc") continue;
          const pid = raw.get("prop:pageId");
          if (typeof pid === "string" && pid && titleById.has(pid)) {
            kids.push(pid);
            allChildren.add(pid);
          }
        }
        if (kids.length) childrenOf.set(page.id, kids);
      }
      const baseUrl = (process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, '')).replace(/\/$/, '');
      const roots = pages.filter(p => !allChildren.has(p.id)).map(p => p.id);
      const buildNode = (id: string, depth: number): any => ({
        docId: id, title: titleById.get(id) ?? "Untitled",
        url: `${baseUrl}/workspace/${workspaceId}/${id}`,
        children: depth < maxDepth ? (childrenOf.get(id) ?? []).map(cid => buildNode(cid, depth + 1)) : [],
      });
      return text({ workspaceId, totalDocs: pages.length, rootCount: roots.length, tree: roots.map(id => buildNode(id, 0)) });
    } finally { socket.disconnect(); }
  };
  server.registerTool("list_workspace_tree", {
    title: "List Workspace Tree",
    description: "Returns the full document hierarchy as a tree (roots → children → grandchildren). Use depth to limit nesting (default: 3). Note: loads all docs — may be slow on large workspaces.",
    inputSchema: {
      workspaceId: z.string().optional(),
      depth: z.number().optional().describe("Max nesting depth to return (default: 3)."),
    },
  }, listWorkspaceTreeHandler as any);

  // ─── get_orphan_docs ────────────────────────────────────────────────────────
  const getOrphanDocsHandler = async (parsed: { workspaceId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (!wsSnap.missing) return text({ orphans: [] });
      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
      const pages = getWorkspacePageEntries(wsDoc.getMap("meta"));
      const titleById = new Map(pages.map(p => [p.id, p.title ?? "Untitled"]));
      const allChildren = new Set<string>();
      for (const page of pages) {
        const snap = await loadDoc(socket, workspaceId, page.id);
        if (!snap.missing) continue;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
        const blocks = doc.getMap("blocks") as Y.Map<any>;
        for (const [, raw] of blocks) {
          if (!(raw instanceof Y.Map)) continue;
          if (raw.get("sys:flavour") !== "affine:embed-linked-doc") continue;
          const pageId = raw.get("prop:pageId");
          if (typeof pageId === "string" && pageId) allChildren.add(pageId);
        }
      }
      const baseUrl = (process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, "")).replace(/\/$/, "");
      const orphans = pages
        .filter(p => !allChildren.has(p.id))
        .map(p => ({
          docId: p.id,
          title: titleById.get(p.id) ?? "Untitled",
          url: `${baseUrl}/workspace/${workspaceId}/${p.id}`,
        }));
      return text({ count: orphans.length, orphans });
    } finally { socket.disconnect(); }
  };
  server.registerTool("get_orphan_docs", {
    title: "Get Orphan Documents",
    description: "Find all documents that have no parent (not linked from any other doc via embed_linked_doc). Useful for workspace hygiene. Note: scans all docs — O(n).",
    inputSchema: { workspaceId: z.string().optional() },
  }, getOrphanDocsHandler as any);

  const listChildrenHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const titleById = new Map<string, string>();
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (wsSnap.missing) {
        const wsDoc = new Y.Doc();
        Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
        for (const page of getWorkspacePageEntries(wsDoc.getMap("meta"))) {
          if (page.title) titleById.set(page.id, page.title);
        }
      }
      const snap = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snap.missing) return text({ docId: parsed.docId, children: [] });
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const children: Array<{ docId: string; title: string | null; url: string }> = [];
      for (const [, raw] of blocks) {
        if (!(raw instanceof Y.Map)) continue;
        if (raw.get("sys:flavour") !== "affine:embed-linked-doc") continue;
        const pageId = raw.get("prop:pageId");
        if (typeof pageId === "string" && pageId) {
          children.push({ docId: pageId, title: titleById.get(pageId) ?? null,
            url: `${(process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, '')).replace(/\/$/, '')}/workspace/${workspaceId}/${pageId}` });
        }
      }
      return text({ docId: parsed.docId, count: children.length, children });
    } finally { socket.disconnect(); }
  };
  server.registerTool("list_children", {
    title: "List Document Children",
    description: "List the direct children of a document in the sidebar (embed_linked_doc blocks). Returns docId, title, and URL for each child.",
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().describe("The parent doc whose children to list."),
    },
  }, listChildrenHandler as any);

  // ─── update_doc_title ───────────────────────────────────────────────────────
  const updateDocTitleHandler = async (parsed: { workspaceId?: string; docId: string; title: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const newTitle = parsed.title.trim();
    if (!newTitle) throw new Error("title must not be empty.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (wsSnap.missing) {
        const wsDoc = new Y.Doc();
        Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
        const prevSV = Y.encodeStateVector(wsDoc);
        const pages = wsDoc.getMap("meta").get("pages") as Y.Array<any> | undefined;
        if (pages) pages.forEach((page: Y.Map<any>) => {
          if (page instanceof Y.Map && page.get("id") === parsed.docId) page.set("title", newTitle);
        });
        const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
        await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(delta).toString("base64"));
      }
      const snap = await loadDoc(socket, workspaceId, parsed.docId);
      if (snap.missing) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
        const prevSV = Y.encodeStateVector(doc);
        const blocks = doc.getMap("blocks") as Y.Map<any>;
        for (const [, raw] of blocks) {
          if (!(raw instanceof Y.Map)) continue;
          if (raw.get("sys:flavour") === "affine:page") {
            const titleText = new Y.Text(); titleText.insert(0, newTitle);
            raw.set("prop:title", titleText); break;
          }
        }
        const delta = Y.encodeStateAsUpdate(doc, prevSV);
        await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));
      }
      return receipt("doc.update_title", {
        workspaceId,
        updated: true,
        docId: parsed.docId,
        title: newTitle,
      });
    } finally { socket.disconnect(); }
  };
  server.registerTool("update_doc_title", {
    title: "Update Document Title",
    description: "Rename a document — updates both the sidebar title (workspace metadata) and the doc's internal page block title.",
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().describe("The doc to rename."),
      title: z.string().describe("New title."),
    },
  }, updateDocTitleHandler as any);

  // ─── get_doc_by_title ────────────────────────────────────────────────────────
  const getDocByTitleHandler = async (parsed: { workspaceId?: string; query: string; limit?: number }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (!wsSnap.missing) return text({ query: parsed.query, found: false, results: [] });
      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
      const q = parsed.query.toLowerCase();
      const limit = parsed.limit ?? 1;
      const matches = getWorkspacePageEntries(wsDoc.getMap("meta"))
        .filter(p => p.title && p.title.toLowerCase().includes(q)).slice(0, limit);
      if (matches.length === 0) return text({ query: parsed.query, found: false, results: [] });
      const results = [];
      for (const match of matches) {
        const snap = await loadDoc(socket, workspaceId, match.id);
        if (!snap.missing) { results.push({ docId: match.id, title: match.title, found: false }); continue; }
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
        const collected = collectDocForMarkdown(doc, new Map());
        const rendered = renderBlocksToMarkdown({ rootBlockIds: collected.rootBlockIds, blocksById: collected.blocksById });
        results.push({ docId: match.id, title: match.title, found: true, markdown: rendered.markdown,
          url: `${(process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, '')).replace(/\/$/, '')}/workspace/${workspaceId}/${match.id}` });
      }
      return text({ query: parsed.query, found: results.some(r => (r as any).found), results });
    } finally { socket.disconnect(); }
  };
  server.registerTool("get_doc_by_title", {
    title: "Get Document by Title",
    description: "Find a document by title and return its content as markdown in a single call. Combines search_docs + export_doc_markdown. Returns the first match by default; use limit for multiple.",
    inputSchema: {
      workspaceId: z.string().optional(),
      query: z.string().describe("Title search query (case-insensitive substring match)."),
      limit: z.number().optional().describe("Max docs to return with content (default: 1)."),
    },
  }, getDocByTitleHandler as any);

  // ─── list_backlinks ──────────────────────────────────────────────────────────
  const listBacklinksHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (!wsSnap.missing) return text({ docId: parsed.docId, count: 0, backlinks: [] });
      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
      const pages = getWorkspacePageEntries(wsDoc.getMap("meta"));
      const titleById = new Map(pages.map(p => [p.id, p.title]));
      const backlinks: Array<{ docId: string; title: string | null; url: string }> = [];
      for (const page of pages) {
        if (page.id === parsed.docId) continue;
        const snap = await loadDoc(socket, workspaceId, page.id);
        if (!snap.missing) continue;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
        const blocks = doc.getMap("blocks") as Y.Map<any>;
        for (const [, raw] of blocks) {
          if (!(raw instanceof Y.Map)) continue;
          if (raw.get("sys:flavour") === "affine:embed-linked-doc" && raw.get("prop:pageId") === parsed.docId) {
            backlinks.push({ docId: page.id, title: titleById.get(page.id) ?? null,
              url: `${(process.env.AFFINE_BASE_URL || endpoint.replace(/\/graphql\/?$/, '')).replace(/\/$/, '')}/workspace/${workspaceId}/${page.id}` });
            break;
          }
        }
      }
      return text({ docId: parsed.docId, count: backlinks.length, backlinks });
    } finally { socket.disconnect(); }
  };
  server.registerTool("list_backlinks", {
    title: "List Document Backlinks",
    description: "Find all documents that embed-link to a given doc (its parents/references in the sidebar). Scans all docs — may be slow on large workspaces.",
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().describe("The doc to find backlinks for."),
    },
  }, listBacklinksHandler as any);

  // ─── duplicate_doc ───────────────────────────────────────────────────────────
  const duplicateDocHandler = async (parsed: { workspaceId?: string; docId: string; title?: string; parentDocId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snap = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snap.missing) throw new Error(`Doc ${parsed.docId} not found.`);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
      const collected = collectDocForMarkdown(doc, new Map());
      const rendered = renderBlocksToMarkdown({ rootBlockIds: collected.rootBlockIds, blocksById: collected.blocksById });
      const newTitle = (parsed.title ?? `${collected.title || "Untitled"} (copy)`).trim();
      socket.disconnect();
      const created = await createDocFromMarkdownCore({ workspaceId, title: newTitle, markdown: rendered.markdown, parentDocId: parsed.parentDocId });
      return receipt("doc.duplicate", {
        workspaceId,
        sourceDocId: parsed.docId,
        docId: created.docId,
        title: created.title,
        parentDocId: created.parentDocId,
        linkedToParent: created.linkedToParent,
        cloneMode: "markdown-roundtrip",
        lossy: Boolean(created.lossy ?? (created.warnings?.length ?? 0) > 0),
        warnings: created.warnings ?? [],
        stats: created.stats ?? null,
      });
    } catch (err) {
      try { socket.disconnect(); } catch { /* already disconnected */ }
      throw err;
    }
  };
  server.registerTool("duplicate_doc", {
    title: "Duplicate Document",
    description: "Clone a document by copying its markdown content into a new doc. Optionally set a new title and/or parentDocId to place it in the sidebar.",
    inputSchema: {
      workspaceId: z.string().optional(),
      docId: z.string().describe("The source doc to duplicate."),
      title: z.string().optional().describe("Title for the new doc. Defaults to '<original title> (copy)'."),
      parentDocId: z.string().optional().describe("Parent doc to link the new doc under in the sidebar."),
    },
  }, duplicateDocHandler as any);

  // ─── create_doc_from_template ───────────────────────────────────────────────
  const createDocFromTemplateHandler = async (parsed: {
    workspaceId?: string; templateDocId: string; title: string;
    variables?: Record<string, string>; parentDocId?: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required.");
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const snap = await loadDoc(socket, workspaceId, parsed.templateDocId);
      if (!snap.missing) throw new Error(`Template doc ${parsed.templateDocId} not found.`);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
      const collected = collectDocForMarkdown(doc, new Map());
      const rendered = renderBlocksToMarkdown({ rootBlockIds: collected.rootBlockIds, blocksById: collected.blocksById });
      let markdown = rendered.markdown;
      const vars = parsed.variables ?? {};
      for (const [key, value] of Object.entries(vars)) {
        const pattern = new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}}`, "g");
        markdown = markdown.replace(pattern, value);
      }
      const unfilled = [...markdown.matchAll(/\{\{\s*[\w.-]+\s*\}\}/g)].map(match => match[0]);
      socket.disconnect();
      const created = await createDocFromMarkdownCore({ workspaceId, title: parsed.title, markdown, parentDocId: parsed.parentDocId });
      return receipt("doc.create_from_template", {
        workspaceId,
        sourceTemplateDocId: parsed.templateDocId,
        docId: created.docId,
        title: created.title,
        parentDocId: created.parentDocId,
        linkedToParent: created.linkedToParent,
        cloneMode: "markdown-roundtrip",
        lossy: Boolean(created.lossy ?? (created.warnings?.length ?? 0) > 0),
        warnings: created.warnings ?? [],
        stats: created.stats ?? null,
        unfilledVariables: unfilled,
      });
    } catch (err) {
      try { socket.disconnect(); } catch { /* already disconnected */ }
      throw err;
    }
  };
  server.registerTool("create_doc_from_template", {
    title: "Create Document from Template",
    description: "Clone a template doc and substitute {{variable}} placeholders. Returns a warning for any unfilled variables. Optionally link to a parent doc in the sidebar.",
    inputSchema: {
      workspaceId: z.string().optional(),
      templateDocId: z.string().describe("The template doc to clone from."),
      title: z.string().describe("Title for the new doc."),
      variables: z.record(z.string(), z.string()).optional().describe("Key-value map of {{variable}} substitutions."),
      parentDocId: z.string().optional().describe("Parent doc to link the new doc under in the sidebar."),
    },
  }, createDocFromTemplateHandler as any);

  async function syncRawTagsToDoc(parsed: {
    workspaceId: string;
    docId: string;
    tags: string[];
  }): Promise<void> {
    if (parsed.tags.length === 0) {
      return;
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, parsed.workspaceId);

      const workspaceSnapshot = await loadDoc(socket, parsed.workspaceId, parsed.workspaceId);
      if (!workspaceSnapshot.missing) {
        throw new Error(`Workspace root document not found for workspace ${parsed.workspaceId}`);
      }

      const wsDoc = new Y.Doc();
      Y.applyUpdate(wsDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
      const wsPrevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap("meta");
      const page = getWorkspacePageEntries(wsMeta).find(entry => entry.id === parsed.docId);
      if (!page) {
        throw new Error(`docId ${parsed.docId} is not present in workspace ${parsed.workspaceId}`);
      }

      const pageTags = ensureTagArray(page.entry);
      pageTags.delete(0, pageTags.length);
      for (const tag of parsed.tags) {
        pageTags.push([tag]);
      }

      const wsDelta = Y.encodeStateAsUpdate(wsDoc, wsPrevSV);
      await pushDocUpdate(socket, parsed.workspaceId, parsed.workspaceId, Buffer.from(wsDelta).toString("base64"));

      const docSnapshot = await loadDoc(socket, parsed.workspaceId, parsed.docId);
      if (!docSnapshot.missing) {
        throw new Error(`Document ${parsed.docId} not found in workspace ${parsed.workspaceId}`);
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(docSnapshot.missing, "base64"));
      const docPrevSV = Y.encodeStateVector(doc);
      const docMeta = doc.getMap("meta");
      const docTags = ensureTagArray(docMeta);
      docTags.delete(0, docTags.length);
      for (const tag of parsed.tags) {
        docTags.push([tag]);
      }

      const docDelta = Y.encodeStateAsUpdate(doc, docPrevSV);
      await pushDocUpdate(socket, parsed.workspaceId, parsed.docId, Buffer.from(docDelta).toString("base64"));
    } finally {
      socket.disconnect();
    }
  }

  const inspectTemplateStructureHandler = async (parsed: { workspaceId?: string; templateDocId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID.");
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const workspaceSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!workspaceSnapshot.missing) {
        throw new Error(`Workspace root document not found for workspace ${workspaceId}`);
      }
      const workspaceDoc = new Y.Doc();
      Y.applyUpdate(workspaceDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
      const tagOptionsById = getWorkspaceTagOptionMaps(workspaceDoc.getMap("meta")).byId;

      const templateSnapshot = await loadDoc(socket, workspaceId, parsed.templateDocId);
      if (!templateSnapshot.missing) {
        throw new Error(`Template doc ${parsed.templateDocId} not found.`);
      }

      const templateDoc = new Y.Doc();
      Y.applyUpdate(templateDoc, Buffer.from(templateSnapshot.missing, "base64"));
      const meta = templateDoc.getMap("meta");
      const rawTags = getStringArray(getTagArray(meta));
      const resolvedTags = resolveTagLabels(rawTags, tagOptionsById);
      const supportIssues: NativeTemplateSupportIssue[] = [];
      scanNativeTemplateValue(meta, "meta", supportIssues, new WeakSet<object>());
      scanNativeTemplateValue(templateDoc.getMap("blocks"), "blocks", supportIssues, new WeakSet<object>());

      return text(summarizeNativeTemplateStructure(
        templateDoc,
        workspaceId,
        parsed.templateDocId,
        resolvedTags,
        supportIssues
      ));
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "inspect_template_structure",
    {
      title: "Inspect Template Structure",
      description: "Inspect a template doc's native structure, tags, and fallback risk before instantiation.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        templateDocId: z.string().describe("The template doc to inspect."),
      },
    },
    inspectTemplateStructureHandler as any
  );

  const instantiateTemplateNativeHandler = async (parsed: {
    workspaceId?: string;
    templateDocId: string;
    title?: string;
    variables?: Record<string, string>;
    parentDocId?: string;
    allowFallback?: boolean;
    preserveTags?: boolean;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID.");
    }

    const allowFallback = parsed.allowFallback !== false;
    const preserveTags = parsed.preserveTags !== false;
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

    try {
      await joinWorkspace(socket, workspaceId);

      const workspaceSnapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (!workspaceSnapshot.missing) {
        throw new Error(`Workspace root document not found for workspace ${workspaceId}`);
      }
      const workspaceDoc = new Y.Doc();
      Y.applyUpdate(workspaceDoc, Buffer.from(workspaceSnapshot.missing, "base64"));
      const workspaceMeta = workspaceDoc.getMap("meta");
      const tagOptionById = getWorkspaceTagOptionMaps(workspaceMeta).byId;
      const sourcePage = getWorkspacePageEntries(workspaceMeta).find(entry => entry.id === parsed.templateDocId);
      if (!sourcePage) {
        throw new Error(`Template doc ${parsed.templateDocId} was not found in workspace ${workspaceId}.`);
      }

      const templateSnapshot = await loadDoc(socket, workspaceId, parsed.templateDocId);
      if (!templateSnapshot.missing) {
        throw new Error(`Template doc ${parsed.templateDocId} not found.`);
      }

      const templateDoc = new Y.Doc();
      Y.applyUpdate(templateDoc, Buffer.from(templateSnapshot.missing, "base64"));
      const templateMeta = templateDoc.getMap("meta");
      const templateBlocks = templateDoc.getMap("blocks") as Y.Map<any>;
      const rawTags = getStringArray(sourcePage.tagsArray);
      const resolvedTags = resolveTagLabels(rawTags, tagOptionById);
      const supportIssues: NativeTemplateSupportIssue[] = [];
      scanNativeTemplateValue(templateMeta, "meta", supportIssues, new WeakSet<object>());
      scanNativeTemplateValue(templateBlocks, "blocks", supportIssues, new WeakSet<object>());
      const nativeSummary = summarizeNativeTemplateStructure(
        templateDoc,
        workspaceId,
        parsed.templateDocId,
        resolvedTags,
        supportIssues
      );

      const sourceTitle = nativeSummary.title || sourcePage.title || "Untitled";
      const targetTitle = (parsed.title ?? sourceTitle).trim() || sourceTitle;

      if (!nativeSummary.nativeCloneSupported) {
        if (!allowFallback) {
          throw new Error(`Native template instantiation is not supported: ${nativeSummary.fallbackReasons.join(" | ")}`);
        }

        const fallbackResult = await createDocFromTemplateHandler({
          workspaceId,
          templateDocId: parsed.templateDocId,
          title: targetTitle,
          variables: parsed.variables,
          parentDocId: parsed.parentDocId,
        });
        const created = JSON.parse((fallbackResult as any).content[0].text);
        return text({
          ...created,
          mode: "markdown_fallback",
          nativeCloneSupported: false,
          warnings: mergeWarnings(
            created.warnings ?? [],
            nativeSummary.fallbackReasons,
            ["Native template instantiation fell back to markdown materialization."]
          ),
        });
      }

      const created = await createDocInternal({
        workspaceId,
        title: targetTitle,
      });

      const targetSnapshot = await loadDoc(socket, workspaceId, created.docId);
      if (!targetSnapshot.missing) {
        throw new Error(`Created doc ${created.docId} was not found for native template instantiation.`);
      }

      const targetDoc = new Y.Doc();
      Y.applyUpdate(targetDoc, Buffer.from(targetSnapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(targetDoc);
      const targetMeta = targetDoc.getMap("meta");
      const targetBlocks = targetDoc.getMap("blocks") as Y.Map<any>;

      const blockIdMap = new Map<string, string>();
      for (const [sourceBlockId] of templateBlocks) {
        blockIdMap.set(String(sourceBlockId), generateId());
      }
      const cloneContext: NativeTemplateCloneContext = {
        sourceDocId: parsed.templateDocId,
        targetDocId: created.docId,
        blockIdMap,
        variables: parsed.variables ?? {},
        unresolvedVariables: new Set<string>(),
        replacedVariableCount: 0,
      };

      for (const [existingBlockId] of targetBlocks) {
        targetBlocks.delete(String(existingBlockId));
      }
      for (const [sourceBlockId, rawBlock] of templateBlocks) {
        if (!(rawBlock instanceof Y.Map)) {
          continue;
        }
        const nextBlockId = blockIdMap.get(String(sourceBlockId))!;
        const cloned = cloneNativeTemplateValue(rawBlock, cloneContext, `blocks.${String(sourceBlockId)}`) as Y.Map<any>;
        cloned.set("sys:id", nextBlockId);
        targetBlocks.set(nextBlockId, cloned);
      }

      targetMeta.set("id", created.docId);
      targetMeta.set("title", targetTitle);
      if (preserveTags) {
        const targetMetaTags = ensureTagArray(targetMeta);
        targetMetaTags.delete(0, targetMetaTags.length);
        for (const tag of rawTags) {
          targetMetaTags.push([tag]);
        }
      }

      const pageId = findBlockIdByFlavour(targetBlocks, "affine:page");
      if (pageId) {
        const pageBlock = findBlockById(targetBlocks, pageId);
        if (pageBlock) {
          pageBlock.set("prop:title", makeText(targetTitle));
        }
      }

      const delta = Y.encodeStateAsUpdate(targetDoc, prevSV);
      await pushDocUpdate(socket, workspaceId, created.docId, Buffer.from(delta).toString("base64"));

      if (preserveTags && rawTags.length > 0) {
        await syncRawTagsToDoc({
          workspaceId,
          docId: created.docId,
          tags: rawTags,
        });
      }

      let linkedToParent = false;
      const warnings: string[] = [];
      if (parsed.parentDocId) {
        try {
          await appendBlockInternal({
            workspaceId,
            docId: parsed.parentDocId,
            type: "embed_linked_doc",
            pageId: created.docId,
          });
          linkedToParent = true;
        } catch (err: any) {
          warnings.push(`Doc created but could not be linked to parent "${parsed.parentDocId}": ${err?.message ?? "unknown error"}`);
        }
      }

      return text({
        workspaceId,
        sourceTemplateDocId: parsed.templateDocId,
        docId: created.docId,
        title: targetTitle,
        mode: "native",
        nativeCloneSupported: true,
        linkedToParent,
        preservedTags: preserveTags ? resolvedTags : [],
        replacedVariableCount: cloneContext.replacedVariableCount,
        unresolvedVariables: Array.from(cloneContext.unresolvedVariables),
        warnings,
        blockCount: nativeSummary.blockCount,
        rootBlockIds: nativeSummary.rootBlockIds.map(blockId => blockIdMap.get(blockId) ?? blockId),
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "instantiate_template_native",
    {
      title: "Instantiate Template Natively",
      description: "Instantiate a template using native AFFiNE block cloning when supported, falling back to markdown materialization only when necessary.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        templateDocId: z.string().describe("The template doc to instantiate."),
        title: z.string().optional().describe("Optional title for the new document. Defaults to the template title."),
        variables: z.record(z.string(), z.string()).optional().describe("Key-value map of {{variable}} substitutions applied during cloning."),
        parentDocId: z.string().optional().describe("Optional parent doc to link the instantiated doc under in the sidebar."),
        allowFallback: z.boolean().optional().describe("If false, fail instead of falling back to markdown materialization when native cloning is unsupported."),
        preserveTags: z.boolean().optional().describe("If true (default), copy the template's tags onto the instantiated doc."),
      },
    },
    instantiateTemplateNativeHandler as any
  );

  // ── helpers for database select columns ──

  type DatabaseColumnDef = {
    id: string;
    name: string;
    type: string;
    options: Array<{ id: string; value: string; color: string }>;
    raw: any;
  };

  type DatabaseViewColumnDef = {
    id: string;
    name: string | null;
    hidden: boolean;
    width: number | null;
  };

  type DatabaseViewDef = {
    id: string;
    name: string;
    mode: string;
    columns: DatabaseViewColumnDef[];
    columnIds: string[];
    groupBy: {
      columnId: string | null;
      name: string | null;
      type: string | null;
    } | null;
    header: {
      titleColumn: string | null;
      iconColumn: string | null;
    };
  };

  type DatabaseColumnLookup = {
    columnDefs: DatabaseColumnDef[];
    colById: Map<string, DatabaseColumnDef>;
    colByName: Map<string, DatabaseColumnDef>;
    colByNameLower: Map<string, DatabaseColumnDef>;
    titleCol: DatabaseColumnDef | null;
  };

  type DatabaseDocContext = DatabaseColumnLookup & {
    socket: Awaited<ReturnType<typeof connectWorkspaceSocket>>;
    doc: Y.Doc;
    prevSV: Uint8Array;
    blocks: Y.Map<any>;
    dbBlock: Y.Map<any>;
    cellsMap: Y.Map<any>;
  };

  function buildDatabaseIntentPreset(intent: DatabaseIntent): DatabaseIntentPreset {
    switch (intent) {
      case "task_board":
        return {
          title: "Task Board",
          viewName: "Task Board",
          statusOptions: ["Todo", "In Progress", "Blocked", "Done"],
          extraColumns: [
            { name: "Type", type: "select", options: ["Task", "Bug", "Chore"], width: 140 },
            { name: "Priority", type: "select", options: ["P0", "P1", "P2", "P3"], width: 120 },
            { name: "Owner", type: "rich-text", width: 180 },
            { name: "Due Date", type: "date", width: 160 },
          ],
          starterRows: [
            {
              title: "Define the scope",
              Status: "Todo",
              Type: "Task",
              Priority: "P1",
              Owner: "Product",
            },
            {
              title: "Build the first pass",
              Status: "In Progress",
              Type: "Task",
              Priority: "P1",
              Owner: "Engineering",
            },
            {
              title: "Review and ship",
              Status: "Done",
              Type: "Chore",
              Priority: "P2",
              Owner: "Delivery",
            },
          ],
        };
      case "issue_tracker":
        return {
          title: "Issue Tracker",
          viewName: "Issue Tracker",
          statusOptions: ["Open", "In Progress", "In Review", "Blocked", "Resolved", "Closed"],
          extraColumns: [
            { name: "Type", type: "select", options: ["Bug", "Feature", "Task", "Incident"], width: 140 },
            { name: "Priority", type: "select", options: ["P0", "P1", "P2", "P3"], width: 120 },
            { name: "Assignee", type: "rich-text", width: 180 },
            { name: "Due Date", type: "date", width: 160 },
          ],
          starterRows: [
            {
              title: "Document reproduction steps",
              Status: "Open",
              Type: "Bug",
              Priority: "P0",
              Assignee: "Unassigned",
            },
            {
              title: "Fix the regression",
              Status: "In Progress",
              Type: "Bug",
              Priority: "P1",
              Assignee: "Engineering",
            },
            {
              title: "Verify the release candidate",
              Status: "Resolved",
              Type: "Task",
              Priority: "P2",
              Assignee: "QA",
            },
          ],
        };
      default: {
        const exhaustiveCheck: never = intent;
        throw new Error(`Unsupported database intent '${exhaustiveCheck}'`);
      }
    }
  }

  /** Read column definitions including select options from a database block */
  function readColumnDefs(dbBlock: Y.Map<any>): DatabaseColumnDef[] {
    const columnsRaw = dbBlock.get("prop:columns");
    const defs: DatabaseColumnDef[] = [];
    if (!(columnsRaw instanceof Y.Array)) return defs;
    columnsRaw.forEach((col: any) => {
      const id = col instanceof Y.Map ? col.get("id") : col?.id;
      const name = col instanceof Y.Map ? col.get("name") : col?.name;
      const type = col instanceof Y.Map ? col.get("type") : col?.type;
      // Read select/multi-select options
      const data = col instanceof Y.Map ? col.get("data") : col?.data;
      let options: Array<{ id: string; value: string; color: string }> = [];
      if (data) {
        const rawOpts = data instanceof Y.Map ? data.get("options") : data?.options;
        if (Array.isArray(rawOpts)) {
          options = rawOpts.map((o: any) => ({
            id: String(o?.id ?? o?.get?.("id") ?? ""),
            value: String(o?.value ?? o?.get?.("value") ?? ""),
            color: String(o?.color ?? o?.get?.("color") ?? ""),
          }));
        } else if (rawOpts instanceof Y.Array) {
          rawOpts.forEach((o: any) => {
            options.push({
              id: String(o instanceof Y.Map ? o.get("id") : o?.id ?? ""),
              value: String(o instanceof Y.Map ? o.get("value") : o?.value ?? ""),
              color: String(o instanceof Y.Map ? o.get("color") : o?.color ?? ""),
            });
          });
        }
      }
      if (id) defs.push({ id: String(id), name: String(name || ""), type: String(type || "rich-text"), options, raw: col });
    });
    return defs;
  }

  function readDatabaseViewDefs(dbBlock: Y.Map<any>, lookup: DatabaseColumnLookup): DatabaseViewDef[] {
    const viewsRaw = dbBlock.get("prop:views");
    const views: DatabaseViewDef[] = [];
    if (!(viewsRaw instanceof Y.Array)) {
      return views;
    }

    viewsRaw.forEach((view: any) => {
      const id = view instanceof Y.Map ? view.get("id") : view?.id;
      if (!id) {
        return;
      }

      const columnsRaw = view instanceof Y.Map ? view.get("columns") : view?.columns;
      const headerRaw = view instanceof Y.Map ? view.get("header") : view?.header;
      const groupByRaw = view instanceof Y.Map ? view.get("groupBy") : view?.groupBy;
      const columns: DatabaseViewColumnDef[] = databaseArrayValues(columnsRaw)
        .map((entry: any) => {
          const columnId = entry instanceof Y.Map ? entry.get("id") : entry?.id;
          if (!columnId || typeof columnId !== "string") {
            return null;
          }

          const columnDef = lookup.colById.get(columnId) || null;
          const hidden = entry instanceof Y.Map ? entry.get("hide") : entry?.hide;
          const width = entry instanceof Y.Map ? entry.get("width") : entry?.width;

          return {
            id: columnId,
            name: columnDef?.name || null,
            hidden: hidden === true,
            width: typeof width === "number" ? width : null,
          };
        })
        .filter((entry): entry is DatabaseViewColumnDef => entry !== null);

      views.push({
        id: String(id),
        name: String((view instanceof Y.Map ? view.get("name") : view?.name) || ""),
        mode: String((view instanceof Y.Map ? view.get("mode") : view?.mode) || ""),
        columns,
        columnIds: columns.map(column => column.id),
        groupBy: groupByRaw
          ? {
              columnId: typeof (groupByRaw as any)?.columnId === "string" ? (groupByRaw as any).columnId : null,
              name: typeof (groupByRaw as any)?.name === "string" ? (groupByRaw as any).name : null,
              type: typeof (groupByRaw as any)?.type === "string" ? (groupByRaw as any).type : null,
            }
          : null,
        header: {
          titleColumn: typeof (headerRaw as any)?.titleColumn === "string" ? (headerRaw as any).titleColumn : null,
          iconColumn: typeof (headerRaw as any)?.iconColumn === "string" ? (headerRaw as any).iconColumn : null,
        },
      });
    });

    return views;
  }

  function isTitleAliasKey(value: string): boolean {
    return value.trim().toLowerCase() === "title";
  }

  function buildDatabaseColumnLookup(columnDefs: DatabaseColumnDef[]): DatabaseColumnLookup {
    const colById = new Map<string, DatabaseColumnDef>();
    const colByName = new Map<string, DatabaseColumnDef>();
    const colByNameLower = new Map<string, DatabaseColumnDef>();
    let titleCol: DatabaseColumnDef | null = null;
    for (const col of columnDefs) {
      colById.set(col.id, col);
      if (col.name) {
        colByName.set(col.name, col);
        colByNameLower.set(col.name.trim().toLowerCase(), col);
      }
      if (!titleCol && col.type === "title") {
        titleCol = col;
      }
    }
    return { columnDefs, colById, colByName, colByNameLower, titleCol };
  }

  function findDatabaseColumn(key: string, lookup: DatabaseColumnLookup): DatabaseColumnDef | null {
    return lookup.colByName.get(key)
      || lookup.colById.get(key)
      || lookup.colByNameLower.get(key.trim().toLowerCase())
      || null;
  }

  function availableDatabaseColumns(lookup: DatabaseColumnLookup): string {
    return ["title", ...lookup.columnDefs.map(col => col.name || col.id)].join(", ");
  }

  function getDatabaseRowIds(dbBlock: Y.Map<any>): string[] {
    return childIdsFrom(dbBlock.get("sys:children"));
  }

  function readDatabaseRowTitle(rowBlock: Y.Map<any>): string {
    return asText(rowBlock.get("prop:text"));
  }

  function resolveDatabaseTitleValue(
    cells: Record<string, unknown>,
    lookup: DatabaseColumnLookup,
  ): string {
    if (lookup.titleCol) {
      const value = cells[lookup.titleCol.name] ?? cells[lookup.titleCol.id];
      if (value !== undefined) {
        return String(value ?? "");
      }
    }

    for (const [key, value] of Object.entries(cells)) {
      if (isTitleAliasKey(key)) {
        return String(value ?? "");
      }
    }

    const namedTitleColumn = lookup.colByNameLower.get("title");
    if (namedTitleColumn) {
      const value = cells[namedTitleColumn.name] ?? cells[namedTitleColumn.id];
      if (value !== undefined) {
        return String(value ?? "");
      }
    }

    return "";
  }

  function ensureDatabaseRowCells(cellsMap: Y.Map<any>, rowBlockId: string): Y.Map<any> {
    const existing = cellsMap.get(rowBlockId);
    if (existing instanceof Y.Map) {
      return existing;
    }
    const rowCells = new Y.Map<any>();
    cellsMap.set(rowBlockId, rowCells);
    return rowCells;
  }

  function addDatabaseRowToBlock(parsed: {
    blocks: Y.Map<any>;
    dbBlock: Y.Map<any>;
    cellsMap: Y.Map<any>;
    databaseBlockId: string;
    lookup: DatabaseColumnLookup;
    cells: Record<string, unknown>;
    linkedDocId?: string;
  }): string {
    const rowBlockId = generateId();
    const rowBlock = new Y.Map<any>();
    setSysFields(rowBlock, rowBlockId, "affine:paragraph");
    rowBlock.set("sys:parent", parsed.databaseBlockId);
    rowBlock.set("sys:children", new Y.Array<string>());
    rowBlock.set("prop:type", "text");
    if (parsed.linkedDocId) {
      rowBlock.set("prop:text", makeLinkedDocText(parsed.linkedDocId));
    } else {
      const titleValue = resolveDatabaseTitleValue(parsed.cells, parsed.lookup);
      rowBlock.set("prop:text", makeText(String(titleValue)));
    }
    parsed.blocks.set(rowBlockId, rowBlock);

    const dbChildren = ensureChildrenArray(parsed.dbBlock);
    dbChildren.push([rowBlockId]);

    const rowCells = ensureDatabaseRowCells(parsed.cellsMap, rowBlockId);
    for (const [key, value] of Object.entries(parsed.cells)) {
      const col = findDatabaseColumn(key, parsed.lookup);
      if (!col) {
        if (isTitleAliasKey(key)) {
          continue;
        }
        throw new Error(`Column '${key}' not found. Available columns: ${availableDatabaseColumns(parsed.lookup)}`);
      }
      writeDatabaseCellValue(rowCells, col, value, true);
    }

    return rowBlockId;
  }

  function getDatabaseRowBlock(
    blocks: Y.Map<any>,
    dbBlock: Y.Map<any>,
    databaseBlockId: string,
    rowBlockId: string,
  ): Y.Map<any> {
    const rowBlock = findBlockById(blocks, rowBlockId);
    if (!rowBlock) {
      throw new Error(`Row block '${rowBlockId}' not found`);
    }
    const parentId = rowBlock.get("sys:parent");
    const isDatabaseChild = getDatabaseRowIds(dbBlock).includes(rowBlockId);
    if (parentId !== databaseBlockId && !isDatabaseChild) {
      throw new Error(`Row block '${rowBlockId}' does not belong to database '${databaseBlockId}'`);
    }
    if (rowBlock.get("sys:flavour") !== "affine:paragraph") {
      throw new Error(`Row block '${rowBlockId}' is not a database row paragraph`);
    }
    return rowBlock;
  }

  function databaseArrayValues(value: unknown): unknown[] {
    if (value instanceof Y.Array) {
      const entries: unknown[] = [];
      value.forEach(entry => {
        entries.push(entry);
      });
      return entries;
    }
    if (Array.isArray(value)) {
      return value;
    }
    return [];
  }

  /** Find or create a select option for a column, mutating the column's data in place */
  function resolveSelectOptionId(
    col: { name: string; raw: any; options: Array<{ id: string; value: string; color: string }> },
    valueText: string,
    createOption: boolean = true,
  ): string {
    // Try exact match first
    const existing = col.options.find(o => o.value === valueText);
    if (existing) return existing.id;
    if (!createOption) {
      throw new Error(`Column "${col.name}": option "${valueText}" not found`);
    }
    // Create new option
    const newId = generateId();
    const colorIdx = col.options.length % SELECT_COLORS.length;
    const newOpt = { id: newId, value: valueText, color: SELECT_COLORS[colorIdx] };
    col.options.push(newOpt);
    // Mutate the raw column's data to include the new option
    const rawCol = col.raw;
    if (rawCol instanceof Y.Map) {
      let data = rawCol.get("data");
      if (!(data instanceof Y.Map)) {
        data = new Y.Map<any>();
        rawCol.set("data", data);
      }
      let opts = data.get("options");
      if (!(opts instanceof Y.Array)) {
        opts = new Y.Array<any>();
        data.set("options", opts);
      }
      const optMap = new Y.Map<any>();
      optMap.set("id", newId);
      optMap.set("value", valueText);
      optMap.set("color", SELECT_COLORS[colorIdx]);
      opts.push([optMap]);
    }
    return newId;
  }

  function decodeDatabaseCellValue(
    col: DatabaseColumnDef,
    cellEntry: unknown,
  ): Record<string, unknown> {
    const rawValue = cellEntry instanceof Y.Map ? cellEntry.get("value") : (cellEntry as any)?.value;
    const base: Record<string, unknown> = {
      columnId: col.id,
      type: col.type,
    };

    switch (col.type) {
      case "rich-text":
      case "title":
        return { ...base, value: richTextValueToString(rawValue) || null };
      case "select": {
        const optionId = asStringOrNull(rawValue);
        const option = col.options.find(entry => entry.id === optionId) || null;
        return {
          ...base,
          value: option?.value ?? optionId ?? null,
          optionId: optionId ?? null,
        };
      }
      case "multi-select": {
        const optionIds = databaseArrayValues(rawValue).map(entry => String(entry));
        const values = optionIds.map(optionId => col.options.find(entry => entry.id === optionId)?.value ?? optionId);
        return {
          ...base,
          value: values,
          optionIds,
        };
      }
      case "number": {
        const numericValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
        return {
          ...base,
          value: Number.isFinite(numericValue) ? numericValue : null,
        };
      }
      case "checkbox":
        return { ...base, value: typeof rawValue === "boolean" ? rawValue : !!rawValue };
      case "date": {
        const numericValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
        return {
          ...base,
          value: Number.isFinite(numericValue) ? numericValue : null,
        };
      }
      case "link":
        return { ...base, value: rawValue == null ? null : String(rawValue) };
      default:
        return {
          ...base,
          value: typeof rawValue === "string" || rawValue instanceof Y.Text || Array.isArray(rawValue)
            ? richTextValueToString(rawValue)
            : rawValue ?? null,
        };
    }
  }

  function writeDatabaseCellValue(
    rowCells: Y.Map<any>,
    col: DatabaseColumnDef,
    value: unknown,
    createOption: boolean,
  ) {
    const cellValue = new Y.Map<any>();
    cellValue.set("columnId", col.id);
    switch (col.type) {
      case "rich-text":
      case "title":
        cellValue.set("value", makeText(String(value ?? "")));
        break;
      case "number": {
        const num = Number(value);
        if (Number.isNaN(num)) {
          throw new Error(`Column "${col.name}": expected a number, got ${JSON.stringify(value)}`);
        }
        cellValue.set("value", num);
        break;
      }
      case "checkbox": {
        let bool: boolean;
        if (typeof value === "boolean") {
          bool = value;
        } else if (typeof value === "string") {
          const lower = value.toLowerCase().trim();
          bool = lower === "true" || lower === "1" || lower === "yes";
        } else {
          bool = !!value;
        }
        cellValue.set("value", bool);
        break;
      }
      case "select":
        cellValue.set("value", resolveSelectOptionId(col, String(value ?? ""), createOption));
        break;
      case "multi-select": {
        const labels = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
        const optionIds = new Y.Array<string>();
        optionIds.push(labels.map(label => resolveSelectOptionId(col, label, createOption)));
        cellValue.set("value", optionIds);
        break;
      }
      case "date": {
        const numericValue = typeof value === "number"
          ? value
          : Number.isNaN(Number(value)) ? Date.parse(String(value)) : Number(value);
        if (!Number.isFinite(numericValue)) {
          throw new Error(`Column "${col.name}": expected a timestamp-compatible value, got ${JSON.stringify(value)}`);
        }
        cellValue.set("value", numericValue);
        break;
      }
      case "link":
        cellValue.set("value", String(value ?? ""));
        break;
      default:
        if (typeof value === "string") {
          cellValue.set("value", makeText(value));
        } else {
          cellValue.set("value", value);
        }
    }
    rowCells.set(col.id, cellValue);
  }

  async function loadDatabaseDocContext(
    workspaceId: string,
    docId: string,
    databaseBlockId: string,
  ): Promise<DatabaseDocContext> {
    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    await joinWorkspace(socket, workspaceId);

    const doc = new Y.Doc();
    const snapshot = await loadDoc(socket, workspaceId, docId);
    if (!snapshot.missing) {
      socket.disconnect();
      throw new Error("Document not found");
    }
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

    const prevSV = Y.encodeStateVector(doc);
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    const dbBlock = findBlockById(blocks, databaseBlockId);
    if (!dbBlock) {
      socket.disconnect();
      throw new Error(`Database block '${databaseBlockId}' not found`);
    }
    const dbFlavour = dbBlock.get("sys:flavour");
    if (dbFlavour !== "affine:database") {
      socket.disconnect();
      throw new Error(`Block '${databaseBlockId}' is not a database (flavour: ${dbFlavour})`);
    }

    const cellsMap = dbBlock.get("prop:cells") as Y.Map<any>;
    if (!(cellsMap instanceof Y.Map)) {
      socket.disconnect();
      throw new Error("Database block has no cells map");
    }

    const lookup = buildDatabaseColumnLookup(readColumnDefs(dbBlock));
    return {
      socket,
      doc,
      prevSV,
      blocks,
      dbBlock,
      cellsMap,
      ...lookup,
    };
  }

  // ADD DATABASE ROW
  const addDatabaseRowHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    databaseBlockId: string;
    cells: Record<string, unknown>;
    linkedDocId?: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      // Create a new paragraph block as the row child of the database
      const rowBlockId = generateId();
      const rowBlock = new Y.Map<any>();
      setSysFields(rowBlock, rowBlockId, "affine:paragraph");
      rowBlock.set("sys:parent", parsed.databaseBlockId);
      rowBlock.set("sys:children", new Y.Array<string>());
      rowBlock.set("prop:type", "text");
      if (parsed.linkedDocId) {
        rowBlock.set("prop:text", makeLinkedDocText(parsed.linkedDocId));
      } else {
        const titleValue = resolveDatabaseTitleValue(parsed.cells, ctx);
        rowBlock.set("prop:text", makeText(String(titleValue)));
      }
      ctx.blocks.set(rowBlockId, rowBlock);

      // Add row block to database's children
      const dbChildren = ensureChildrenArray(ctx.dbBlock);
      dbChildren.push([rowBlockId]);

      // Create row cell map
      const rowCells = ensureDatabaseRowCells(ctx.cellsMap, rowBlockId);
      for (const [key, value] of Object.entries(parsed.cells)) {
        const col = findDatabaseColumn(key, ctx);
        if (!col) {
          if (isTitleAliasKey(key)) {
            continue;
          }
          throw new Error(`Column '${key}' not found. Available columns: ${availableDatabaseColumns(ctx)}`);
        }

        writeDatabaseCellValue(rowCells, col, value, true);
      }

      const delta = Y.encodeStateAsUpdate(ctx.doc, ctx.prevSV);
      await pushDocUpdate(ctx.socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return text({
        added: true,
        rowBlockId,
        databaseBlockId: parsed.databaseBlockId,
        cellCount: Object.keys(parsed.cells).length,
        linkedDocId: parsed.linkedDocId || null,
      });
    } finally {
      ctx.socket.disconnect();
    }
  };
  server.registerTool(
    "add_database_row",
    {
      title: "Add Database Row",
      description: "Add a row to an AFFiNE database block. Provide cell values mapped by column name or column ID. Title column text is stored on the row paragraph block. Select columns auto-create options by label.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        databaseBlockId: z.string().min(1).describe("Block ID of the affine:database block"),
        cells: z.record(z.unknown()).describe("Map of column name (or column ID) to cell value. For select columns, pass the display label (option auto-created if new)."),
        linkedDocId: z.string().optional().describe("Link this row to an existing doc by ID. The row will open the linked doc in center peek when clicked."),
      },
    },
    addDatabaseRowHandler as any
  );

  const deleteDatabaseRowHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    databaseBlockId: string;
    rowBlockId: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      const rowBlock = getDatabaseRowBlock(ctx.blocks, ctx.dbBlock, parsed.databaseBlockId, parsed.rowBlockId);
      const descendantBlockIds = collectDescendantBlockIds(ctx.blocks, [parsed.rowBlockId, ...childIdsFrom(rowBlock.get("sys:children"))]);
      const dbChildren = ensureChildrenArray(ctx.dbBlock);
      const rowIndex = indexOfChild(dbChildren, parsed.rowBlockId);
      if (rowIndex < 0) {
        throw new Error(`Row block '${parsed.rowBlockId}' is not present in database '${parsed.databaseBlockId}' children`);
      }

      dbChildren.delete(rowIndex, 1);
      ctx.cellsMap.delete(parsed.rowBlockId);
      for (const blockId of descendantBlockIds) {
        ctx.blocks.delete(blockId);
      }

      const delta = Y.encodeStateAsUpdate(ctx.doc, ctx.prevSV);
      await pushDocUpdate(ctx.socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return text({
        deleted: true,
        rowBlockId: parsed.rowBlockId,
        databaseBlockId: parsed.databaseBlockId,
      });
    } finally {
      ctx.socket.disconnect();
    }
  };
  server.registerTool(
    "delete_database_row",
    {
      title: "Delete Database Row",
      description: "Delete a row from an AFFiNE database block.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        databaseBlockId: z.string().min(1).describe("Block ID of the affine:database block"),
        rowBlockId: z.string().min(1).describe("Row paragraph block ID to delete"),
      },
    },
    deleteDatabaseRowHandler as any
  );

  const readDatabaseCellsHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    databaseBlockId: string;
    rowBlockIds?: string[];
    columns?: string[];
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      const requestedRows = parsed.rowBlockIds?.length
        ? parsed.rowBlockIds
        : getDatabaseRowIds(ctx.dbBlock);

      const requestedColumns = parsed.columns?.length
        ? parsed.columns.map(columnKey => {
            const col = findDatabaseColumn(columnKey, ctx);
            if (!col) {
              throw new Error(`Column '${columnKey}' not found. Available columns: ${availableDatabaseColumns(ctx)}`);
            }
            return col;
          })
        : ctx.columnDefs;
      const requestedColumnIds = new Set(requestedColumns.map(col => col.id));

      const rows = requestedRows.map(rowBlockId => {
        const rowBlock = getDatabaseRowBlock(ctx.blocks, ctx.dbBlock, parsed.databaseBlockId, rowBlockId);
        const title = readDatabaseRowTitle(rowBlock) || null;
        const rowCells = ctx.cellsMap.get(rowBlockId);
        const cells: Record<string, Record<string, unknown>> = {};

        if (rowCells instanceof Y.Map) {
          for (const col of ctx.columnDefs) {
            if (ctx.titleCol && col.id === ctx.titleCol.id) {
              continue;
            }
            if (!requestedColumnIds.has(col.id)) {
              continue;
            }
            const cellEntry = rowCells.get(col.id);
            if (cellEntry === undefined) {
              continue;
            }
            cells[col.name || col.id] = decodeDatabaseCellValue(col, cellEntry);
          }
        }

        return {
          rowBlockId,
          title,
          linkedDocId: readLinkedDocId(rowBlock),
          cells,
        };
      });

      return text({ rows });
    } finally {
      ctx.socket.disconnect();
    }
  };
  server.registerTool(
    "read_database_cells",
    {
      title: "Read Database Cells",
      description: "Read row titles and database cell values from an AFFiNE database block.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        databaseBlockId: z.string().min(1).describe("Block ID of the affine:database block"),
        rowBlockIds: z.array(z.string().min(1)).optional().describe("Optional row block ID filter. Omit to return all rows."),
        columns: z.array(z.string().min(1)).optional().describe("Optional column name or ID filter."),
      },
    },
    readDatabaseCellsHandler as any
  );

  const readDatabaseColumnsHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    databaseBlockId: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      const columns = ctx.columnDefs.map(col => ({
        id: col.id,
        name: col.name || null,
        type: col.type,
        options: col.options,
      }));

      return text({
        databaseBlockId: parsed.databaseBlockId,
        title: richTextValueToString(ctx.dbBlock.get("prop:title")) || null,
        rowCount: getDatabaseRowIds(ctx.dbBlock).length,
        columnCount: columns.length,
        titleColumnId: ctx.titleCol?.id || null,
        columns,
        views: readDatabaseViewDefs(ctx.dbBlock, ctx),
      });
    } finally {
      ctx.socket.disconnect();
    }
  };
  server.registerTool(
    "read_database_columns",
    {
      title: "Read Database Columns",
      description: "Read schema metadata for an AFFiNE database block, including columns, select options, and view column mappings. Useful for empty databases before any rows exist.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        databaseBlockId: z.string().min(1).describe("Block ID of the affine:database block"),
      },
    },
    readDatabaseColumnsHandler as any
  );

  const updateDatabaseCellHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    databaseBlockId: string;
    rowBlockId: string;
    column: string;
    value: unknown;
    createOption?: boolean;
    linkedDocId?: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      const rowBlock = getDatabaseRowBlock(ctx.blocks, ctx.dbBlock, parsed.databaseBlockId, parsed.rowBlockId);
      const rowCells = ensureDatabaseRowCells(ctx.cellsMap, parsed.rowBlockId);
      const col = findDatabaseColumn(parsed.column, ctx);

      if (!col) {
        if (!isTitleAliasKey(parsed.column)) {
          throw new Error(`Column '${parsed.column}' not found. Available columns: ${availableDatabaseColumns(ctx)}`);
        }
      } else {
        writeDatabaseCellValue(rowCells, col, parsed.value, parsed.createOption ?? true);
      }

      if (parsed.linkedDocId) {
        rowBlock.set("prop:text", makeLinkedDocText(parsed.linkedDocId));
      } else if (isTitleAliasKey(parsed.column) || (col && (col.type === "title" || isTitleAliasKey(col.name)))) {
        rowBlock.set("prop:text", makeText(String(parsed.value ?? "")));
      }

      const delta = Y.encodeStateAsUpdate(ctx.doc, ctx.prevSV);
      await pushDocUpdate(ctx.socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return text({
        updated: true,
        rowBlockId: parsed.rowBlockId,
        column: parsed.column,
        value: parsed.value ?? null,
      });
    } finally {
      ctx.socket.disconnect();
    }
  };
  server.registerTool(
    "update_database_cell",
    {
      title: "Update Database Cell",
      description: "Update a single cell on an existing AFFiNE database row. Use `title` to update the row title shown in Kanban card headers.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        databaseBlockId: z.string().min(1).describe("Block ID of the affine:database block"),
        rowBlockId: z.string().min(1).describe("Row paragraph block ID"),
        column: z.string().min(1).describe("Column name or ID. Use `title` for the built-in row title."),
        value: z.unknown().describe("New cell value"),
        createOption: z.boolean().optional().describe("For select and multi-select columns, create the option label if it does not exist (default true)"),
        linkedDocId: z.string().optional().describe("Link this row to an existing doc by ID. Replaces any existing title with a linked doc reference."),
      },
    },
    updateDatabaseCellHandler as any
  );

  const updateDatabaseRowHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    databaseBlockId: string;
    rowBlockId: string;
    cells: Record<string, unknown>;
    createOption?: boolean;
    linkedDocId?: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      const rowBlock = getDatabaseRowBlock(ctx.blocks, ctx.dbBlock, parsed.databaseBlockId, parsed.rowBlockId);
      const rowCells = ensureDatabaseRowCells(ctx.cellsMap, parsed.rowBlockId);
      let titleValue: string | null = null;

      for (const [key, value] of Object.entries(parsed.cells)) {
        const col = findDatabaseColumn(key, ctx);
        if (!col) {
          if (isTitleAliasKey(key)) {
            titleValue = String(value ?? "");
            continue;
          }
          throw new Error(`Column '${key}' not found. Available columns: ${availableDatabaseColumns(ctx)}`);
        }

        writeDatabaseCellValue(rowCells, col, value, parsed.createOption ?? true);
        if (col.type === "title" || isTitleAliasKey(col.name)) {
          titleValue = String(value ?? "");
        }
      }

      if (parsed.linkedDocId) {
        rowBlock.set("prop:text", makeLinkedDocText(parsed.linkedDocId));
      } else if (titleValue !== null) {
        rowBlock.set("prop:text", makeText(titleValue));
      }

      const delta = Y.encodeStateAsUpdate(ctx.doc, ctx.prevSV);
      await pushDocUpdate(ctx.socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return text({
        updated: true,
        rowBlockId: parsed.rowBlockId,
        cellCount: Object.keys(parsed.cells).length,
      });
    } finally {
      ctx.socket.disconnect();
    }
  };
  server.registerTool(
    "update_database_row",
    {
      title: "Update Database Row",
      description: "Batch update multiple cells on an existing AFFiNE database row. Include `title` in the cells map to update the Kanban row title.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        databaseBlockId: z.string().min(1).describe("Block ID of the affine:database block"),
        rowBlockId: z.string().min(1).describe("Row paragraph block ID"),
        cells: z.record(z.unknown()).describe("Map of column name (or column ID) to new cell value. Use `title` for the built-in row title."),
        createOption: z.boolean().optional().describe("For select and multi-select columns, create the option label if it does not exist (default true)"),
        linkedDocId: z.string().optional().describe("Link this row to an existing doc by ID. The row will open the linked doc in center peek when clicked."),
      },
    },
    updateDatabaseRowHandler as any
  );

  const composeDatabaseFromIntentCore = async (parsed: {
    workspaceId?: string;
    docId: string;
    intent: DatabaseIntent;
    title?: string;
    seedRows?: DatabaseIntentSeedRow[];
    placement?: AppendPlacement;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required");
    }

    const preset = buildDatabaseIntentPreset(parsed.intent);
    const title = (parsed.title ?? preset.title).trim() || preset.title;
    const starterRows = Array.isArray(parsed.seedRows) ? parsed.seedRows : preset.starterRows;
    const creation = await appendBlockInternal({
      workspaceId,
      docId: parsed.docId,
      type: "data_view",
      viewMode: "kanban",
      text: title,
      placement: parsed.placement,
    });

    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, creation.blockId);
    try {
      const warnings: string[] = [];

      const statusLookup = buildDatabaseColumnLookup(readColumnDefs(ctx.dbBlock));
      const statusColumn = statusLookup.colByNameLower.get("status");
      if (statusColumn?.raw instanceof Y.Map) {
        replaceSelectColumnOptions(statusColumn.raw, preset.statusOptions);
      } else {
        warnings.push("Status column was not found after database creation.");
      }

      const addedColumnIds: string[] = [];
      for (const columnSpec of preset.extraColumns) {
        addedColumnIds.push(addDatabaseColumnToBlock(ctx.dbBlock, columnSpec));
      }

      const viewEntries = ctx.dbBlock.get("prop:views");
      if (viewEntries instanceof Y.Array) {
        const primaryView = viewEntries.get(0);
        if (primaryView instanceof Y.Map) {
          primaryView.set("name", preset.viewName);
        }
      }

      const rowBlockIds: string[] = [];
      for (const rowInput of starterRows) {
        rowBlockIds.push(addDatabaseRowToBlock({
          blocks: ctx.blocks,
          dbBlock: ctx.dbBlock,
          cellsMap: ctx.cellsMap,
          databaseBlockId: creation.blockId,
          lookup: buildDatabaseColumnLookup(readColumnDefs(ctx.dbBlock)),
          cells: rowInput,
        }));
      }

      const delta = Y.encodeStateAsUpdate(ctx.doc, ctx.prevSV);
      await pushDocUpdate(ctx.socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      const finalLookup = buildDatabaseColumnLookup(readColumnDefs(ctx.dbBlock));
      const finalViews = readDatabaseViewDefs(ctx.dbBlock, finalLookup);
      const columnSummary = finalLookup.columnDefs.map(column => ({
        id: column.id,
        name: column.name || null,
        type: column.type,
        options: column.options,
      }));

      return {
        workspaceId,
        docId: parsed.docId,
        intent: parsed.intent,
        title,
        databaseBlockId: creation.blockId,
        primaryViewId: finalViews[0]?.id || null,
        viewIds: finalViews.map(view => view.id),
        columnIds: finalLookup.columnDefs.map(column => column.id),
        rowBlockIds: getDatabaseRowIds(ctx.dbBlock),
        columns: columnSummary,
        views: finalViews,
        warnings: mergeWarnings(warnings),
        lossy: false,
        stats: {
          columnCount: columnSummary.length,
          viewCount: finalViews.length,
          rowCount: getDatabaseRowIds(ctx.dbBlock).length,
          addedColumnCount: addedColumnIds.length,
          seededRowCount: rowBlockIds.length,
        },
      };
    } finally {
      ctx.socket.disconnect();
    }
  };
  server.registerTool(
    "compose_database_from_intent",
    {
      title: "Compose Database From Intent",
      description: "Create a useful AFFiNE database/data-view from declarative intent. Supports task_board and issue_tracker presets with starter schema, kanban view, and optional starter rows.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        intent: DatabaseIntent.describe("Declarative database intent to compose."),
        title: z.string().optional().describe("Optional database title. Defaults to the intent preset title."),
        seedRows: z.array(z.record(z.unknown())).optional().describe("Optional starter rows. If omitted, the preset starter rows are used."),
        placement: z.object({
          parentId: z.string().optional(),
          afterBlockId: z.string().optional(),
          beforeBlockId: z.string().optional(),
          index: z.number().int().min(0).optional(),
        }).optional().describe("Optional insertion target/position"),
      },
    },
    async (parsed: {
      workspaceId?: string;
      docId: string;
      intent: DatabaseIntent;
      title?: string;
      seedRows?: DatabaseIntentSeedRow[];
      placement?: AppendPlacement;
    }) => text(await composeDatabaseFromIntentCore(parsed)) as any
  );

  // ADD DATABASE COLUMN
  const addDatabaseColumnHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    databaseBlockId: string;
    name: string;
    type: string;
    options?: string[];
    width?: number;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error("Document not found");
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;

      const dbBlock = findBlockById(blocks, parsed.databaseBlockId);
      if (!dbBlock) throw new Error(`Database block '${parsed.databaseBlockId}' not found`);
      if (dbBlock.get("sys:flavour") !== "affine:database") {
        throw new Error("Block is not a database");
      }

      const columns = dbBlock.get("prop:columns");
      if (!(columns instanceof Y.Array)) throw new Error("Database has no columns array");

      // Check for duplicate name
      const existingDefs = readColumnDefs(dbBlock);
      if (existingDefs.some(c => c.name === parsed.name)) {
        throw new Error(`Column '${parsed.name}' already exists`);
      }

      const columnId = generateId();
      const column = new Y.Map<any>();
      column.set("id", columnId);
      column.set("name", parsed.name);
      column.set("type", parsed.type || "rich-text");
      column.set("width", parsed.width || 200);

      // For select/multi-select, create options
      if ((parsed.type === "select" || parsed.type === "multi-select") && parsed.options?.length) {
        const data = new Y.Map<any>();
        const opts = new Y.Array<any>();
        for (let i = 0; i < parsed.options.length; i++) {
          const optMap = new Y.Map<any>();
          optMap.set("id", generateId());
          optMap.set("value", parsed.options[i]);
          optMap.set("color", SELECT_COLORS[i % SELECT_COLORS.length]);
          opts.push([optMap]);
        }
        data.set("options", opts);
        column.set("data", data);
      }

      columns.push([column]);

      // Also add the column to all existing views so it's visible
      const views = dbBlock.get("prop:views");
      if (views instanceof Y.Array) {
        views.forEach((view: any) => {
          if (view instanceof Y.Map) {
            const viewColumns = view.get("columns");
            if (viewColumns instanceof Y.Array) {
              const viewCol = new Y.Map<any>();
              viewCol.set("id", columnId);
              viewCol.set("hide", false);
              viewCol.set("width", parsed.width || 200);
              viewColumns.push([viewCol]);
            }
          }
        });
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"));

      return text({
        added: true,
        columnId,
        name: parsed.name,
        type: parsed.type || "rich-text",
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "add_database_column",
    {
      title: "Add Database Column",
      description: "Add a column to an existing AFFiNE database block. Supports rich-text, select, multi-select, number, checkbox, link, date types.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID containing the database"),
        databaseBlockId: z.string().min(1).describe("Block ID of the affine:database block"),
        name: z.string().min(1).describe("Column display name"),
        type: z.enum(["rich-text", "select", "multi-select", "number", "checkbox", "link", "date"]).default("rich-text").describe("Column type"),
        options: z.array(z.string()).optional().describe("Predefined options for select/multi-select columns"),
        width: z.number().optional().describe("Column width in pixels (default 200)"),
      },
    },
    addDatabaseColumnHandler as any
  );

  type SurfaceElementType = "shape" | "connector" | "text" | "group";

  type SurfaceElementFields = {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    shapeType?: "rect" | "ellipse" | "diamond" | "triangle";
    radius?: number;
    filled?: boolean;
    fillColor?: string;
    strokeColor?: string;
    strokeWidth?: number;
    strokeStyle?: "solid" | "dash" | "none";
    text?: string;
    color?: string;
    fontSize?: number;
    fontWeight?: string;
    sourceId?: string;
    targetId?: string;
    sourcePosition?: [number, number];
    targetPosition?: [number, number];
    mode?: number;
    frontEndpointStyle?: string;
    rearEndpointStyle?: string;
    stroke?: string;
    label?: string;
    children?: string[];
    title?: string;
    index?: string;
  };

  type AddSurfaceElementInput = SurfaceElementFields & {
    workspaceId?: string;
    docId: string;
    type: SurfaceElementType;
  };

  type UpdateSurfaceElementInput = SurfaceElementFields & {
    workspaceId?: string;
    docId: string;
    elementId: string;
  };

  type DeleteSurfaceElementInput = {
    workspaceId?: string;
    docId: string;
    elementId: string;
    pruneConnectors?: boolean;
  };

  type ListSurfaceElementsInput = {
    workspaceId?: string;
    docId: string;
    type?: SurfaceElementType;
    elementId?: string;
  };

  type GetEdgelessCanvasInput = {
    workspaceId?: string;
    docId: string;
  };

  function resolveSurfaceNewlines(s: string): string {
    return s.replace(/\\n/g, "\n");
  }

  function getSurfaceElementsValueMap(
    blocks: Y.Map<any>,
    options: { create: boolean }
  ): { surfaceId: string; value: Y.Map<any> } | null {
    let surfaceId = findBlockIdByFlavour(blocks, "affine:surface");
    if (!surfaceId) {
      if (!options.create) return null;
      surfaceId = ensureSurfaceBlock(blocks);
    }
    const surface = blocks.get(surfaceId) as Y.Map<any>;
    let elements = surface.get("prop:elements") as Y.Map<any> | undefined;
    if (!(elements instanceof Y.Map)) {
      if (!options.create) return null;
      elements = new Y.Map<any>();
      elements.set("type", "$blocksuite:internal:native$");
      elements.set("value", new Y.Map<any>());
      surface.set("prop:elements", elements);
    }
    let value = elements.get("value") as Y.Map<any> | undefined;
    if (!(value instanceof Y.Map)) {
      if (!options.create) return null;
      value = new Y.Map<any>();
      elements.set("value", value);
    }
    return { surfaceId, value };
  }

  function serializeSurfaceElement(elementId: string, el: Y.Map<any>): Record<string, any> {
    const out: Record<string, any> = { id: elementId };
    for (const [k, v] of el.entries()) {
      if (v instanceof Y.Text) {
        out[k] = v.toString();
      } else if (v instanceof Y.Map) {
        out[k] = v.toJSON();
      } else if (v instanceof Y.Array) {
        out[k] = v.toArray();
      } else {
        out[k] = v;
      }
    }
    const xywh = parseXywhString(out.xywh);
    if (xywh) out.bounds = xywh;
    return out;
  }

  function buildShapeElementData(
    elementId: string,
    seed: number,
    index: string,
    input: SurfaceElementFields
  ): Record<string, any> {
    const x = input.x ?? 0;
    const y = input.y ?? 0;
    const w = input.width ?? 100;
    const h = input.height ?? 100;
    const data: Record<string, any> = {
      type: "shape",
      id: elementId,
      index,
      seed,
      xywh: formatXywhString(x, y, w, h),
      rotate: 0,
      shapeType: input.shapeType ?? "rect",
      shapeStyle: "General",
      radius: input.radius ?? 0,
      filled: input.filled ?? true,
      fillColor: input.fillColor ?? "--affine-palette-shape-yellow",
      strokeWidth: input.strokeWidth ?? 2,
      strokeColor: input.strokeColor ?? "--affine-palette-line-yellow",
      strokeStyle: input.strokeStyle ?? "solid",
      roughness: 1.4,
      // Fixed #000000 matches BlockSuite's shape tool: shape fills don't
      // theme-adapt, so label color stays pinned too. Override for dark fills.
      color: input.color ?? "#000000",
      fontFamily: "blocksuite:surface:Inter",
      fontSize: input.fontSize ?? 20,
      fontStyle: "normal",
      fontWeight: input.fontWeight ?? "600",
      textAlign: "center",
      textHorizontalAlign: "center",
      textVerticalAlign: "center",
      textResizing: 1,
      maxWidth: false,
      padding: [10, 20],
      shadow: null,
    };
    if (input.text) {
      const yText = new Y.Text();
      yText.insert(0, resolveSurfaceNewlines(input.text));
      data.text = yText;
    }
    return data;
  }

  function resolveConnectorEndpointBoundAsBound(
    surfaceValueMap: Y.Map<any>,
    blocks: Y.Map<any>,
    endpointId: string | undefined
  ): Bound | null {
    if (!endpointId) return null;
    const surfaceEl = surfaceValueMap.get(endpointId);
    if (surfaceEl instanceof Y.Map) {
      const xywh = parseXywhString(surfaceEl.get("xywh"));
      if (xywh) return { x: xywh.x, y: xywh.y, w: xywh.width, h: xywh.height };
    }
    const block = blocks.get(endpointId);
    if (block instanceof Y.Map) {
      const xywh = parseXywhString(block.get("prop:xywh"));
      if (xywh) return { x: xywh.x, y: xywh.y, w: xywh.width, h: xywh.height };
    }
    return null;
  }

  function resolveChildBound(
    surfaceValueMap: Y.Map<any>,
    blocks: Y.Map<any>,
    id: string
  ): { kind: "surface" | "block" | "missing"; bound: Bound | null } {
    const surfaceEl = surfaceValueMap.get(id);
    if (surfaceEl instanceof Y.Map) {
      const xywh = parseXywhString(surfaceEl.get("xywh"));
      return {
        kind: "surface",
        bound: xywh ? { x: xywh.x, y: xywh.y, w: xywh.width, h: xywh.height } : null,
      };
    }
    const block = blocks.get(id);
    if (block instanceof Y.Map) {
      const xywh = parseXywhString(block.get("prop:xywh"));
      return {
        kind: "block",
        bound: xywh ? { x: xywh.x, y: xywh.y, w: xywh.width, h: xywh.height } : null,
      };
    }
    return { kind: "missing", bound: null };
  }

  function resolveConnectorEndpointCenter(
    surfaceValueMap: Y.Map<any>,
    blocks: Y.Map<any>,
    endpointId: string | undefined,
    endpointPosition: [number, number] | undefined
  ): { x: number; y: number } | null {
    if (endpointPosition && Array.isArray(endpointPosition) && endpointPosition.length === 2) {
      return { x: endpointPosition[0], y: endpointPosition[1] };
    }
    if (!endpointId) return null;
    const surfaceEl = surfaceValueMap.get(endpointId);
    if (surfaceEl instanceof Y.Map) {
      const xywh = parseXywhString(surfaceEl.get("xywh"));
      if (xywh) return { x: xywh.x + xywh.width / 2, y: xywh.y + xywh.height / 2 };
    }
    const block = blocks.get(endpointId);
    if (block instanceof Y.Map) {
      const xywh = parseXywhString(block.get("prop:xywh"));
      if (xywh) return { x: xywh.x + xywh.width / 2, y: xywh.y + xywh.height / 2 };
    }
    return null;
  }

  function buildConnectorElementData(
    elementId: string,
    seed: number,
    index: string,
    input: SurfaceElementFields
  ): Record<string, any> {
    const source: Record<string, any> = {};
    if (input.sourceId) {
      source.id = input.sourceId;
      if (input.sourcePosition) source.position = input.sourcePosition;
    } else if (input.sourcePosition) {
      source.position = input.sourcePosition;
    }
    const target: Record<string, any> = {};
    if (input.targetId) {
      target.id = input.targetId;
      if (input.targetPosition) target.position = input.targetPosition;
    } else if (input.targetPosition) {
      target.position = input.targetPosition;
    }
    const data: Record<string, any> = {
      type: "connector",
      id: elementId,
      index,
      seed,
      mode: input.mode ?? 2,
      // Theme-adaptive token so connectors stay legible in dark mode.
      stroke: input.stroke ?? "--affine-text-primary-color",
      strokeWidth: input.strokeWidth ?? 2,
      strokeStyle: input.strokeStyle ?? "solid",
      roughness: 1.4,
      frontEndpointStyle: input.frontEndpointStyle ?? "None",
      rearEndpointStyle: input.rearEndpointStyle ?? "Arrow",
      source,
      target,
      labelDisplay: true,
      labelOffset: { distance: 0.5, anchor: "center" },
      labelStyle: {
        color: "--affine-text-primary-color",
        fontFamily: "blocksuite:surface:Inter",
        fontSize: 16,
        fontStyle: "normal",
        fontWeight: "400",
        textAlign: "center",
      },
      labelConstraints: { hasMaxWidth: true, maxWidth: 280 },
    };
    if (input.label) {
      const yText = new Y.Text();
      yText.insert(0, resolveSurfaceNewlines(input.label));
      data.text = yText;
    }
    return data;
  }

  function buildTextElementData(
    elementId: string,
    seed: number,
    index: string,
    input: SurfaceElementFields
  ): Record<string, any> {
    const x = input.x ?? 0;
    const y = input.y ?? 0;
    const w = input.width ?? 200;
    const h = input.height ?? 30;
    const yText = new Y.Text();
    if (input.text) yText.insert(0, resolveSurfaceNewlines(input.text));
    return {
      type: "text",
      id: elementId,
      index,
      seed,
      xywh: formatXywhString(x, y, w, h),
      rotate: 0,
      text: yText,
      color: input.color ?? "--affine-text-primary-color",
      fontFamily: "blocksuite:surface:Inter",
      fontSize: input.fontSize ?? 16,
      fontStyle: "normal",
      fontWeight: input.fontWeight ?? "400",
      textAlign: "center",
      hasMaxWidth: false,
    };
  }

  function buildGroupElementData(
    elementId: string,
    seed: number,
    index: string,
    input: SurfaceElementFields
  ): Record<string, any> {
    const childMap = new Y.Map<boolean>();
    for (const childId of input.children ?? []) {
      childMap.set(childId, true);
    }
    const yTitle = new Y.Text();
    if (input.title) yTitle.insert(0, input.title);
    return {
      type: "group",
      id: elementId,
      index,
      seed,
      children: childMap,
      title: yTitle,
    };
  }

  function nextSurfaceElementIndex(valueMap: Y.Map<any>): string {
    let maxIndex: string | null = null;
    for (const [, el] of valueMap.entries()) {
      if (!(el instanceof Y.Map)) continue;
      const idx = el.get("index");
      if (typeof idx !== "string") continue;
      if (maxIndex === null || idx > maxIndex) maxIndex = idx;
    }
    return generateKeyBetween(maxIndex, null);
  }

  function buildSurfaceElementData(
    type: SurfaceElementType,
    index: string,
    input: SurfaceElementFields
  ): { elementId: string; data: Record<string, any> } {
    const elementId = generateId();
    const seed = Math.floor(Math.random() * 2 ** 31);
    switch (type) {
      case "shape":
        return { elementId, data: buildShapeElementData(elementId, seed, index, input) };
      case "connector":
        return { elementId, data: buildConnectorElementData(elementId, seed, index, input) };
      case "text":
        return { elementId, data: buildTextElementData(elementId, seed, index, input) };
      case "group":
        return { elementId, data: buildGroupElementData(elementId, seed, index, input) };
    }
  }

  function writeSurfaceElement(
    valueMap: Y.Map<any>,
    elementId: string,
    data: Record<string, any>
  ): void {
    const el = new Y.Map<any>();
    for (const [k, v] of Object.entries(data)) {
      el.set(k, v);
    }
    valueMap.set(elementId, el);
  }

  const addSurfaceElementHandler = async (params: AddSurfaceElementInput) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const ctx = getSurfaceElementsValueMap(blocks, { create: true })!;
      const index = params.index ?? nextSurfaceElementIndex(ctx.value);
      const { elementId, data } = buildSurfaceElementData(params.type, index, params);
      if (params.type === "connector") {
        const srcBounds = resolveConnectorEndpointBoundAsBound(ctx.value, blocks, params.sourceId);
        const tgtBounds = resolveConnectorEndpointBoundAsBound(ctx.value, blocks, params.targetId);

        // Auto-snap to the four tangent-carrying sides when the caller only
        // supplied ids — the renderer needs tangents to draw arrow heads.
        if (srcBounds && tgtBounds && !params.sourcePosition && !params.targetPosition) {
          const natural = pickConnectorSides(srcBounds, tgtBounds);
          data.source = { ...(data.source as any), position: SIDE_TO_NORMALIZED_POSITION[natural.from] };
          data.target = { ...(data.target as any), position: SIDE_TO_NORMALIZED_POSITION[natural.to] };
        }

        if (params.label) {
          const srcCenter = srcBounds
            ? { x: srcBounds.x + srcBounds.w / 2, y: srcBounds.y + srcBounds.h / 2 }
            : resolveConnectorEndpointCenter(ctx.value, blocks, params.sourceId, params.sourcePosition as [number, number] | undefined);
          const tgtCenter = tgtBounds
            ? { x: tgtBounds.x + tgtBounds.w / 2, y: tgtBounds.y + tgtBounds.h / 2 }
            : resolveConnectorEndpointCenter(ctx.value, blocks, params.targetId, params.targetPosition as [number, number] | undefined);
          const midpoint =
            srcCenter && tgtCenter
              ? { x: (srcCenter.x + tgtCenter.x) / 2, y: (srcCenter.y + tgtCenter.y) / 2 }
              : (srcCenter ?? tgtCenter);
          data.labelXYWH = estimateConnectorLabelXYWH(params.label, 16, midpoint, 280);
        }
      }
      writeSurfaceElement(ctx.value, elementId, data);
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(
        socket,
        workspaceId,
        params.docId,
        Buffer.from(delta).toString("base64")
      );
      return text({
        added: true,
        elementId,
        type: params.type,
        surfaceBlockId: ctx.surfaceId,
      });
    } finally {
      socket.disconnect();
    }
  };

  const listSurfaceElementsHandler = async (params: ListSurfaceElementsInput) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (!snapshot.missing) {
        return text({
          docId: params.docId,
          exists: false,
          surfaceBlockId: null,
          count: 0,
          elements: [],
        });
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const ctx = getSurfaceElementsValueMap(blocks, { create: false });
      if (!ctx) {
        return text({
          docId: params.docId,
          exists: true,
          surfaceBlockId: null,
          count: 0,
          elements: [],
        });
      }
      const elements: Record<string, any>[] = [];
      for (const [id, value] of ctx.value.entries()) {
        const entryId = String(id);
        if (params.elementId && entryId !== params.elementId) continue;
        if (!(value instanceof Y.Map)) continue;
        const serialized = serializeSurfaceElement(entryId, value);
        if (params.type && serialized.type !== params.type) continue;
        elements.push(serialized);
      }
      const sorted = sortByFractionalIndex(elements);
      return text({
        docId: params.docId,
        exists: true,
        surfaceBlockId: ctx.surfaceId,
        count: sorted.length,
        elements: sorted,
      });
    } finally {
      socket.disconnect();
    }
  };

  const updateSurfaceElementHandler = async (params: UpdateSurfaceElementInput) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (!snapshot.missing) {
        throw new Error(`Document '${params.docId}' not found or has no content.`);
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const ctx = getSurfaceElementsValueMap(blocks, { create: false });
      if (!ctx) throw new Error("Document has no surface elements to update.");
      const el = ctx.value.get(params.elementId);
      if (!(el instanceof Y.Map)) {
        throw new Error(`Surface element '${params.elementId}' not found.`);
      }

      const elementType = el.get("type");
      const changed: string[] = [];
      const ignored: string[] = [];

      const geomProvided =
        params.x !== undefined ||
        params.y !== undefined ||
        params.width !== undefined ||
        params.height !== undefined;
      if (geomProvided) {
        if (elementType === "shape" || elementType === "text") {
          const current = parseXywhString(el.get("xywh")) ?? {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
          };
          const nx = params.x ?? current.x;
          const ny = params.y ?? current.y;
          const nw = params.width ?? current.width;
          const nh = params.height ?? current.height;
          el.set("xywh", formatXywhString(nx, ny, nw, nh));
          changed.push("xywh");
        } else {
          if (params.x !== undefined) ignored.push("x");
          if (params.y !== undefined) ignored.push("y");
          if (params.width !== undefined) ignored.push("width");
          if (params.height !== undefined) ignored.push("height");
        }
      }

      const setYText = (key: string, value: string) => {
        const yText = new Y.Text();
        yText.insert(0, resolveSurfaceNewlines(value));
        el.set(key, yText);
        changed.push(key);
      };

      if (params.text !== undefined) {
        if (elementType === "shape" || elementType === "text" || elementType === "connector") {
          setYText("text", params.text);
        } else {
          ignored.push("text");
        }
      }
      if (params.label !== undefined) {
        if (elementType === "connector") {
          setYText("text", params.label);
        } else {
          ignored.push("label");
        }
      }
      if (params.title !== undefined) {
        if (elementType === "group") {
          setYText("title", params.title);
        } else {
          ignored.push("title");
        }
      }

      const scalarFields: Array<keyof SurfaceElementFields> = [
        "shapeType",
        "radius",
        "filled",
        "fillColor",
        "strokeColor",
        "strokeWidth",
        "strokeStyle",
        "color",
        "fontSize",
        "fontWeight",
      ];
      for (const k of scalarFields) {
        if (params[k] === undefined) continue;
        el.set(k as string, params[k]);
        changed.push(k as string);
      }

      if (params.index !== undefined) {
        el.set("index", params.index);
        changed.push("index");
      }

      if (params.sourceId !== undefined || params.sourcePosition !== undefined) {
        if (elementType === "connector") {
          const source: Record<string, any> = {};
          if (params.sourceId) source.id = params.sourceId;
          if (params.sourcePosition) source.position = params.sourcePosition;
          el.set("source", source);
          changed.push("source");
        } else {
          if (params.sourceId !== undefined) ignored.push("sourceId");
          if (params.sourcePosition !== undefined) ignored.push("sourcePosition");
        }
      }
      if (params.targetId !== undefined || params.targetPosition !== undefined) {
        if (elementType === "connector") {
          const target: Record<string, any> = {};
          if (params.targetId) target.id = params.targetId;
          if (params.targetPosition) target.position = params.targetPosition;
          el.set("target", target);
          changed.push("target");
        } else {
          if (params.targetId !== undefined) ignored.push("targetId");
          if (params.targetPosition !== undefined) ignored.push("targetPosition");
        }
      }
      if (params.mode !== undefined) {
        if (elementType === "connector") {
          el.set("mode", params.mode);
          changed.push("mode");
        } else {
          ignored.push("mode");
        }
      }
      if (params.frontEndpointStyle !== undefined) {
        if (elementType === "connector") {
          el.set("frontEndpointStyle", params.frontEndpointStyle);
          changed.push("frontEndpointStyle");
        } else {
          ignored.push("frontEndpointStyle");
        }
      }
      if (params.rearEndpointStyle !== undefined) {
        if (elementType === "connector") {
          el.set("rearEndpointStyle", params.rearEndpointStyle);
          changed.push("rearEndpointStyle");
        } else {
          ignored.push("rearEndpointStyle");
        }
      }
      if (params.stroke !== undefined) {
        if (elementType === "connector") {
          el.set("stroke", params.stroke);
          changed.push("stroke");
        } else {
          ignored.push("stroke");
        }
      }

      if (params.children !== undefined) {
        if (elementType === "group") {
          const childMap = new Y.Map<boolean>();
          for (const childId of params.children) childMap.set(childId, true);
          el.set("children", childMap);
          changed.push("children");
        } else {
          ignored.push("children");
        }
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(
        socket,
        workspaceId,
        params.docId,
        Buffer.from(delta).toString("base64")
      );
      return text({
        updated: changed.length > 0,
        elementId: params.elementId,
        type: typeof elementType === "string" ? elementType : null,
        changed,
        ignored,
      });
    } finally {
      socket.disconnect();
    }
  };

  const deleteSurfaceElementHandler = async (params: DeleteSurfaceElementInput) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (!snapshot.missing) {
        throw new Error(`Document '${params.docId}' not found or has no content.`);
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const ctx = getSurfaceElementsValueMap(blocks, { create: false });
      if (!ctx) {
        return text({
          deleted: false,
          elementId: params.elementId,
          reason: "no-surface",
          prunedConnectors: [],
        });
      }
      const existing = ctx.value.get(params.elementId);
      if (!(existing instanceof Y.Map)) {
        return text({
          deleted: false,
          elementId: params.elementId,
          reason: "not-found",
          prunedConnectors: [],
        });
      }
      ctx.value.delete(params.elementId);

      const prunedConnectors: string[] = [];
      if (params.pruneConnectors) {
        const toDelete: string[] = [];
        for (const [otherId, otherVal] of ctx.value.entries()) {
          if (!(otherVal instanceof Y.Map)) continue;
          if (otherVal.get("type") !== "connector") continue;
          const source = otherVal.get("source");
          const target = otherVal.get("target");
          const srcId =
            source && typeof source === "object" ? (source as any).id : undefined;
          const tgtId =
            target && typeof target === "object" ? (target as any).id : undefined;
          if (srcId === params.elementId || tgtId === params.elementId) {
            toDelete.push(String(otherId));
          }
        }
        for (const id of toDelete) {
          ctx.value.delete(id);
          prunedConnectors.push(id);
        }
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(
        socket,
        workspaceId,
        params.docId,
        Buffer.from(delta).toString("base64")
      );
      return text({ deleted: true, elementId: params.elementId, prunedConnectors });
    } finally {
      socket.disconnect();
    }
  };

  const updateFrameChildrenHandler = async (params: {
    workspaceId?: string;
    docId: string;
    blockId: string;
    childElementIds: string[];
    resizeToFit?: boolean;
    padding?: number;
  }) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (!snapshot.missing) {
        throw new Error(`Document '${params.docId}' not found or has no content.`);
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const frameBlock = blocks.get(params.blockId);
      if (!(frameBlock instanceof Y.Map) || frameBlock.get("sys:flavour") !== "affine:frame") {
        throw new Error(`Frame block '${params.blockId}' not found.`);
      }

      // All-missing is legit here: it's how callers clear ownership.
      const surfaceCtx = getSurfaceElementsValueMap(blocks, { create: false });
      const surfaceValueMap = surfaceCtx?.value ?? new Y.Map<any>();
      const ownedIds: string[] = [];
      const missing: string[] = [];
      const kids: Bound[] = [];
      for (const id of params.childElementIds) {
        const resolved = resolveChildBound(surfaceValueMap, blocks, id);
        if (resolved.kind === "missing") {
          missing.push(id);
        } else {
          ownedIds.push(id);
          if (resolved.bound) kids.push(resolved.bound);
        }
      }

      const childMap = new Y.Map<boolean>();
      for (const id of ownedIds) childMap.set(id, true);
      frameBlock.set("prop:childElementIds", childMap);

      // Resize-to-fit is default; skip on all-missing so clear-ownership
      // doesn't collapse the frame to zero.
      const resize = params.resizeToFit !== false;
      const padding = Number.isFinite(params.padding)
        ? Math.max(0, Math.floor(params.padding as number))
        : 40;
      let xywh: { x: number; y: number; width: number; height: number } | null = null;
      if (resize && kids.length > 0) {
        const wrapped = encloseBounds(kids, { padding, titleBand: 60 });
        if (wrapped) {
          xywh = { x: wrapped.x, y: wrapped.y, width: wrapped.w, height: wrapped.h };
          frameBlock.set("prop:xywh", formatXywhString(xywh.x, xywh.y, xywh.width, xywh.height));
        }
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(
        socket,
        workspaceId,
        params.docId,
        Buffer.from(delta).toString("base64")
      );
      return text({
        updated: true,
        blockId: params.blockId,
        flavour: "affine:frame",
        ownedIds,
        missing,
        resized: xywh !== null,
        ...(xywh ? { xywh } : {}),
      });
    } finally {
      socket.disconnect();
    }
  };

  const updateEdgelessBlockHandler = async (params: {
    workspaceId?: string;
    docId: string;
    blockId: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    background?: string | { light?: string; dark?: string };
  }) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (!snapshot.missing) {
        throw new Error(`Document '${params.docId}' not found or has no content.`);
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const block = blocks.get(params.blockId);
      if (!(block instanceof Y.Map)) {
        throw new Error(`Block '${params.blockId}' not found.`);
      }
      const flavour = block.get("sys:flavour");
      if (flavour !== "affine:note" && flavour !== "affine:frame" && flavour !== "affine:edgeless-text") {
        throw new Error(
          `Block '${params.blockId}' has flavour '${String(flavour)}' — update_edgeless_block only mutates note/frame/edgeless-text blocks.`
        );
      }

      const changed: string[] = [];
      const ignored: string[] = [];

      if (params.x !== undefined || params.y !== undefined || params.width !== undefined || params.height !== undefined) {
        const prev = parseXywhString(block.get("prop:xywh")) ?? { x: 0, y: 0, width: 0, height: 0 };
        block.set("prop:xywh", formatXywhString(
          params.x ?? prev.x,
          params.y ?? prev.y,
          params.width ?? prev.width,
          params.height ?? prev.height,
        ));
        changed.push("xywh");
      }

      if (params.background !== undefined) {
        if (flavour === "affine:edgeless-text") {
          ignored.push("background"); // edgeless-text has no prop:background
        } else {
          const bg = params.background;
          if (bg && typeof bg === "object" && !Array.isArray(bg) && ("light" in bg || "dark" in bg)) {
            const bgMap = new Y.Map<any>();
            if (typeof bg.light === "string") bgMap.set("light", bg.light);
            if (typeof bg.dark === "string") bgMap.set("dark", bg.dark);
            block.set("prop:background", bgMap);
          } else {
            block.set("prop:background", bg);
          }
          changed.push("background");
        }
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(
        socket,
        workspaceId,
        params.docId,
        Buffer.from(delta).toString("base64")
      );
      return text({ updated: changed.length > 0, blockId: params.blockId, flavour, changed, ignored });
    } finally {
      socket.disconnect();
    }
  };

  const deleteBlockHandler = async (params: {
    workspaceId?: string;
    docId: string;
    blockId: string;
    deleteChildren?: boolean;
    pruneConnectors?: boolean;
  }) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (!snapshot.missing) {
        throw new Error(`Document '${params.docId}' not found or has no content.`);
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const block = blocks.get(params.blockId);
      if (!(block instanceof Y.Map)) {
        return text({ deleted: false, blockId: params.blockId, reason: "not-found" });
      }

      const flavour = block.get("sys:flavour");
      if (flavour === "affine:page") {
        throw new Error(`Refusing to delete page-root block '${params.blockId}' — use delete_doc for whole-doc removal.`);
      }

      const deletedIds: string[] = [];
      const deleteRecursive = params.deleteChildren !== false;
      const walk = (id: string) => {
        const b = blocks.get(id);
        if (!(b instanceof Y.Map)) return;
        if (deleteRecursive) {
          const children = b.get("sys:children");
          if (children instanceof Y.Array) {
            for (const c of children.toArray()) {
              if (typeof c === "string") walk(c);
            }
          }
        }
        blocks.delete(id);
        deletedIds.push(id);
      };
      walk(params.blockId);

      for (const [, maybeParent] of blocks.entries()) {
        if (!(maybeParent instanceof Y.Map)) continue;
        const kids = maybeParent.get("sys:children");
        if (!(kids instanceof Y.Array)) continue;
        const arr = kids.toArray();
        for (let i = arr.length - 1; i >= 0; i--) {
          if (typeof arr[i] === "string" && deletedIds.includes(arr[i] as string)) {
            kids.delete(i, 1);
          }
        }
      }

      // Mirror delete_surface_element's pruneConnectors semantics.
      const prunedConnectors: string[] = [];
      if (params.pruneConnectors) {
        const ctx = getSurfaceElementsValueMap(blocks, { create: false });
        if (ctx) {
          const toDelete: string[] = [];
          for (const [otherId, otherVal] of ctx.value.entries()) {
            if (!(otherVal instanceof Y.Map)) continue;
            if (otherVal.get("type") !== "connector") continue;
            const source = otherVal.get("source");
            const target = otherVal.get("target");
            const srcId = source && typeof source === "object" ? (source as any).id : undefined;
            const tgtId = target && typeof target === "object" ? (target as any).id : undefined;
            if (
              (typeof srcId === "string" && deletedIds.includes(srcId)) ||
              (typeof tgtId === "string" && deletedIds.includes(tgtId))
            ) {
              toDelete.push(String(otherId));
            }
          }
          for (const id of toDelete) {
            ctx.value.delete(id);
            prunedConnectors.push(id);
          }
        }
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(
        socket,
        workspaceId,
        params.docId,
        Buffer.from(delta).toString("base64")
      );
      return text({ deleted: true, blockId: params.blockId, deletedIds, prunedConnectors });
    } finally {
      socket.disconnect();
    }
  };

  const getEdgelessCanvasHandler = async (params: GetEdgelessCanvasInput) => {
    const workspaceId = params.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }

    const { endpoint, cookie, bearer } = await getCookieAndEndpoint();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, params.docId);
      if (!snapshot.missing) {
        return text({
          docId: params.docId,
          exists: false,
          surfaceBlockId: null,
          edgelessBlocks: [],
          surfaceElements: [],
          bounds: null,
          elementCounts: { shape: 0, connector: 0, text: 0, group: 0 },
        });
      }
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;

      const edgelessFlavours = new Set([
        "affine:frame",
        "affine:edgeless-text",
        "affine:note",
      ]);

      const collectNoteText = (rootId: string): string[] => {
        const out: string[] = [];
        const seen = new Set<string>();
        const visit = (id: string) => {
          if (seen.has(id)) return;
          seen.add(id);
          const b = blocks.get(id);
          if (!(b instanceof Y.Map)) return;
          const t = asText(b.get("prop:text"));
          if (t) out.push(t);
          for (const childId of childIdsFrom(b.get("sys:children"))) {
            visit(childId);
          }
        };
        const root = blocks.get(rootId);
        if (root instanceof Y.Map) {
          for (const childId of childIdsFrom(root.get("sys:children"))) {
            visit(childId);
          }
        }
        return out;
      };

      // Structured tree rather than flat-joined text so markdown-seeded notes
      // round-trip with heading/paragraph/list structure intact.
      const collectNoteChildren = (rootId: string): Array<Record<string, any>> => {
        const result: Array<Record<string, any>> = [];
        const seen = new Set<string>();
        const visit = (id: string): Record<string, any> | null => {
          if (seen.has(id)) return null;
          seen.add(id);
          const b = blocks.get(id);
          if (!(b instanceof Y.Map)) return null;
          const childFlavour = b.get("sys:flavour");
          if (typeof childFlavour !== "string") return null;
          const entry: Record<string, any> = { id, flavour: childFlavour };
          const t = asText(b.get("prop:text"));
          if (t) entry.text = t;
          const propType = b.get("prop:type");
          if (typeof propType === "string") entry.type = propType;
          const checked = b.get("prop:checked");
          if (typeof checked === "boolean") entry.checked = checked;
          const language = b.get("prop:language");
          if (typeof language === "string" && language.length > 0) entry.language = language;
          const subChildren: Array<Record<string, any>> = [];
          for (const childId of childIdsFrom(b.get("sys:children"))) {
            const c = visit(childId);
            if (c) subChildren.push(c);
          }
          if (subChildren.length) entry.children = subChildren;
          return entry;
        };
        const root = blocks.get(rootId);
        if (root instanceof Y.Map) {
          for (const childId of childIdsFrom(root.get("sys:children"))) {
            const c = visit(childId);
            if (c) result.push(c);
          }
        }
        return result;
      };

      const edgelessBlocks: Record<string, any>[] = [];
      for (const [id, raw] of blocks.entries()) {
        if (!(raw instanceof Y.Map)) continue;
        const flavour = raw.get("sys:flavour");
        if (typeof flavour !== "string" || !edgelessFlavours.has(flavour)) continue;
        const xywhRaw = raw.get("prop:xywh");
        const bounds = parseXywhString(xywhRaw);
        const propIndex = raw.get("prop:index");
        const entry: Record<string, any> = {
          id: String(id),
          flavour,
          xywh: typeof xywhRaw === "string" ? xywhRaw : null,
          bounds,
          index: typeof propIndex === "string" ? propIndex : null,
        };
        if (flavour === "affine:frame") {
          entry.title = asText(raw.get("prop:title")) || null;
          const bg = raw.get("prop:background");
          entry.background = bg instanceof Y.Map ? bg.toJSON() : bg ?? null;
          const owned = raw.get("prop:childElementIds");
          entry.childElementIds = owned instanceof Y.Map ? Object.keys(owned.toJSON()) : [];
        } else if (flavour === "affine:edgeless-text") {
          const lines = collectNoteText(String(id));
          entry.text = lines.length ? lines.join("\n") : null;
          entry.color = raw.get("prop:color") ?? null;
        } else if (flavour === "affine:note") {
          const lines = collectNoteText(String(id));
          entry.text = lines.length ? lines.join("\n") : null;
          // `text` is the flat-join legacy view; `children` carries structure.
          entry.children = collectNoteChildren(String(id));
          entry.displayMode = raw.get("prop:displayMode") ?? null;
          const bg = raw.get("prop:background");
          entry.background = bg instanceof Y.Map ? bg.toJSON() : bg ?? null;
        }
        edgelessBlocks.push(entry);
      }

      const ctx = getSurfaceElementsValueMap(blocks, { create: false });
      const surfaceElements: Record<string, any>[] = [];
      const counts: Record<SurfaceElementType, number> = {
        shape: 0,
        connector: 0,
        text: 0,
        group: 0,
      };
      if (ctx) {
        for (const [elId, val] of ctx.value.entries()) {
          if (!(val instanceof Y.Map)) continue;
          const serialized = serializeSurfaceElement(String(elId), val);
          surfaceElements.push(serialized);
          const t = serialized.type as SurfaceElementType | undefined;
          if (t && t in counts) counts[t]++;
        }
      }
      const sortedSurfaceElements = sortByFractionalIndex(surfaceElements);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let hasAny = false;
      const include = (b: { x: number; y: number; width: number; height: number } | null | undefined) => {
        if (!b) return;
        hasAny = true;
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      };
      const sortedEdgelessBlocks = sortByFractionalIndex(edgelessBlocks);
      for (const eb of sortedEdgelessBlocks) include(eb.bounds);
      for (const se of sortedSurfaceElements) include(se.bounds);

      return text({
        docId: params.docId,
        exists: true,
        surfaceBlockId: ctx?.surfaceId ?? null,
        edgelessBlocks: sortedEdgelessBlocks,
        surfaceElements: sortedSurfaceElements,
        elementCounts: counts,
        bounds: hasAny
          ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
          : null,
      });
    } finally {
      socket.disconnect();
    }
  };

  const surfaceElementFieldSchemas = {
    x: z.number().optional().describe("X position on canvas (shape/text; default 0)."),
    y: z.number().optional().describe("Y position on canvas (shape/text; default 0)."),
    width: z.number().optional().describe("Width (shape default 100, text default 200)."),
    height: z.number().optional().describe("Height (shape default 100, text default 30)."),
    shapeType: z
      .enum(["rect", "ellipse", "diamond", "triangle"])
      .optional()
      .describe("Shape type (default rect). Shape only."),
    radius: z.number().optional().describe("Corner radius for rect (0.1 = rounded). Shape only."),
    filled: z.boolean().optional().describe("Whether shape is filled (default true). Shape only."),
    fillColor: z
      .string()
      .optional()
      .describe("Fill color. Prefer the `--affine-palette-shape-<color>` family (yellow/orange/red/magenta/purple/navy/blue/green/teal/grey/white/black). These are fixed colors — AFFiNE shape colors are not theme-adaptive by design. Shape only."),
    strokeColor: z.string().optional().describe("Stroke color. Prefer the `--affine-palette-line-<color>` family (same color names as fillColor). Fixed colors, not theme-adaptive. Shape only."),
    strokeWidth: z.number().optional().describe("Stroke width (default 2). Shape/connector."),
    strokeStyle: z
      .enum(["solid", "dash", "none"])
      .optional()
      .describe("Stroke style. Shape/connector."),
    text: z
      .string()
      .optional()
      .describe("Text content (shape/text) or connector label. Replaces existing Y.Text on update."),
    color: z.string().optional().describe("Text color. Shape default `#000000` — keep unless the fill is dark, then pass a contrasting hex. Canvas text default `--affine-text-primary-color` (theme-adaptive). Shape/text."),
    fontSize: z
      .number()
      .optional()
      .describe("Font size (shape default 20, text default 16). Shape/text."),
    fontWeight: z
      .string()
      .optional()
      .describe("Font weight (shape default 600, text default 400). Shape/text."),
    sourceId: z.string().optional().describe("Connector source element id. Connector only."),
    targetId: z.string().optional().describe("Connector target element id. Connector only."),
    sourcePosition: z
      .array(z.number())
      .length(2)
      .optional()
      .describe("Source [x,y]: relative [0-1] if sourceId set, absolute otherwise. Connector only."),
    targetPosition: z
      .array(z.number())
      .length(2)
      .optional()
      .describe("Target [x,y]: relative [0-1] if targetId set, absolute otherwise. Connector only. When both source/target are bound by id and neither position is provided, endpoints snap to the BlockSuite side-midpoint facing the other endpoint so connectors flow in a clear direction. Pass [0.5,0] top, [0.5,1] bottom, [0,0.5] left, [1,0.5] right to force a specific side."),
    mode: z
      .number()
      .optional()
      .describe("Connector mode: 0=straight, 1=orthogonal (elbow), 2=curve (default 2). Connector only."),
    frontEndpointStyle: z
      .enum(["None", "Arrow", "Triangle", "Circle", "Diamond"])
      .optional()
      .describe("Front endpoint style (default None). Connector only."),
    rearEndpointStyle: z
      .enum(["None", "Arrow", "Triangle", "Circle", "Diamond"])
      .optional()
      .describe("Rear endpoint style (default Arrow). Connector only."),
    stroke: z.string().optional().describe("Connector stroke color (default '--affine-text-primary-color' — theme-adaptive, near-black in light / near-white in dark). Accepts any CSS color or AFFiNE palette token. Connector only."),
    label: z.string().optional().describe("Connector label (stored as text on the connector). Connector only."),
    children: z.array(z.string()).optional().describe("Child element ids. Group only."),
    title: z.string().optional().describe("Group title. Group only."),
    index: z
      .string()
      .optional()
      .describe(
        "BlockSuite fractional-index string controlling z-order. On add, defaults to a key above every existing element's index (new elements render on top). On update, replaces the stored value — pass a key less than some existing index to send-to-back, or greater to bring-to-front. Use the value returned by list_surface_elements to pick a specific position."
      ),
  } as const;

  server.registerTool(
    "add_surface_element",
    {
      title: "Add Surface Element",
      description:
        "Add a shape, connector, text, or group to the AFFiNE edgeless canvas surface. Shapes support rect/ellipse/diamond/triangle with fill, stroke, and text. Connectors draw arrows between shapes (by id) or between absolute points. Use for building diagrams programmatically.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
        type: z.enum(["shape", "connector", "text", "group"]).describe("Element type"),
        ...surfaceElementFieldSchemas,
      },
    },
    addSurfaceElementHandler as any
  );

  server.registerTool(
    "list_surface_elements",
    {
      title: "List Surface Elements",
      description:
        "List all shape/connector/text/group elements on the AFFiNE edgeless canvas surface. Returns raw xywh strings plus parsed {x,y,width,height} bounds, with Y.Text fields serialized to plain strings. Optional filters by element type or id.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
        type: z
          .enum(["shape", "connector", "text", "group"])
          .optional()
          .describe("Filter by element type"),
        elementId: z.string().optional().describe("Filter to a single element id"),
      },
    },
    listSurfaceElementsHandler as any
  );

  server.registerTool(
    "update_surface_element",
    {
      title: "Update Surface Element",
      description:
        "Partially update a surface element by id. x/y/width/height merge with the element's current xywh (move without resizing, or vice versa). text/label/title replace their Y.Text wholesale. Fields that don't apply to the element's type are reported in the response 'ignored' list.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
        elementId: z.string().min(1).describe("Element ID to update"),
        ...surfaceElementFieldSchemas,
      },
    },
    updateSurfaceElementHandler as any
  );

  server.registerTool(
    "delete_surface_element",
    {
      title: "Delete Surface Element",
      description:
        "Delete a surface element by id. Set pruneConnectors=true to also delete any connectors whose source or target referenced the deleted element.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
        elementId: z.string().min(1).describe("Element ID to delete"),
        pruneConnectors: z
          .boolean()
          .optional()
          .describe("Also delete connectors referencing this element (default false)"),
      },
    },
    deleteSurfaceElementHandler as any
  );

  server.registerTool(
    "update_frame_children",
    {
      title: "Update Frame Children",
      description:
        "Replace a frame block's contents wholesale. Accepts ids of surface elements (shapes/connectors/groups) AND edgeless blocks (notes/frames/edgeless-text) — all go into BlockSuite's prop:childElementIds map, matching what the editor writes when you drag members into a frame. Dragging the frame drags every owned member. Ids that don't resolve come back under 'missing'. By default the frame is resized to fit its new contents (plus padding + title band); set resizeToFit=false to leave xywh untouched. Pass `[]` to clear ownership (resize is skipped in that case).",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
        blockId: z.string().min(1).describe("Frame block id (flavour affine:frame)."),
        childElementIds: z
          .array(z.string())
          .describe("Full list of ids the frame should own/contain. Replaces any existing ownership."),
        resizeToFit: z
          .boolean()
          .optional()
          .describe("If true (default), recompute xywh from the union of resolvable child bounds + padding + title band. Set to false to preserve the frame's current box (useful when you want ownership-only edits or manual positioning)."),
        padding: z
          .number()
          .int()
          .optional()
          .describe("Padding (px) used when resizeToFit is true (default 40). Ignored when resizeToFit=false."),
      },
    },
    updateFrameChildrenHandler as any
  );

  server.registerTool(
    "update_edgeless_block",
    {
      title: "Update Edgeless Block",
      description:
        "Partially update a note/frame/edgeless-text block by id. x/y/width/height merge with current prop:xywh (move without resizing, or vice versa). background replaces prop:background (AFFiNE token or `{light, dark}` hex object). Fields that don't apply to the block's flavour come back under `ignored`.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
        blockId: z.string().min(1).describe("Block id (flavour affine:note/affine:frame/affine:edgeless-text)."),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        background: z
          .union([
            z.string(),
            z.object({ light: z.string().optional(), dark: z.string().optional() }),
          ])
          .optional()
          .describe("Note/frame only. Prefer `--affine-note-background-<color>` or `{light, dark}` hex."),
      },
    },
    updateEdgelessBlockHandler as any
  );

  server.registerTool(
    "delete_block",
    {
      title: "Delete Block",
      description:
        "Delete a block by id. Removes descendants and unlinks from the parent's sys:children by default; set deleteChildren=false to keep descendants orphaned (for re-parenting), or pruneConnectors=true to also drop surface connectors referencing any deleted id. Refuses affine:page — use delete_doc for whole docs.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
        blockId: z.string().min(1).describe("Block id to delete."),
        deleteChildren: z.boolean().optional().describe("Also delete descendants (default true)."),
        pruneConnectors: z.boolean().optional().describe("Also delete connectors bound to any deleted id (default false)."),
      },
    },
    deleteBlockHandler as any
  );

  server.registerTool(
    "get_edgeless_canvas",
    {
      title: "Get Edgeless Canvas",
      description:
        "Read the full edgeless canvas: all edgeless-positioned blocks (notes, frames, edgeless-text) with their xywh, plus all surface elements (shapes, connectors, text, groups). Includes aggregate bounding box and per-type element counts. Use this when you need to understand canvas layout end-to-end before placing new elements.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace ID (optional if default set)"),
        docId: DocId.describe("Document ID"),
      },
    },
    getEdgelessCanvasHandler as any
  );
}
