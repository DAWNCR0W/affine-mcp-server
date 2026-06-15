import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import {
  wsUrlFromGraphQLEndpoint,
  connectWorkspaceSocket,
  joinWorkspace,
  loadDoc,
  pushDocUpdate,
} from "../ws.js";

/**
 * Doc custom properties live in dedicated Yjs sub-docs synced by guid, NOT in
 * the page doc or the workspace root meta. AFFiNE's WorkspaceDB (an ORM on top
 * of Yjs) maps one table to one sub-doc whose guid is `db$<tableName>`:
 *
 *  - `db$docCustomPropertyInfo`: the workspace-wide property *definitions*
 *     (schema). Top-level YMap keyed by propertyId -> { id, name, type, index,
 *     icon, show, isDeleted }.
 *  - `db$docProperties`: the per-doc property *values*. Top-level YMap keyed by
 *     docId -> { id, ...builtins, "custom:<propertyId>": <value> }.
 *
 * A custom property must have a definition in `db$docCustomPropertyInfo` to be
 * rendered/editable in the AFFiNE UI. Writing a value without a matching
 * definition stores orphan data that the UI ignores.
 *
 * Values are stored as strings, encoded per type:
 *  - text:     raw string
 *  - number:   stringified number
 *  - checkbox: "true" | "false"
 *  - date:     "YYYY-MM-DD"
 *
 * References (AFFiNE repo):
 *  - modules/db/services/db.ts  -> guid `db$${tableName}`
 *  - orm/core/adapters/yjs/table.ts -> record = top-level YMap keyed by primary key
 *  - modules/doc/entities/record.ts -> value key is `custom:<propertyId>`
 */

const DOC_PROPERTIES_GUID = "db$docProperties";
const CUSTOM_PROPERTY_INFO_GUID = "db$docCustomPropertyInfo";
const DELETED_FLAG = "$$DELETED";
const CUSTOM_PREFIX = "custom:";

const SUPPORTED_TYPES = ["text", "number", "checkbox", "date"] as const;
type SupportedType = (typeof SUPPORTED_TYPES)[number];

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");

const NANOID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

/** Generate a 21-char nanoid-style id, matching AFFiNE's property id format. */
function generatePropertyId(): string {
  let id = "";
  for (let i = 0; i < 21; i++) {
    id += NANOID_ALPHABET.charAt(Math.floor(Math.random() * NANOID_ALPHABET.length));
  }
  return id;
}

type PropertyDefinition = {
  id: string;
  name: string | null;
  type: string;
  index: string | null;
  icon: string | null;
  show: string | null;
};

/**
 * Read all live custom-property definitions from the `db$docCustomPropertyInfo`
 * sub-doc, skipping soft-deleted and empty records.
 */
function readPropertyDefinitions(doc: Y.Doc): PropertyDefinition[] {
  const defs: PropertyDefinition[] = [];
  // Records are top-level (root) Yjs types keyed by id. After applyUpdate, root
  // types are generic AbstractType until doc.getMap(key) casts them, so an
  // `instanceof Y.Map` check would skip every record. Mirror AFFiNE's ORM
  // adapter and materialize each record via getMap.
  for (const key of doc.share.keys()) {
    const data = doc.getMap(key).toJSON() as Record<string, unknown>;
    if (data[DELETED_FLAG] === true || data.isDeleted === true) continue;
    if (Object.keys(data).length === 0) continue;
    const type = typeof data.type === "string" ? data.type : "unknown";
    defs.push({
      id: typeof data.id === "string" ? data.id : key,
      name: typeof data.name === "string" ? data.name : null,
      type,
      index: typeof data.index === "string" ? data.index : null,
      icon: typeof data.icon === "string" ? data.icon : null,
      show: typeof data.show === "string" ? data.show : null,
    });
  }
  defs.sort((a, b) => (a.index || "").localeCompare(b.index || ""));
  return defs;
}

/**
 * Resolve a definition by exact id, then by unique case-insensitive name.
 * Throws if a name matches more than one definition.
 */
