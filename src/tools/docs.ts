import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, deleteDoc as wsDeleteDoc } from "../ws.js";
import * as Y from "yjs";
import { parseMarkdownToOperations } from "../markdown/parse.js";
import { renderBlocksToMarkdown } from "../markdown/render.js";
import type { MarkdownOperation, MarkdownRenderableBlock } from "../markdown/types.js";

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
  tableData?: string[][];
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
  width: number;
  height: number;
  background: string;
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
};

type CreateDocInput = {
  workspaceId?: string;
  title?: string;
  content?: string;
};

type CreateDocResult = {
  workspaceId: string;
  docId: string;
  title: string;
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

  function makeText(content: string): Y.Text {
    const yText = new Y.Text();
    if (content.length > 0) {
      yText.insert(0, content);
    }
    return yText;
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

    const noteId = generateId();
    const note = new Y.Map<any>();
    setSysFields(note, noteId, "affine:note");
    note.set("sys:parent", null);
    note.set("sys:children", new Y.Array<string>());
    note.set("prop:xywh", "[0,0,800,95]");
    note.set("prop:index", "a0");
    note.set("prop:hidden", false);
    note.set("prop:displayMode", "both");
    const background = new Y.Map<any>();
    background.set("light", "#ffffff");
    background.set("dark", "#252525");
    note.set("prop:background", background);
    blocks.set(noteId, note);

    const page = blocks.get(pageId) as Y.Map<any>;
    let pageChildren = page.get("sys:children") as Y.Array<string> | undefined;
    if (!(pageChildren instanceof Y.Array)) {
      pageChildren = new Y.Array<string>();
      page.set("sys:children", pageChildren);
    }
    pageChildren.push([noteId]);
    return noteId;
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
    const width = Number.isFinite(parsed.width) ? Math.max(1, Math.floor(parsed.width as number)) : 100;
    const height = Number.isFinite(parsed.height) ? Math.max(1, Math.floor(parsed.height as number)) : 100;
    const background = (parsed.background ?? "transparent").trim() || "transparent";
    const sourceId = (parsed.sourceId ?? "").trim();
    const name = (parsed.name ?? "attachment").trim() || "attachment";
    const mimeType = (parsed.mimeType ?? "application/octet-stream").trim() || "application/octet-stream";
    const size = Number.isFinite(parsed.size) ? Math.max(0, Math.floor(parsed.size as number)) : 0;
    const rows = Number.isInteger(parsed.rows) ? (parsed.rows as number) : 3;
    const columns = Number.isInteger(parsed.columns) ? (parsed.columns as number) : 3;
    const latex = (parsed.latex ?? "").trim();
    const tableData = Array.isArray(parsed.tableData) ? parsed.tableData : undefined;

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
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:paragraph", blockType };
      }
      case "list": {
        setSysFields(block, blockId, "affine:list");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:type", normalized.listStyle);
        block.set("prop:checked", normalized.listStyle === "todo" ? normalized.checked : false);
        block.set("prop:text", makeText(content));
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
        textBlock.set("prop:text", makeText(content));
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
        const rows: Record<string, { rowId: string; order: string; backgroundColor?: string }> = {};
        const columns: Record<string, { columnId: string; order: string; backgroundColor?: string; width?: number }> = {};
        const cells: Record<string, { text: string }> = {};
        const rowIds: string[] = [];
        const columnIds: string[] = [];
        const tableData = normalized.tableData ?? [];

        for (let i = 0; i < normalized.rows; i++) {
          const rowId = generateId();
          rows[rowId] = { rowId, order: `r${String(i).padStart(4, "0")}` };
          rowIds.push(rowId);
        }
        for (let i = 0; i < normalized.columns; i++) {
          const columnId = generateId();
          columns[columnId] = { columnId, order: `c${String(i).padStart(4, "0")}` };
          columnIds.push(columnId);
        }
        for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex += 1) {
          const rowId = rowIds[rowIndex];
          for (let columnIndex = 0; columnIndex < columnIds.length; columnIndex += 1) {
            const columnId = columnIds[columnIndex];
            const cellText = tableData[rowIndex]?.[columnIndex] ?? "";
            cells[`${rowId}:${columnId}`] = { text: cellText };
          }
        }

        block.set("prop:rows", rows);
        block.set("prop:columns", columns);
        block.set("prop:cells", cells);
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
        block.set("prop:background", normalized.background);
        block.set("prop:xywh", `[0,0,${normalized.width},${normalized.height}]`);
        block.set("prop:index", "a0");
        block.set("prop:childElementIds", new Y.Map<any>());
        block.set("prop:presentationIndex", "a0");
        block.set("prop:lockedBySelf", false);
        return { blockId, block, flavour: "affine:frame" };
      }
      case "edgeless_text": {
        setSysFields(block, blockId, "affine:edgeless-text");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:xywh", `[0,0,${normalized.width},${normalized.height}]`);
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:scale", 1);
        block.set("prop:rotate", 0);
        block.set("prop:hasMaxWidth", false);
        block.set("prop:comments", undefined);
        block.set("prop:color", "black");
        block.set("prop:fontFamily", "Inter");
        block.set("prop:fontStyle", "normal");
        block.set("prop:fontWeight", "regular");
        block.set("prop:textAlign", "left");
        return { blockId, block, flavour: "affine:edgeless-text" };
      }
      case "note": {
        setSysFields(block, blockId, "affine:note");
        block.set("sys:parent", null);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:xywh", `[0,0,${normalized.width},${normalized.height}]`);
        block.set("prop:background", normalized.background);
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
        return { blockId, block, flavour: "affine:note" };
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

      return { appended: true, blockId, flavour, blockType, normalizedType: normalized.type, legacyType: normalized.legacyType || null };
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
          strict,
          placement,
        };
      case "paragraph":
        return {
          workspaceId,
          docId,
          type: "paragraph",
          text: operation.text,
          strict,
          placement,
        };
      case "quote":
        return {
          workspaceId,
          docId,
          type: "quote",
          text: operation.text,
          strict,
          placement,
        };
      case "callout":
        return {
          workspaceId,
          docId,
          type: "callout",
          text: operation.text,
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

    const rowEntries = mapEntries(rowsValue)
      .map(([rowId, payload]) => ({
        rowId,
        order:
          payload && typeof payload === "object" && typeof (payload as any).order === "string"
            ? (payload as any).order
            : rowId,
      }))
      .sort((a, b) => a.order.localeCompare(b.order));

    const columnEntries = mapEntries(columnsValue)
      .map(([columnId, payload]) => ({
        columnId,
        order:
          payload && typeof payload === "object" && typeof (payload as any).order === "string"
            ? (payload as any).order
            : columnId,
      }))
      .sort((a, b) => a.order.localeCompare(b.order));

    if (rowEntries.length === 0 || columnEntries.length === 0) {
      return null;
    }

    const cells = new Map<string, string>();
    for (const [cellKey, payload] of mapEntries(cellsValue)) {
      if (payload instanceof Y.Map) {
        cells.set(cellKey, richTextValueToString(payload.get("text")));
        continue;
      }
      if (payload && typeof payload === "object" && "text" in payload) {
        cells.set(cellKey, richTextValueToString((payload as any).text));
      }
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
      note.set("prop:xywh", "[0,0,800,95]");
      note.set("prop:index", "a0");
      note.set("prop:hidden", false);
      const background = new Y.Map<any>();
      background.set("light", "#ffffff");
      background.set("dark", "#252525");
      note.set("prop:background", background);
      const noteChildren = new Y.Array();
      note.set("sys:children", noteChildren);
      blocks.set(noteId, note);
      children.push([noteId]);

      if (parsed.content) {
        const paraId = generateId();
        const para = new Y.Map();
        setSysFields(para, paraId, "affine:paragraph");
        para.set("sys:parent", null);
        para.set("sys:children", new Y.Array());
        para.set("prop:type", "text");
        const paragraphText = new Y.Text();
        paragraphText.insert(0, parsed.content);
        para.set("prop:text", paragraphText);
        blocks.set(paraId, para);
        noteChildren.push([paraId]);
      }

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

      return { workspaceId, docId, title };
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
            const { byId } = getWorkspaceTagOptionMaps(meta);
            for (const page of pages) {
              const tagEntries = getStringArray(page.tagsArray);
              tagsByDocId.set(page.id, resolveTagLabels(tagEntries, byId));
            }
          }
        } finally {
          socket.disconnect();
        }
      } catch {
        // Keep list_docs available even when workspace snapshot fetch fails.
      }

      const mergedDocs = {
        ...docs,
        edges: Array.isArray(docs?.edges)
          ? docs.edges.map((edge: any) => {
              const node = edge?.node;
              if (!node || typeof node.id !== "string") {
                return edge;
              }
              return {
                ...edge,
                node: {
                  ...node,
                  tags: tagsByDocId.get(node.id) || [],
                },
              };
            })
          : [],
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

  const readDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
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

      return text({
        docId: parsed.docId,
        title: title || null,
        tags,
        exists: true,
        blockCount: blockRows.length,
        blocks: blockRows,
        plainText: plainTextLines.join("\n"),
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "read_doc",
    {
      title: "Read Document Content",
      description: "Read document block content via WebSocket snapshot (blocks + plain text).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
      },
    },
    readDocHandler as any
  );

  const publishDocHandler = async (parsed: { workspaceId?: string; docId: string; mode?: "Page" | "Edgeless" }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const mutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
      const data = await gql.request<{ publishDoc: any }>(mutation, { workspaceId, docId: parsed.docId, mode: parsed.mode });
      return text(data.publishDoc);
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
      return text(data.revokePublicDoc);
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
  const createDocHandler = async (parsed: { workspaceId?: string; title?: string; content?: string }) => {
    const created = await createDocInternal(parsed);
    return text({ docId: created.docId, title: created.title });
  };
  server.registerTool(
    'create_doc',
    {
      title: 'Create Document',
      description: 'Create a new AFFiNE document with optional content',
      inputSchema: {
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
      },
    },
    createDocHandler as any
  );

  // APPEND PARAGRAPH
  const appendParagraphHandler = async (parsed: { workspaceId?: string; docId: string; text: string }) => {
    const result = await appendBlockInternal({
      workspaceId: parsed.workspaceId,
      docId: parsed.docId,
      type: "paragraph",
      text: parsed.text,
    });
    return text({ appended: result.appended, paragraphId: result.blockId });
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
  }) => {
    const result = await appendBlockInternal(parsed);
    return text({
      appended: result.appended,
      blockId: result.blockId,
      flavour: result.flavour,
      type: result.blockType || null,
      normalizedType: result.normalizedType,
      legacyType: result.legacyType,
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
        width: z.number().int().min(1).max(10000).optional().describe("Width for frame/edgeless_text/note"),
        height: z.number().int().min(1).max(10000).optional().describe("Height for frame/edgeless_text/note"),
        background: z.string().optional().describe("Background for frame/note"),
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

  const createDocFromMarkdownHandler = async (parsed: {
    workspaceId?: string;
    title?: string;
    markdown: string;
    strict?: boolean;
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

    const applyWarnings =
      applied.skippedCount > 0
        ? [`${applied.skippedCount} markdown block(s) could not be applied to AFFiNE and were skipped.`]
        : [];

    return text({
      workspaceId: created.workspaceId,
      docId: created.docId,
      title: created.title,
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
    "create_doc_from_markdown",
    {
      title: "Create Document From Markdown",
      description: "Create a new AFFiNE document and import markdown content.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        title: z.string().optional(),
        markdown: MarkdownContent.describe("Markdown content to import"),
        strict: z.boolean().optional(),
      },
    },
    createDocFromMarkdownHandler as any
  );


  // ─── list_children ──────────────────────────────────────────────────────────
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
            url: `${(process.env.AFFINE_BASE_URL || "").replace(/\/$/, "")}/workspace/${workspaceId}/${pageId}` });
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
      return text({ updated: true, docId: parsed.docId, title: newTitle });
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
          url: `${(process.env.AFFINE_BASE_URL || "").replace(/\/$/, "")}/workspace/${workspaceId}/${match.id}` });
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
              url: `${(process.env.AFFINE_BASE_URL || "").replace(/\/$/, "")}/workspace/${workspaceId}/${page.id}` });
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
      const r = await createDocFromMarkdownHandler({ workspaceId, title: newTitle, markdown: rendered.markdown });
      const created = JSON.parse((r as any).content[0].text);
      let linkedToParent = false;
      if (parsed.parentDocId && created.docId) {
        try {
          await appendBlockInternal({ workspaceId, docId: parsed.parentDocId, type: "embed_linked_doc", pageId: created.docId });
          linkedToParent = true;
        } catch { /* non-fatal */ }
      }
      return text({ sourceDocId: parsed.docId, docId: created.docId, title: created.title, linkedToParent, warnings: created.warnings ?? [] });
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
      search: z.string().describe("Text to find."),
      replace: z.string().describe("Replacement text."),
      matchAll: z.boolean().optional().describe("Replace all occurrences (default: true)."),
      dryRun: z.boolean().optional().describe("If true, only report matches without replacing (default: false)."),
    },
  }, findAndReplaceHandler as any);

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

    return text({
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

    return text({
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
      return text({ deleted: true });
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

  function getDatabaseRowBlock(
    blocks: Y.Map<any>,
    databaseBlockId: string,
    rowBlockId: string,
  ): Y.Map<any> {
    const rowBlock = findBlockById(blocks, rowBlockId);
    if (!rowBlock) {
      throw new Error(`Row block '${rowBlockId}' not found`);
    }
    if (rowBlock.get("sys:parent") !== databaseBlockId) {
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
      const titleValue = resolveDatabaseTitleValue(parsed.cells, ctx);
      rowBlock.set("prop:text", makeText(String(titleValue)));
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
      },
    },
    addDatabaseRowHandler as any
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
        const rowBlock = getDatabaseRowBlock(ctx.blocks, parsed.databaseBlockId, rowBlockId);
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
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      const rowBlock = getDatabaseRowBlock(ctx.blocks, parsed.databaseBlockId, parsed.rowBlockId);
      const rowCells = ensureDatabaseRowCells(ctx.cellsMap, parsed.rowBlockId);
      const col = findDatabaseColumn(parsed.column, ctx);

      if (!col) {
        if (!isTitleAliasKey(parsed.column)) {
          throw new Error(`Column '${parsed.column}' not found. Available columns: ${availableDatabaseColumns(ctx)}`);
        }
      } else {
        writeDatabaseCellValue(rowCells, col, parsed.value, parsed.createOption ?? true);
      }

      if (isTitleAliasKey(parsed.column) || (col && (col.type === "title" || isTitleAliasKey(col.name)))) {
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
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const ctx = await loadDatabaseDocContext(workspaceId, parsed.docId, parsed.databaseBlockId);
    try {
      const rowBlock = getDatabaseRowBlock(ctx.blocks, parsed.databaseBlockId, parsed.rowBlockId);
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

      if (titleValue !== null) {
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
      },
    },
    updateDatabaseRowHandler as any
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
}
