import { randomBytes } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as Y from "yjs";
import { generateKeyBetween } from "fractional-indexing";

import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import {
  connectWorkspaceSocket,
  joinWorkspace,
  loadDoc,
  pushDocUpdate,
  wsUrlFromGraphQLEndpoint,
} from "../ws.js";

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");
const CollectionId = z.string().min(1, "collectionId required");
const FolderId = z.string().min(1, "folderId required");
const OrganizeNodeId = z.string().min(1, "nodeId required");
const FolderName = z.string().trim().min(1, "name required");
const CollectionRuleFieldSchema = z.enum(["title", "tag", "docId"]);
const CollectionRuleOperatorSchema = z.enum(["contains", "equals", "startsWith", "in"]);
const CollectionRuleSchema = z.object({
  field: CollectionRuleFieldSchema,
  operator: CollectionRuleOperatorSchema,
  value: z.union([z.string(), z.array(z.string())]),
});
const CollectionRulesSchema = z.object({
  match: z.enum(["all", "any"]).optional(),
  filters: z.array(CollectionRuleSchema),
});

type CollectionInfo = {
  id: string;
  name: string;
  rules: {
    match: "all" | "any";
    filters: CollectionRuleFilter[];
  };
  allowList: string[];
};

type CollectionRuleField = "title" | "tag" | "docId";
type CollectionRuleOperator = "contains" | "equals" | "startsWith" | "in";
type CollectionRuleFilter = {
  field: CollectionRuleField;
  operator: CollectionRuleOperator;
  value: string | string[];
};

type WorkspaceTagOption = {
  id: string;
  value: string;
};

type WorkspaceDocSummary = {
  id: string;
  title: string | null;
  tags: string[];
  createDate: number | null;
  updatedDate: number | null;
};

type OrganizeNodeRecord = {
  id: string;
  parentId: string | null;
  type: "folder" | "doc" | "tag" | "collection";
  data: string;
  index: string;
};

function generateId(length = 21): string {
  const chars = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

function hasSamePrefix(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

// Adapted from AFFiNE's packages/common/infra/src/utils/fractional-indexing.ts
function generateFractionalIndexingKeyBetween(
  a: string | null,
  b: string | null
): string {
  const randomSize = 32;

  function postfix(length = randomSize): string {
    const chars = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const values = randomBytes(length);
    let result = "";
    for (let i = 0; i < length; i += 1) {
      result += chars[values[i]! % chars.length];
    }
    return result;
  }

  function subkey(key: string | null): string | null {
    if (key === null) {
      return null;
    }
    if (key.length <= randomSize + 1) {
      return key;
    }
    return key.substring(0, key.length - randomSize - 1);
  }

  const aSubkey = subkey(a);
  const bSubkey = subkey(b);

  if (aSubkey === null && bSubkey === null) {
    return generateKeyBetween(null, null) + "0" + postfix();
  }
  if (aSubkey === null && bSubkey !== null) {
    return generateKeyBetween(null, bSubkey) + "0" + postfix();
  }
  if (bSubkey === null && aSubkey !== null) {
    return generateKeyBetween(aSubkey, null) + "0" + postfix();
  }
  if (aSubkey !== null && bSubkey !== null) {
    if (hasSamePrefix(aSubkey, bSubkey) && a !== null && b !== null) {
      return generateKeyBetween(a, b) + "0" + postfix();
    }
    return generateKeyBetween(aSubkey, bSubkey) + "0" + postfix();
  }
  throw new Error("Unreachable fractional indexing state");
}

function normalizeCollection(value: unknown): CollectionInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const collection = value as Record<string, unknown>;
  if (typeof collection.id !== "string" || typeof collection.name !== "string") {
    return null;
  }
  const allowList = Array.isArray(collection.allowList)
    ? collection.allowList.filter((entry): entry is string => typeof entry === "string")
    : [];
  const rules = normalizeCollectionRules(collection.rules);

  return {
    id: collection.id,
    name: collection.name,
    rules,
    allowList,
  };
}

function normalizeOrganizeNode(value: unknown): OrganizeNodeRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.data !== "string" ||
    typeof raw.index !== "string"
  ) {
    return null;
  }
  if (!["folder", "doc", "tag", "collection"].includes(raw.type)) {
    return null;
  }
  return {
    id: raw.id,
    parentId:
      raw.parentId === null || typeof raw.parentId === "string" ? (raw.parentId as string | null) : null,
    type: raw.type as OrganizeNodeRecord["type"],
    data: raw.data,
    index: raw.index,
  };
}