function resolveDefinition(
  defs: PropertyDefinition[],
  property: string
): PropertyDefinition | null {
  const byId = defs.find((d) => d.id === property);
  if (byId) return byId;
  const lowered = property.trim().toLowerCase();
  const byName = defs.filter((d) => (d.name || "").trim().toLowerCase() === lowered);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `Property name "${property}" is ambiguous (${byName.length} matches). Use the property id instead.`
    );
  }
  return null;
}

/** Compute the next fractional index, appending after the current last definition. */
function nextIndex(defs: PropertyDefinition[]): string {
  const indexes = defs
    .map((d) => d.index)
    .filter((i): i is string => typeof i === "string" && i.length > 0)
    .sort();
  const last = indexes.length ? indexes[indexes.length - 1] : null;
  return generateKeyBetween(last, null);
}

/** Encode a JS value into AFFiNE's per-type string representation; throws on invalid input. */
function encodeValue(type: SupportedType, value: unknown): string {
  switch (type) {
    case "checkbox": {
      const truthy =
        value === true ||
        value === 1 ||
        (typeof value === "string" && ["true", "1", "yes"].includes(value.trim().toLowerCase()));
      return truthy ? "true" : "false";
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) {
        throw new Error(`number property requires a numeric value, got ${JSON.stringify(value)}`);
      }
      return String(n);
    }
    case "date": {
      const s = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw new Error(`date property requires "YYYY-MM-DD", got ${JSON.stringify(value)}`);
      }
      const parsed = new Date(`${s}T00:00:00.000Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) {
        throw new Error(`date property requires a valid "YYYY-MM-DD" date, got ${JSON.stringify(value)}`);
      }
      return s;
    }
    case "text":
    default:
      return String(value);
  }
}

/** Decode a stored string back into a typed JS value for output. */
function decodeValue(type: string, raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  switch (type) {
    case "checkbox":
      return raw === "true" || raw === true;
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    default:
      return raw;
  }
}

/** Register the five document custom-property tools on the MCP server. */
export function registerPropertyTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string }
) {
  /** Snapshot the current GraphQL endpoint and auth material for WebSocket use. */
  function getCookieAndEndpoint() {
    return { endpoint: gql.endpoint, cookie: gql.cookie, bearer: gql.bearer };
  }

  /** Resolve the workspace id from the argument or the configured default; throws if absent. */
  function requireWorkspaceId(workspaceId?: string): string {
    const id = workspaceId || defaults.workspaceId;
    if (!id) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }
    return id;
  }

  /** Load a WorkspaceDB sub-doc by guid and return it with its pre-mutation state vector. */
  async function loadSubdoc(
    socket: any,
    workspaceId: string,
    guid: string
  ): Promise<{ doc: Y.Doc; prevSV: Uint8Array; existed: boolean }> {
    const snapshot = await loadDoc(socket, workspaceId, guid);
    const doc = new Y.Doc();
    let existed = false;
    if (snapshot.missing) {
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      existed = true;
    }
    return { doc, prevSV: Y.encodeStateVector(doc), existed };
  }

  /** Push only the delta accumulated since `prevSV` back to the sync gateway. */
  async function pushSubdoc(
    socket: any,
    workspaceId: string,
    guid: string,
    doc: Y.Doc,
    prevSV: Uint8Array
  ) {
    const delta = Y.encodeStateAsUpdate(doc, prevSV);
    await pushDocUpdate(socket, workspaceId, guid, Buffer.from(delta).toString("base64"));
  }

  /** Throw if the workspace root or the docId is not found in workspace metadata. */
  async function assertDocExists(socket: any, workspaceId: string, docId: string) {
    const snapshot = await loadDoc(socket, workspaceId, workspaceId);
    if (!snapshot.missing) {
      throw new Error(`Workspace root document not found for workspace ${workspaceId}`);
    }
    const wsDoc = new Y.Doc();
    Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
    const pages = wsDoc.getMap("meta").get("pages");
    const exists =
      pages instanceof Y.Array &&
      pages.toArray().some((p: unknown) => p instanceof Y.Map && p.get("id") === docId);
    if (!exists) {
      throw new Error(`docId ${docId} is not present in workspace ${workspaceId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // list_doc_properties
  // ---------------------------------------------------------------------------
  /** Handle `list_doc_properties`: definitions, decoded per-doc values, and orphan values. */
  const listDocPropertiesHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const { endpoint, cookie, bearer } = getCookieAndEndpoint();
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const { doc: infoDoc } = await loadSubdoc(socket, workspaceId, CUSTOM_PROPERTY_INFO_GUID);
      const defs = readPropertyDefinitions(infoDoc);

      const { doc: propsDoc } = await loadSubdoc(socket, workspaceId, DOC_PROPERTIES_GUID);
      const record = propsDoc.share.has(parsed.docId)
        ? (propsDoc.getMap(parsed.docId).toJSON() as Record<string, unknown>)
        : {};

      const byId = new Map(defs.map((d) => [d.id, d]));
      const properties = defs.map((def) => {
        const raw = record[CUSTOM_PREFIX + def.id];
        return {
          propertyId: def.id,
          name: def.name,
          type: def.type,
          value: decodeValue(def.type, raw),
          set: raw !== undefined && raw !== null,
        };
      });

      // Surface custom values that have no matching (live) definition.
      const orphans = Object.keys(record)
        .filter((k) => k.startsWith(CUSTOM_PREFIX))
        .map((k) => k.slice(CUSTOM_PREFIX.length))
        .filter((id) => !byId.has(id))
        .map((id) => ({ propertyId: id, value: record[CUSTOM_PREFIX + id] }));

      return text({
        workspaceId,
        docId: parsed.docId,
        definitions: defs,
        properties,
        orphanValues: orphans,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "list_doc_properties",
    {
      title: "List Document Properties",
      description:
        "List the workspace custom-property definitions and a document's current values for them.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
      },
    },
    listDocPropertiesHandler as any
  );

  // ---------------------------------------------------------------------------
  // create_custom_property
  // ---------------------------------------------------------------------------
  /** Handle `create_custom_property`: append a new workspace-wide definition. */
  const createCustomPropertyHandler = async (parsed: {
    workspaceId?: string;
    name: string;
    type: SupportedType;
    icon?: string;
  }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const name = parsed.name.trim();
    if (!name) throw new Error("name is required");

    const { endpoint, cookie, bearer } = getCookieAndEndpoint();
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevSV } = await loadSubdoc(socket, workspaceId, CUSTOM_PROPERTY_INFO_GUID);
      const defs = readPropertyDefinitions(doc);

      const id = generatePropertyId();
      const index = nextIndex(defs);

      const record = doc.getMap(id);
      record.set("id", id);
      record.set("name", name);
      record.set("type", parsed.type);
      record.set("index", index);
      if (parsed.icon) record.set("icon", parsed.icon);

      await pushSubdoc(socket, workspaceId, CUSTOM_PROPERTY_INFO_GUID, doc, prevSV);

      return text({
        workspaceId,
        propertyId: id,
        name,
        type: parsed.type,
        index,
        created: true,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "create_custom_property",
    {
      title: "Create Custom Property",
      description:
        "Create a workspace-wide custom property definition (text, number, checkbox, or date). Returns its propertyId.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        name: z.string().min(1).describe("Display name of the property"),
        type: z.enum(SUPPORTED_TYPES).describe("Property value type"),
        icon: z.string().optional().describe("Optional icon name"),
      },
    },
    createCustomPropertyHandler as any
  );

  // ---------------------------------------------------------------------------
  // delete_custom_property
  // ---------------------------------------------------------------------------
  /** Handle `delete_custom_property`: soft-delete a definition by id or name. */
  const deleteCustomPropertyHandler = async (parsed: {
    workspaceId?: string;
    property: string;
  }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const { endpoint, cookie, bearer } = getCookieAndEndpoint();
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      const { doc, prevSV } = await loadSubdoc(socket, workspaceId, CUSTOM_PROPERTY_INFO_GUID);
      const defs = readPropertyDefinitions(doc);
      const def = resolveDefinition(defs, parsed.property);
      if (!def) {
        throw new Error(`No custom property matches "${parsed.property}" in workspace ${workspaceId}`);
      }
      // Mirror AFFiNE: keep the record for legacy override, flag it deleted.
      const record = doc.getMap(def.id);
      record.set("isDeleted", true);

      await pushSubdoc(socket, workspaceId, CUSTOM_PROPERTY_INFO_GUID, doc, prevSV);

      return text({ workspaceId, propertyId: def.id, name: def.name, deleted: true });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "delete_custom_property",
    {
      title: "Delete Custom Property",
      description:
        "Soft-delete a workspace custom property definition (by propertyId or name). Existing values are hidden.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        property: z.string().min(1).describe("Property id or name"),
      },
    },
    deleteCustomPropertyHandler as any
  );

  // ---------------------------------------------------------------------------
  // set_doc_property
  // ---------------------------------------------------------------------------
  /** Handle `set_doc_property`: validate, encode, and upsert a doc's property value. */
  const setDocPropertyHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    property: string;
    value: string | number | boolean;
  }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const { endpoint, cookie, bearer } = getCookieAndEndpoint();
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      await assertDocExists(socket, workspaceId, parsed.docId);

      const { doc: infoDoc } = await loadSubdoc(socket, workspaceId, CUSTOM_PROPERTY_INFO_GUID);
      const defs = readPropertyDefinitions(infoDoc);
      const def = resolveDefinition(defs, parsed.property);
      if (!def) {
        throw new Error(
          `No custom property matches "${parsed.property}". Create it first with create_custom_property.`
        );
      }
      if (!SUPPORTED_TYPES.includes(def.type as SupportedType)) {
        throw new Error(
          `Property "${def.name || def.id}" has type "${def.type}", which set_doc_property cannot edit. Supported: ${SUPPORTED_TYPES.join(", ")}.`
        );
      }
      const encoded = encodeValue(def.type as SupportedType, parsed.value);

      const { doc, prevSV } = await loadSubdoc(socket, workspaceId, DOC_PROPERTIES_GUID);
      const record = doc.getMap(parsed.docId);
      record.set("id", parsed.docId); // ORM keyField, required by find/observe
      record.set(CUSTOM_PREFIX + def.id, encoded);

      await pushSubdoc(socket, workspaceId, DOC_PROPERTIES_GUID, doc, prevSV);

      return text({
        workspaceId,
        docId: parsed.docId,
        propertyId: def.id,
        name: def.name,
        type: def.type,
        value: decodeValue(def.type, encoded),
        stored: encoded,
        updated: true,
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "set_doc_property",
    {
      title: "Set Document Property",
      description:
        "Set a document's custom property value (property by id or name). Value is validated against the property type (text/number/checkbox/date).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        property: z.string().min(1).describe("Property id or name"),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .describe("Value; coerced per property type (checkbox->bool, number, date YYYY-MM-DD, text)"),
      },
    },
    setDocPropertyHandler as any
  );

  // ---------------------------------------------------------------------------
  // clear_doc_property
  // ---------------------------------------------------------------------------
  /** Handle `clear_doc_property`: remove a doc's value for a property (by id or name). */
  const clearDocPropertyHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    property: string;
  }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const { endpoint, cookie, bearer } = getCookieAndEndpoint();
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(endpoint), cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);

      const { doc: infoDoc } = await loadSubdoc(socket, workspaceId, CUSTOM_PROPERTY_INFO_GUID);
      const defs = readPropertyDefinitions(infoDoc);
      const def = resolveDefinition(defs, parsed.property);
      // Allow clearing by raw id even if the definition was already deleted.
      const propertyId = def?.id ?? parsed.property;

      const { doc, prevSV } = await loadSubdoc(socket, workspaceId, DOC_PROPERTIES_GUID);
      let cleared = false;
      if (doc.share.has(parsed.docId)) {
        const record = doc.getMap(parsed.docId);
        const key = CUSTOM_PREFIX + propertyId;
        if (record.has(key)) {
          record.delete(key);
          cleared = true;
        }
      }
      if (cleared) {
        await pushSubdoc(socket, workspaceId, DOC_PROPERTIES_GUID, doc, prevSV);
      }

      return text({ workspaceId, docId: parsed.docId, propertyId, cleared });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "clear_doc_property",
    {
      title: "Clear Document Property",
      description: "Remove a custom property value from a document (property by id or name).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        property: z.string().min(1).describe("Property id or name"),
      },
    },
    clearDocPropertyHandler as any
  );
}
