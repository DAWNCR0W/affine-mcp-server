import { io } from "socket.io-client";
import * as Y from "yjs";

const baseUrl = process.env.AFFINE_BASE_URL || "http://affine_server:3010";
const token = process.env.AFFINE_API_TOKEN;
const workspaceId = process.env.AFFINE_WORKSPACE_ID;
const targetDocId = process.env.PROBE_DOC_ID || workspaceId;

if (!token || !workspaceId) {
  console.error("AFFINE_API_TOKEN and AFFINE_WORKSPACE_ID required.");
  process.exit(1);
}

const wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/graphql\/?$/, "");

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} timeout`)), 10000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timeout);
      if (ack?.error) return reject(new Error(ack.error.message || event));
      resolve(ack?.data ?? {});
    });
  });
}

function dumpYjsValue(v, depth = 0) {
  if (depth > 4) return "[depth-cap]";
  if (v instanceof Y.Map) {
    const obj = {};
    for (const k of v.keys()) obj[k] = dumpYjsValue(v.get(k), depth + 1);
    return obj;
  }
  if (v instanceof Y.Array) {
    const arr = [];
    v.forEach((x) => arr.push(dumpYjsValue(x, depth + 1)));
    return arr;
  }
  if (v instanceof Y.Text) return `Y.Text("${v.toString()}")`;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dumpYjsValue(x, depth + 1)]));
  }
  return v;
}

const socket = io(wsUrl, {
  transports: ["websocket"],
  path: "/socket.io/",
  extraHeaders: { Authorization: `Bearer ${token}` },
});

socket.on("connect_error", (e) => { console.error("connect_error:", e.message); process.exit(1); });
await new Promise((res) => socket.on("connect", res));
console.error(`[probe] connected to ${wsUrl}`);

await emitAck(socket, "space:join", {
  spaceType: "workspace",
  spaceId: workspaceId,
  clientVersion: "0.26.0",
});
console.error(`[probe] joined workspace ${workspaceId}`);

// 1) Workspace meta — dump ALL keys, focus on properties + the target doc's page entry
const wsState = await emitAck(socket, "space:load-doc", {
  spaceType: "workspace",
  spaceId: workspaceId,
  docId: workspaceId,
});

if (!wsState.missing) {
  console.error("[probe] workspace meta missing");
  process.exit(0);
}

const wsDoc = new Y.Doc();
Y.applyUpdate(wsDoc, Buffer.from(wsState.missing, "base64"));

const wsRootKeys = Array.from(wsDoc.share.keys());
console.log(JSON.stringify({ wsRootKeys }, null, 2));

const meta = wsDoc.getMap("meta");
console.log("---WORKSPACE_META_FULL---");
console.log(JSON.stringify({
  name: meta.get("name"),
  avatar: meta.get("avatar"),
  propertiesType: meta.get("properties") instanceof Y.Map ? "Y.Map" : typeof meta.get("properties"),
  properties: dumpYjsValue(meta.get("properties")),
}, null, 2));

// Filter the target page entry
const pages = meta.get("pages");
if (pages instanceof Y.Array) {
  pages.forEach((p) => {
    if (!(p instanceof Y.Map)) return;
    if (p.get("id") !== targetDocId) return;
    console.log("---TARGET_PAGE_ENTRY---");
    console.log(JSON.stringify(dumpYjsValue(p), null, 2));
  });
}

// 2) Workspace-level non-meta maps (some Affine versions stash doc display props elsewhere)
for (const rootKey of wsRootKeys) {
  if (rootKey === "meta") continue;
  const v = wsDoc.share.get(rootKey);
  console.log(`---WS_ROOT_${rootKey}---`);
  try { console.log(JSON.stringify(dumpYjsValue(v.toJSON ? v.toJSON() : v), null, 2)); }
  catch (e) { console.log("[unable to dump]", e.message); }
}

// 3) Target doc YJS — all root maps, all blocks
const docState = await emitAck(socket, "space:load-doc", {
  spaceType: "workspace",
  spaceId: workspaceId,
  docId: targetDocId,
});

if (docState.missing) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(docState.missing, "base64"));
  const docRootKeys = Array.from(doc.share.keys());
  console.log("---TARGET_DOC_ROOT_KEYS---");
  console.log(JSON.stringify(docRootKeys));

  for (const rootKey of docRootKeys) {
    const v = doc.share.get(rootKey);
    console.log(`---DOC_ROOT_${rootKey}---`);
    try { console.log(JSON.stringify(dumpYjsValue(v.toJSON ? v.toJSON() : v), null, 2)); }
    catch (e) { console.log("[unable to dump]", e.message); }
  }
}

socket.disconnect();