function specialWorkspaceDbDocId(workspaceId: string, tableName: string): string {
  return `db$${workspaceId}$${tableName}`;
}

function isDeletedRecord(record: Y.Map<any>): boolean {
  return record.get("$$DELETED") === true || record.size === 0;
}

function ensureRecord(doc: Y.Doc, id: string): Y.Map<any> {
  return doc.getMap(id);
}

function deleteRecord(record: Y.Map<any>, keepId = true): void {
  const keys = Array.from(record.keys());
  for (const key of keys) {
    if (keepId && key === "id") {
      continue;
    }
    record.delete(key);
  }
  record.set("$$DELETED", true);
}

function readCollections(array: Y.Array<any>): CollectionInfo[] {
  const collections: CollectionInfo[] = [];
  for (let i = 0; i < array.length; i += 1) {
    const normalized = normalizeCollection(array.get(i));
    if (normalized) {
      collections.push(normalized);
    }
  }
  return collections;
}

function findCollectionIndex(array: Y.Array<any>, id: string): number {
  for (let i = 0; i < array.length; i += 1) {
    const normalized = normalizeCollection(array.get(i));
    if (normalized?.id === id) {
      return i;
    }
  }
  return -1;
}

function readOrganizeNodes(doc: Y.Doc): OrganizeNodeRecord[] {
  const nodes: OrganizeNodeRecord[] = [];
  for (const key of doc.share.keys()) {
    if (!doc.share.has(key)) {
      continue;
    }
    const record = doc.getMap(key);
    if (!(record instanceof Y.Map) || isDeletedRecord(record)) {
      continue;
    }
    const normalized = normalizeOrganizeNode(record.toJSON());
    if (normalized) {
      nodes.push(normalized);
    }
  }
  return nodes;
}

function organizeNodeMap(nodes: OrganizeNodeRecord[]): Map<string, OrganizeNodeRecord> {
  return new Map(nodes.map(node => [node.id, node] as const));
}

function getYMap(target: Y.Map<any>, key: string): Y.Map<any> | null {
  const value = target.get(key);
  return value instanceof Y.Map ? value : null;
}

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

function getTagArray(target: Y.Map<any>, key = "tags"): Y.Array<string> | null {
  const value = target.get(key);
  return value instanceof Y.Array ? (value as Y.Array<string>) : null;
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
  return options instanceof Y.Array ? options : null;
}

function getWorkspaceTagOptions(meta: Y.Map<any>): WorkspaceTagOption[] {
  const options = getWorkspaceTagOptionsArray(meta);
  if (!options) {
    return [];
  }

  const parsed: WorkspaceTagOption[] = [];
  options.forEach((raw: unknown) => {
    let id: unknown;
    let value: unknown;
    if (raw instanceof Y.Map) {
      id = raw.get("id");
      value = raw.get("value");
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      id = record.id;
      value = record.value;
    }

    if (typeof id !== "string" || typeof value !== "string") {
      return;
    }
    const normalizedId = id.trim();
    const normalizedValue = value.trim();
    if (!normalizedId || !normalizedValue) {
      return;
    }
    parsed.push({ id: normalizedId, value: normalizedValue });
  });
  return parsed;
}

function getWorkspaceTagOptionMaps(meta: Y.Map<any>): {
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
  return { byId, byValueLower };
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

function getWorkspacePageEntries(
  meta: Y.Map<any>,
  tagOptionById: Map<string, WorkspaceTagOption>
): WorkspaceDocSummary[] {
  const pages = meta.get("pages");
  if (!(pages instanceof Y.Array)) {
    return [];
  }

  const entries: WorkspaceDocSummary[] = [];
  pages.forEach((value: unknown) => {
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
      id,
      title: typeof title === "string" ? title : null,
      createDate: typeof createDate === "number" ? createDate : null,
      updatedDate: typeof updatedDate === "number" ? updatedDate : null,
      tags: resolveTagLabels(getStringArray(getTagArray(value)), tagOptionById),
    });
  });
  return entries;
}

function normalizeCollectionRuleFilter(value: unknown): CollectionRuleFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const filter = value as Record<string, unknown>;
  if (filter.field !== "title" && filter.field !== "tag" && filter.field !== "docId") {
    return null;
  }
  const allowedOperators =
    filter.field === "docId"
      ? ["equals", "in"]
      : filter.field === "title"
        ? ["contains", "equals", "startsWith"]
        : ["contains", "equals"];
  if (!allowedOperators.includes(filter.operator as string)) {
    return null;
  }

  if (filter.operator === "in") {
    if (!Array.isArray(filter.value)) {
      return null;
    }
    const values = filter.value
      .filter((entry): entry is string => typeof entry === "string")
      .map(entry => entry.trim())
      .filter(Boolean);
    if (values.length === 0) {
      return null;
    }
    return {
      field: filter.field,
      operator: "in",
      value: Array.from(new Set(values)),
    };
  }

  if (typeof filter.value !== "string") {
    return null;
  }
  const valueText = filter.value.trim();
  if (!valueText) {
    return null;
  }
  return {
    field: filter.field,
    operator: filter.operator as CollectionRuleOperator,
    value: valueText,
  };
}

function normalizeCollectionRules(value: unknown): CollectionInfo["rules"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { match: "all", filters: [] };
  }

  const rules = value as Record<string, unknown>;
  const match = rules.match === "any" ? "any" : "all";
  const filters = Array.isArray(rules.filters)
    ? rules.filters
        .map(normalizeCollectionRuleFilter)
        .filter((entry): entry is CollectionRuleFilter => entry !== null)
    : [];

  return { match, filters };
}

function matchesCollectionRule(doc: WorkspaceDocSummary, filter: CollectionRuleFilter): boolean {
  const title = (doc.title ?? "").trim();
  const lowerTitle = title.toLocaleLowerCase();
  const tagValues = doc.tags.map(tag => tag.toLocaleLowerCase());

  switch (filter.field) {
    case "title": {
      const target = filter.value.toString().toLocaleLowerCase();
      if (filter.operator === "contains") {
        return lowerTitle.includes(target);
      }
      if (filter.operator === "startsWith") {
        return lowerTitle.startsWith(target);
      }
      return lowerTitle === target;
    }
    case "tag": {
      const target = filter.value.toString().toLocaleLowerCase();
      if (filter.operator === "contains") {
        return tagValues.some(tag => tag.includes(target));
      }
      return tagValues.some(tag => tag === target);
    }
    case "docId": {
      if (filter.operator === "in") {
        return Array.isArray(filter.value)
          ? filter.value.some(value => value === doc.id)
          : false;
      }
      return doc.id === filter.value;
    }
  }
}

function matchesCollectionRules(doc: WorkspaceDocSummary, rules: CollectionInfo["rules"]): boolean {
  if (rules.filters.length === 0) {
    return false;
  }

  const matches = rules.filters.map(filter => matchesCollectionRule(doc, filter));
  return rules.match === "any" ? matches.some(Boolean) : matches.every(Boolean);
}

function sortOrganizeNodes(nodes: OrganizeNodeRecord[]): OrganizeNodeRecord[] {
  return [...nodes].sort((left, right) => {
    const parentCompare = (left.parentId ?? "").localeCompare(right.parentId ?? "");
    if (parentCompare !== 0) {
      return parentCompare;
    }
    const indexCompare = left.index.localeCompare(right.index);
    if (indexCompare !== 0) {
      return indexCompare;
    }
    return left.id.localeCompare(right.id);
  });
}

function ensureFolderParent(
  nodes: Map<string, OrganizeNodeRecord>,
  parentId: string | null
): void {
  if (parentId === null) {
    return;
  }
  const parent = nodes.get(parentId);
  if (!parent || parent.type !== "folder") {
    throw new Error(`Parent folder '${parentId}' was not found.`);
  }
}

function ensureNodeIsFolder(nodes: Map<string, OrganizeNodeRecord>, nodeId: string): OrganizeNodeRecord {
  const node = nodes.get(nodeId);
  if (!node || node.type !== "folder") {
    throw new Error(`Folder '${nodeId}' was not found.`);
  }
  return node;
}

function isAncestor(
  nodes: Map<string, OrganizeNodeRecord>,
  childId: string,
  ancestorId: string
): boolean {
  if (childId === ancestorId) {
    return false;
  }
  const seen = new Set<string>([childId]);
  let current = childId;
  while (true) {
    const node = nodes.get(current);
    if (!node?.parentId) {
      return false;
    }
    current = node.parentId;
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (current === ancestorId) {
      return true;
    }
  }
}

function nextOrganizeIndex(
  nodes: OrganizeNodeRecord[],
  parentId: string | null
): string {
  const siblings = nodes
    .filter(node => node.parentId === parentId)
    .sort((left, right) => left.index.localeCompare(right.index));
  const last = siblings.at(-1);
  return generateFractionalIndexingKeyBetween(last?.index ?? null, null);
}

export function registerOrganizeTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string }
) {
  async function getSocketContext() {
    const endpoint = gql.endpoint;
    const cookie = gql.cookie;
    const bearer = gql.bearer;
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    return { socket };
  }

  async function loadWorkspaceRootDoc(socket: any, workspaceId: string) {
    const snapshot = await loadDoc(socket, workspaceId, workspaceId);
    const doc = new Y.Doc();
    if (snapshot.missing) {
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
    }
    return { doc, snapshot };
  }

  async function saveWorkspaceRootDoc(socket: any, workspaceId: string, doc: Y.Doc) {
    const update = Y.encodeStateAsUpdate(doc);
    await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(update).toString("base64"));
  }

  async function loadFoldersDoc(socket: any, workspaceId: string) {
    const docId = specialWorkspaceDbDocId(workspaceId, "folders");
    const snapshot = await loadDoc(socket, workspaceId, docId);
    const doc = new Y.Doc();
    if (snapshot.missing) {
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
    }
    return { docId, doc, snapshot };
  }

async function saveFoldersDoc(socket: any, workspaceId: string, docId: string, doc: Y.Doc) {
  const update = Y.encodeStateAsUpdate(doc);
  await pushDocUpdate(socket, workspaceId, docId, Buffer.from(update).toString("base64"));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listWorkspaceDocsForCollectionRules(socket: any, workspaceId: string): Promise<WorkspaceDocSummary[]> {
  const { doc } = await loadWorkspaceRootDoc(socket, workspaceId);
  const meta = doc.getMap("meta");
  const tagOptionById = getWorkspaceTagOptionMaps(meta).byId;
  const pageEntries = getWorkspacePageEntries(meta, tagOptionById);
    const docs: WorkspaceDocSummary[] = [];

    for (const entry of pageEntries) {
      let mergedTitle = entry.title;
      let mergedTags = entry.tags;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await loadDoc(socket, workspaceId, entry.id);
      if (snapshot.missing) {
        const pageDoc = new Y.Doc();
        Y.applyUpdate(pageDoc, Buffer.from(snapshot.missing, "base64"));
        const pageMeta = pageDoc.getMap("meta");
        const docTitle = pageMeta.get("title");
        if (typeof docTitle === "string" && docTitle.trim().length > 0) {
          mergedTitle = docTitle;
        }
        const docTags = getStringArray(getTagArray(pageMeta));
        const resolvedDocTags = resolveTagLabels(docTags, tagOptionById);
        if (resolvedDocTags.length > 0) {
          mergedTags = resolvedDocTags;
        }
      }

      if (mergedTitle || mergedTags.length > 0 || attempt === 4) {
        break;
      }
      await sleep(150);
    }

    docs.push({
      id: entry.id,
        title: mergedTitle,
        tags: mergedTags,
        createDate: entry.createDate,
        updatedDate: entry.updatedDate,
      });
    }

    return docs;
  }

  async function createFolderInternal({
    workspaceId,
    name,
    parentId,
    index,
  }: {
    workspaceId: string;
    name: string;
    parentId?: string | null;
    index?: string;
  }) {
    const resolvedParentId = parentId ?? null;
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, workspaceId);
      const { docId, doc } = await loadFoldersDoc(socket, workspaceId);
      const nodes = readOrganizeNodes(doc);
      const nodeMap = organizeNodeMap(nodes);
      ensureFolderParent(nodeMap, resolvedParentId);
      const folderId = generateId();
      const folderIndex = index ?? nextOrganizeIndex(nodes, resolvedParentId);
      const record = ensureRecord(doc, folderId);
      record.set("id", folderId);
      record.set("type", "folder");
      record.set("data", name);
      record.set("parentId", resolvedParentId);
      record.set("index", folderIndex);
      record.delete("$$DELETED");
      await saveFoldersDoc(socket, workspaceId, docId, doc);
      return {
        id: folderId,
        parentId: resolvedParentId,
        type: "folder" as const,
        data: name,
        index: folderIndex,
        storageDocId: docId,
      };
    } finally {
      socket.disconnect();
    }
  }

  async function updateCollectionRulesInternal({
    workspaceId,
    collectionId,
    rules,
  }: {
    workspaceId: string;
    collectionId: string;
    rules: CollectionInfo["rules"];
  }) {
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, workspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, workspaceId);
      const setting = doc.getMap("setting");
      const current = setting.get("collections");
      if (!(current instanceof Y.Array)) {
        throw new Error("Workspace does not contain any collections.");
      }
      const index = findCollectionIndex(current, collectionId);
      if (index < 0) {
        throw new Error(`Collection '${collectionId}' was not found.`);
      }
      const previous = normalizeCollection(current.get(index));
      if (!previous) {
        throw new Error(`Collection '${collectionId}' is malformed.`);
      }

      const docs = await listWorkspaceDocsForCollectionRules(socket, workspaceId);
      const allowList = docs.filter(doc => matchesCollectionRules(doc, rules)).map(doc => doc.id);
      const next: CollectionInfo = {
        ...previous,
        rules,
        allowList,
      };

      doc.transact(() => {
        current.delete(index, 1);
        current.insert(index, [next]);
      });

      await saveWorkspaceRootDoc(socket, workspaceId, doc);
      return {
        collection: next,
        matchedDocIds: allowList,
        matchedCount: allowList.length,
      };
    } finally {
      socket.disconnect();
    }
  }

  function requireWorkspaceId(workspaceId?: string): string {
    const resolved = workspaceId || defaults.workspaceId;
    if (!resolved) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }
    return resolved;
  }

  const listCollectionsHandler = async ({ workspaceId }: { workspaceId?: string }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, resolvedWorkspaceId);
      const setting = doc.getMap("setting");
      const current = setting.get("collections");
      const collections = current instanceof Y.Array ? readCollections(current) : [];
      return text([...collections].sort((left, right) => left.name.localeCompare(right.name)));
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "list_collections",
    {
      title: "List Collections",
      description: "List AFFiNE collections stored in the workspace sidebar.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
      },
    },
    listCollectionsHandler as any
  );

  const getCollectionHandler = async ({ workspaceId, collectionId }: { workspaceId?: string; collectionId: string }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, resolvedWorkspaceId);
      const setting = doc.getMap("setting");
      const current = setting.get("collections");
      const collections = current instanceof Y.Array ? readCollections(current) : [];
      const collection = collections.find(entry => entry.id === collectionId);
      if (!collection) {
        throw new Error(`Collection '${collectionId}' was not found.`);
      }
      return text(collection);
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "get_collection",
    {
      title: "Get Collection",
      description: "Get an AFFiNE collection by id.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
      },
    },
    getCollectionHandler as any
  );

  const createCollectionHandler = async ({
    workspaceId,
    name,
    rules,
  }: {
    workspaceId?: string;
    name: string;
    rules?: { match?: "all" | "any"; filters: CollectionRuleFilter[] };
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, resolvedWorkspaceId);
      const setting = doc.getMap("setting");
      let current = setting.get("collections") as Y.Array<any> | undefined;
      if (!(current instanceof Y.Array)) {
        current = new Y.Array<any>();
        setting.set("collections", current);
      }

      const collection: CollectionInfo = {
        id: generateId(),
        name,
        rules: rules ? normalizeCollectionRules(rules) : { match: "all", filters: [] },
        allowList: [],
      };

      current.push([collection]);
      await saveWorkspaceRootDoc(socket, resolvedWorkspaceId, doc);
      return text(collection);
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "create_collection",
    {
      title: "Create Collection",
      description: "Create a new AFFiNE collection in the workspace sidebar.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        name: FolderName.describe("Collection name"),
        rules: CollectionRulesSchema.optional().describe("Optional rule set to initialize the collection with."),
      },
    },
    createCollectionHandler as any
  );

  const updateCollectionRulesHandler = async ({
    workspaceId,
    collectionId,
    rules,
  }: {
    workspaceId?: string;
    collectionId: string;
    rules: { match?: "all" | "any"; filters: CollectionRuleFilter[] };
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const normalizedRules = normalizeCollectionRules(rules);
    const result = await updateCollectionRulesInternal({
      workspaceId: resolvedWorkspaceId,
      collectionId,
      rules: normalizedRules,
    });
    return text({
      workspaceId: resolvedWorkspaceId,
      collectionId,
      rules: normalizedRules,
      allowList: result.collection.allowList,
      matchedDocIds: result.matchedDocIds,
      matchedCount: result.matchedCount,
    });
  };

  server.registerTool(
    "update_collection_rules",
    {
      title: "Update Collection Rules",
      description: "Replace a collection's rules and rebuild its allow-list from workspace docs.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
        rules: CollectionRulesSchema.describe("Rule set used to rebuild the collection allow-list."),
      },
    },
    updateCollectionRulesHandler as any
  );

  const updateCollectionHandler = async ({
    workspaceId,
    collectionId,
    name,
  }: {
    workspaceId?: string;
    collectionId: string;
    name?: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, resolvedWorkspaceId);
      const setting = doc.getMap("setting");
      const current = setting.get("collections");
      if (!(current instanceof Y.Array)) {
        throw new Error("Workspace does not contain any collections.");
      }
      const index = findCollectionIndex(current, collectionId);
      if (index < 0) {
        throw new Error(`Collection '${collectionId}' was not found.`);
      }

      const previous = normalizeCollection(current.get(index));
      if (!previous) {
        throw new Error(`Collection '${collectionId}' is malformed.`);
      }
      const next: CollectionInfo = {
        ...previous,
        name: name ?? previous.name,
      };

      doc.transact(() => {
        current.delete(index, 1);
        current.insert(index, [next]);
      });

      await saveWorkspaceRootDoc(socket, resolvedWorkspaceId, doc);
      return text(next);
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "update_collection",
    {
      title: "Update Collection",
      description: "Rename an AFFiNE collection.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
        name: FolderName.optional().describe("Updated collection name"),
      },
    },
    updateCollectionHandler as any
  );

  const deleteCollectionHandler = async ({
    workspaceId,
    collectionId,
  }: {
    workspaceId?: string;
    collectionId: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, resolvedWorkspaceId);
      const setting = doc.getMap("setting");
      const current = setting.get("collections");
      if (!(current instanceof Y.Array)) {
        throw new Error("Workspace does not contain any collections.");
      }
      const index = findCollectionIndex(current, collectionId);
      if (index < 0) {
        throw new Error(`Collection '${collectionId}' was not found.`);
      }
      current.delete(index, 1);
      await saveWorkspaceRootDoc(socket, resolvedWorkspaceId, doc);
      return text({ success: true, collectionId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "delete_collection",
    {
      title: "Delete Collection",
      description: "Delete an AFFiNE collection from the workspace sidebar.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
      },
    },
    deleteCollectionHandler as any
  );

  const addDocToCollectionHandler = async ({
    workspaceId,
    collectionId,
    docId,
  }: {
    workspaceId?: string;
    collectionId: string;
    docId: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, resolvedWorkspaceId);
      const setting = doc.getMap("setting");
      const current = setting.get("collections");
      if (!(current instanceof Y.Array)) {
        throw new Error("Workspace does not contain any collections.");
      }
      const index = findCollectionIndex(current, collectionId);
      if (index < 0) {
        throw new Error(`Collection '${collectionId}' was not found.`);
      }
      const previous = normalizeCollection(current.get(index));
      if (!previous) {
        throw new Error(`Collection '${collectionId}' is malformed.`);
      }
      const next: CollectionInfo = {
        ...previous,
        allowList: Array.from(new Set([...previous.allowList, docId])),
      };
      doc.transact(() => {
        current.delete(index, 1);
        current.insert(index, [next]);
      });
      await saveWorkspaceRootDoc(socket, resolvedWorkspaceId, doc);
      return text(next);
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "add_doc_to_collection",
    {
      title: "Add Doc To Collection",
      description: "Add a document id to an AFFiNE collection allow-list.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
        docId: DocId,
      },
    },
    addDocToCollectionHandler as any
  );

  const removeDocFromCollectionHandler = async ({
    workspaceId,
    collectionId,
    docId,
  }: {
    workspaceId?: string;
    collectionId: string;
    docId: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { doc } = await loadWorkspaceRootDoc(socket, resolvedWorkspaceId);
      const setting = doc.getMap("setting");
      const current = setting.get("collections");
      if (!(current instanceof Y.Array)) {
        throw new Error("Workspace does not contain any collections.");
      }
      const index = findCollectionIndex(current, collectionId);
      if (index < 0) {
        throw new Error(`Collection '${collectionId}' was not found.`);
      }
      const previous = normalizeCollection(current.get(index));
      if (!previous) {
        throw new Error(`Collection '${collectionId}' is malformed.`);
      }
      const next: CollectionInfo = {
        ...previous,
        allowList: previous.allowList.filter(id => id !== docId),
      };
      doc.transact(() => {
        current.delete(index, 1);
        current.insert(index, [next]);
      });
      await saveWorkspaceRootDoc(socket, resolvedWorkspaceId, doc);
      return text(next);
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "remove_doc_from_collection",
    {
      title: "Remove Doc From Collection",
      description: "Remove a document id from an AFFiNE collection allow-list.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
        docId: DocId,
      },
    },
    removeDocFromCollectionHandler as any
  );

  const listOrganizeNodesHandler = async ({ workspaceId }: { workspaceId?: string }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { docId, doc } = await loadFoldersDoc(socket, resolvedWorkspaceId);
      const nodes = sortOrganizeNodes(readOrganizeNodes(doc));
      return text({
        workspaceId: resolvedWorkspaceId,
        storageDocId: docId,
        nodes,
      });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "list_organize_nodes",
    {
      title: "List Organize Nodes",
      description: "Experimental: list AFFiNE sidebar organize nodes from the folders workspace DB.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
      },
    },
    listOrganizeNodesHandler as any
  );

  const createFolderHandler = async ({
    workspaceId,
    name,
    parentId,
    index,
  }: {
    workspaceId?: string;
    name: string;
    parentId?: string | null;
    index?: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    return text(await createFolderInternal({
      workspaceId: resolvedWorkspaceId,
      name,
      parentId,
      index,
    }));
  };

  server.registerTool(
    "create_folder",
    {
      title: "Create Folder",
      description: "Experimental: create an AFFiNE organize folder node.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        name: FolderName.describe("Folder name"),
        parentId: FolderId.nullable().optional().describe("Parent folder id. Omit for root-level folders."),
        index: z.string().optional().describe("Optional fractional index. Defaults to append-after-last."),
      },
    },
    createFolderHandler as any
  );

  const createWorkspaceBlueprintHandler = async ({
    workspaceId,
    rootFolderName,
    childFolderNames,
  }: {
    workspaceId?: string;
    rootFolderName: string;
    childFolderNames?: string[];
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const normalizedChildFolderNames = Array.from(
      new Set((childFolderNames ?? []).map(name => name.trim()).filter(Boolean))
    );

    const rootFolder = await createFolderInternal({
      workspaceId: resolvedWorkspaceId,
      name: rootFolderName,
    });

    const childFolders = [];
    for (const childName of normalizedChildFolderNames) {
      childFolders.push(await createFolderInternal({
        workspaceId: resolvedWorkspaceId,
        name: childName,
        parentId: rootFolder.id,
      }));
    }

    return text({
      workspaceId: resolvedWorkspaceId,
      rootFolderId: rootFolder.id,
      rootFolderName,
      childFolders,
      childFolderCount: childFolders.length,
      storageDocId: rootFolder.storageDocId,
    });
  };

  server.registerTool(
    "create_workspace_blueprint",
    {
      title: "Create Workspace Blueprint",
      description: "Create a simple workspace folder blueprint under the organize tree.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        rootFolderName: FolderName.describe("Root folder name"),
        childFolderNames: z.array(FolderName).optional().describe("Optional child folder names to seed under the root folder."),
      },
    },
    createWorkspaceBlueprintHandler as any
  );

  const renameFolderHandler = async ({
    workspaceId,
    folderId,
    name,
  }: {
    workspaceId?: string;
    folderId: string;
    name: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { docId, doc } = await loadFoldersDoc(socket, resolvedWorkspaceId);
      const nodeMap = organizeNodeMap(readOrganizeNodes(doc));
      ensureNodeIsFolder(nodeMap, folderId);
      const record = ensureRecord(doc, folderId);
      record.set("data", name);
      await saveFoldersDoc(socket, resolvedWorkspaceId, docId, doc);
      return text({ id: folderId, name });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "rename_folder",
    {
      title: "Rename Folder",
      description: "Experimental: rename an AFFiNE organize folder node.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        folderId: FolderId,
        name: FolderName,
      },
    },
    renameFolderHandler as any
  );

  const deleteFolderHandler = async ({
    workspaceId,
    folderId,
  }: {
    workspaceId?: string;
    folderId: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { docId, doc } = await loadFoldersDoc(socket, resolvedWorkspaceId);
      const nodes = readOrganizeNodes(doc);
      const nodeMap = organizeNodeMap(nodes);
      ensureNodeIsFolder(nodeMap, folderId);

      const stack = [folderId];
      const deletedIds: string[] = [];
      while (stack.length > 0) {
        const currentId = stack.pop()!;
        const current = nodeMap.get(currentId);
        if (!current) {
          continue;
        }
        if (current.type === "folder") {
          const children = nodes.filter(node => node.parentId === current.id);
          for (const child of children) {
            stack.push(child.id);
          }
        }
        deleteRecord(ensureRecord(doc, currentId));
        deletedIds.push(currentId);
      }

      await saveFoldersDoc(socket, resolvedWorkspaceId, docId, doc);
      return text({ success: true, deletedIds });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "delete_folder",
    {
      title: "Delete Folder",
      description: "Experimental: delete an AFFiNE organize folder and all nested nodes.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        folderId: FolderId,
      },
    },
    deleteFolderHandler as any
  );

  const moveOrganizeNodeHandler = async ({
    workspaceId,
    nodeId,
    parentId,
    index,
  }: {
    workspaceId?: string;
    nodeId: string;
    parentId?: string | null;
    index?: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const resolvedParentId = parentId ?? null;
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { docId, doc } = await loadFoldersDoc(socket, resolvedWorkspaceId);
      const nodes = readOrganizeNodes(doc);
      const nodeMap = organizeNodeMap(nodes);
      const node = nodeMap.get(nodeId);
      if (!node) {
        throw new Error(`Organize node '${nodeId}' was not found.`);
      }
      ensureFolderParent(nodeMap, resolvedParentId);
      if (resolvedParentId === null && node.type !== "folder") {
        throw new Error("Root organize section can only contain folders.");
      }
      if (resolvedParentId && node.type === "folder" && isAncestor(nodeMap, resolvedParentId, nodeId)) {
        throw new Error("Cannot move a folder into its descendant.");
      }
      const nextIndex = index ?? nextOrganizeIndex(nodes.filter(entry => entry.id !== nodeId), resolvedParentId);
      const record = ensureRecord(doc, nodeId);
      record.set("parentId", resolvedParentId);
      record.set("index", nextIndex);
      await saveFoldersDoc(socket, resolvedWorkspaceId, docId, doc);
      return text({ id: nodeId, parentId: resolvedParentId, index: nextIndex });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "move_organize_node",
    {
      title: "Move Organize Node",
      description: "Experimental: move an AFFiNE organize folder or link node.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        nodeId: OrganizeNodeId,
        parentId: FolderId.nullable().optional().describe("Destination folder id. Omit for root-level placement."),
        index: z.string().optional().describe("Optional fractional index. Defaults to append-after-last."),
      },
    },
    moveOrganizeNodeHandler as any
  );

  const addOrganizeLinkHandler = async ({
    workspaceId,
    folderId,
    type,
    targetId,
    index,
  }: {
    workspaceId?: string;
    folderId: string;
    type: "doc" | "tag" | "collection";
    targetId: string;
    index?: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { docId, doc } = await loadFoldersDoc(socket, resolvedWorkspaceId);
      const nodes = readOrganizeNodes(doc);
      const nodeMap = organizeNodeMap(nodes);
      ensureNodeIsFolder(nodeMap, folderId);
      const linkId = generateId();
      const nextIndex = index ?? nextOrganizeIndex(nodes, folderId);
      const record = ensureRecord(doc, linkId);
      record.set("id", linkId);
      record.set("type", type);
      record.set("data", targetId);
      record.set("parentId", folderId);
      record.set("index", nextIndex);
      record.delete("$$DELETED");
      await saveFoldersDoc(socket, resolvedWorkspaceId, docId, doc);
      return text({
        id: linkId,
        parentId: folderId,
        type,
        data: targetId,
        index: nextIndex,
        storageDocId: docId,
      });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "add_organize_link",
    {
      title: "Add Organize Link",
      description: "Experimental: add a doc/tag/collection link under an AFFiNE organize folder.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        folderId: FolderId,
        type: z.enum(["doc", "tag", "collection"]),
        targetId: z.string().min(1).describe("Target doc/tag/collection id"),
        index: z.string().optional().describe("Optional fractional index. Defaults to append-after-last."),
      },
    },
    addOrganizeLinkHandler as any
  );

  const deleteOrganizeLinkHandler = async ({
    workspaceId,
    nodeId,
  }: {
    workspaceId?: string;
    nodeId: string;
  }) => {
    const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
    const { socket } = await getSocketContext();
    try {
      await joinWorkspace(socket, resolvedWorkspaceId);
      const { docId, doc } = await loadFoldersDoc(socket, resolvedWorkspaceId);
      const nodeMap = organizeNodeMap(readOrganizeNodes(doc));
      const node = nodeMap.get(nodeId);
      if (!node || node.type === "folder") {
        throw new Error(`Organize link '${nodeId}' was not found.`);
      }
      deleteRecord(ensureRecord(doc, nodeId));
      await saveFoldersDoc(socket, resolvedWorkspaceId, docId, doc);
      return text({ success: true, nodeId });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "delete_organize_link",
    {
      title: "Delete Organize Link",
      description: "Experimental: delete an AFFiNE organize doc/tag/collection link.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        nodeId: OrganizeNodeId,
      },
    },
    deleteOrganizeLinkHandler as any
  );
}
