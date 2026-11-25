import { captureDocUpdate } from "./util/docUpdate.js";
import { io, Socket } from "socket.io-client";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { ToolFailure } from "./util/mcp.js";
import { activeDocumentMutation } from "./util/documentMutation.js";

export type WorkspaceSocket = Socket<any, any>;
type JoinMode = 'legacy' | 'batch';
type JoinSettings = { mode: JoinMode; clientVersion: string; protocolVersion: 1 | 2 };
type DocJoin = { docId: string; resolve: () => void; reject: (error: unknown) => void };
type WorkspaceJoins = { docs: Map<string, Promise<void>>; pending: DocJoin[]; scheduled: boolean };
type SocketState = { settings: JoinSettings; workspaces: Map<string, WorkspaceJoins> };
const socketStates = new WeakMap<WorkspaceSocket, SocketState>();
const WS_CONNECT_TIMEOUT_MS = Number(process.env.AFFINE_WS_CONNECT_TIMEOUT_MS || 10000);
const WS_ACK_TIMEOUT_MS = Number(process.env.AFFINE_WS_ACK_TIMEOUT_MS || 10000);
const WORKSPACE_METADATA_RETRY_DELAYS_MS = [500, 1000, 2000];


function joinSettings(mode: JoinMode): JoinSettings {
  const protocol = process.env.AFFINE_WS_PROTOCOL_VERSION || '1';
  if (protocol !== '1' && protocol !== '2') {
    throw new ToolFailure('AFFINE_WS_PROTOCOL_VERSION must be 1 or 2.', 'invalid_config');
  }
  return {
    mode,
    clientVersion: process.env.AFFINE_WS_CLIENT_VERSION || process.env.AFFINE_CLIENT_VERSION
      || (mode === 'batch' ? '0.27.5' : '0.26.0'),
    protocolVersion: Number(protocol) as 1 | 2,
  };
}

async function detectJoinMode(wsUrl: string): Promise<JoinMode> {
  const override = process.env.AFFINE_WS_JOIN_MODE || 'auto';
  if (override === 'legacy' || override === 'batch') return override;
  if (override !== 'auto') {
    throw new ToolFailure('AFFINE_WS_JOIN_MODE must be auto, legacy, or batch.', 'invalid_config');
  }
  const url = new URL('/info', wsUrl.replace(/^ws/, 'http'));
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(WS_CONNECT_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) return 'legacy';
    const info = await response.json() as { compatibility?: unknown };
    // The boundary is >=0.27.5-0, so every prerelease of 0.27.5 qualifies.
    const version = typeof info.compatibility === 'string'
      ? /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(info.compatibility)
      : null;
    if (!version) return 'legacy';
    const [major, minor, patch] = version.slice(1, 4).map(Number);
    return major > 0 || minor > 27 || (minor === 27 && patch >= 5) ? 'batch' : 'legacy';
  } catch {
    // Older servers and proxies may not expose /info. Operators can force batch mode.
    return 'legacy';
  }
}

function socketState(socket: WorkspaceSocket, settings?: JoinSettings): SocketState {
  let state = socketStates.get(socket);
  if (!state) {
    state = { settings: settings || joinSettings('legacy'), workspaces: new Map() };
    socketStates.set(socket, state);
    socket.on?.('disconnect', () => state!.workspaces.clear());
  }
  return state;
}

/** Deduplicate subscriptions on this socket and batch concurrent reads, at most 100 per request. */
export function ensureDocJoined(socket: WorkspaceSocket, workspaceId: string, docId: string): Promise<void> {
  const state = socketState(socket);
  if (state.settings.mode === 'legacy') return Promise.resolve();
  let workspace = state.workspaces.get(workspaceId);
  if (!workspace) {
    workspace = { docs: new Map(), pending: [], scheduled: false };
    state.workspaces.set(workspaceId, workspace);
  }
  const existing = workspace.docs.get(docId);
  if (existing) return existing;
  const joins = workspace;
  const promise = new Promise<void>((resolve, reject) => joins.pending.push({ docId, resolve, reject }));
  joins.docs.set(docId, promise);
  if (!joins.scheduled) {
    joins.scheduled = true;
    queueMicrotask(async () => {
      while (joins.pending.length) {
        const batch = joins.pending.splice(0, 100);
        try {
          await emitJoin(socket, workspaceId, batch.map(entry => entry.docId), state.settings);
          for (const entry of batch) entry.resolve();
        } catch (error) {
          for (const entry of batch) {
            joins.docs.delete(entry.docId);
            entry.reject(error);
          }
        }
      }
      joins.scheduled = false;
    });
  }
  return promise;
}

function emitJoin(socket: WorkspaceSocket, workspaceId: string, docIds: string[], settings: JoinSettings): Promise<void> {
  const { mode, clientVersion, protocolVersion } = settings;
  return emitWithAck<void>(socket, mode === 'batch' ? 'space:join-batch' : 'space:join',
    mode === 'batch'
      ? { spaces: docIds.map(docId => ({ spaceType: 'workspace', spaceId: workspaceId, docId })), clientVersion, protocolVersion }
      : { spaceType: 'workspace', spaceId: workspaceId, clientVersion },
    ack => {
      const message = ackErrorMessage(ack, 'Workspace join failed.');
      if (message) {
        if (ack.error.code === 'WORKSPACE_SYNC_UNAVAILABLE' || ack.error.name === 'WORKSPACE_SYNC_UNAVAILABLE') {
          throw new ToolFailure(`${message} Protocol ${protocolVersion} does not match the workspace lifecycle state. Confirm the server state before setting AFFINE_WS_PROTOCOL_VERSION; no migration was activated.`, 'WORKSPACE_SYNC_UNAVAILABLE');
        }
        throw new ToolFailure(message, String(ack.error.code || ack.error.name || 'sync_join_failed'));
      }
      if ((mode === 'batch' && ack?.data?.success !== true) || ack?.data?.success === false) {
        throw new ToolFailure(`AFFiNE rejected ${mode} join with clientVersion ${clientVersion}. Check the server's client-version requirement and AFFINE_WS_CLIENT_VERSION (batch requires >=0.27.5-0).`, 'sync_version_rejected');
      }
      if (mode === 'batch' && ack.data.protocolVersion !== protocolVersion) {
        throw new ToolFailure(`AFFiNE echoed sync protocol ${String(ack.data.protocolVersion)} instead of ${protocolVersion}. Check AFFINE_WS_PROTOCOL_VERSION and server compatibility.`, 'sync_protocol_mismatch');
      }
    });
}

class SocketAckTimeout extends Error {
  constructor(event: string, timeoutMs: number) {
    super(`${event} timeout after ${timeoutMs}ms`);
    this.name = "Error";
  }
}

function ackErrorMessage(ack: any, fallback: string): string | null {
  const message = ack?.error?.message;
  if (typeof message === "string" && message.trim()) return message;
  return ack?.error ? fallback : null;
}

function deleteAcknowledged(ack: any): boolean {
  return ack === true
    || ack?.deleted === true
    || ack?.success === true
    || ack?.data === true
    || ack?.data?.deleted === true
    || ack?.data?.success === true;
}

function deleteRejected(ack: any): boolean {
  return ack === false
    || ack?.deleted === false
    || ack?.success === false
    || ack?.data === false
    || ack?.data?.deleted === false
    || ack?.data?.success === false;
}

async function emitWithAck<T>(
  socket: WorkspaceSocket,
  event: string,
  payload: Record<string, any>,
  onAck: (ack: any) => T,
  timeoutMs: number = WS_ACK_TIMEOUT_MS,
): Promise<T> {
  if (['space:load-doc', 'space:load-awarenesses', 'space:update-awareness'].includes(event)) {
    await ensureDocJoined(socket, payload.spaceId, payload.docId);
  }
  if (socket.connected === false) {
    throw new ToolFailure(`${event} failed because the socket is disconnected. Reconnect before further operations; read back pending writes before retrying.`, 'upstream_unavailable');
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off?.('disconnect', onDisconnect);
    };
    const onDisconnect = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ToolFailure(`${event} failed because the socket disconnected: ${reason}. Reconnect before further operations; read back pending writes before retrying.`, 'upstream_unavailable'));
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new SocketAckTimeout(event, timeoutMs);
      if (event === 'space:join' || event === 'space:join-batch') {
        error.message += ` (clientVersion ${payload.clientVersion}, protocol ${payload.protocolVersion ?? 'legacy'}). Check server compatibility and AFFINE_WS_JOIN_MODE; an unavailable /info endpoint requires an explicit mode.`;
      }
      reject(error);
    }, timeoutMs);

    socket.once?.('disconnect', onDisconnect);
    socket.emit(event, payload, (ack: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ack?.error?.name === 'NOT_IN_SPACE' || ack?.error?.code === 'NOT_IN_SPACE') {
        socketStates.get(socket)?.workspaces.clear();
      }
      try {
        resolve(onAck(ack));
      } catch (err) {
        if (err instanceof Error && ack?.error) {
          if (typeof ack.error.name === "string" && ack.error.name.trim()) err.name = ack.error.name;
          if (ack.error.code !== undefined) Object.assign(err, { code: ack.error.code });
        }
        reject(err);
      }
    });
  });
}

export function wsUrlFromGraphQLEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else {
    throw new Error(`Unsupported GraphQL endpoint scheme for workspace socket: ${url.protocol}`);
  }
  // Socket.IO uses a fixed /socket.io/ transport path. Keeping the GraphQL
  // pathname here would turn a custom GraphQL route into a Socket.IO namespace.
  return url.origin;
}

export async function connectWorkspaceSocket(wsUrl: string, cookie?: string, bearer?: string): Promise<WorkspaceSocket> {
  const settings = joinSettings(await detectJoinMode(wsUrl));
  return new Promise((resolve, reject) => {
    let settled = false;
    const extraHeaders: Record<string, string> = {};
    if (cookie) extraHeaders['Cookie'] = cookie;
    if (bearer) extraHeaders['Authorization'] = `Bearer ${bearer}`;
    const socket = io(wsUrl, {
      transports: ['websocket'],
      path: '/socket.io/',
      extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : undefined,
      autoConnect: true,
      reconnection: false,
    });
    socketState(socket, settings);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.disconnect();
      reject(new Error(`socket connect timeout after ${WS_CONNECT_TIMEOUT_MS}ms`));
    }, WS_CONNECT_TIMEOUT_MS);
    const onError = (err: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.disconnect();
      reject(err);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

export async function joinWorkspace(socket: WorkspaceSocket, workspaceId: string, clientVersion?: string) {
  const state = socketState(socket);
  if (clientVersion) state.settings = { ...state.settings, clientVersion };
  if (state.settings.mode === 'batch') return ensureDocJoined(socket, workspaceId, workspaceId);
  return emitJoin(socket, workspaceId, [], state.settings);
}

type LoadDocResult = { missing?: string; state?: string; timestamp?: number; notFound?: true };

async function loadDocRaw(socket: WorkspaceSocket, workspaceId: string, docId: string, timeoutMs?: number): Promise<LoadDocResult> {
  return emitWithAck<LoadDocResult>(
    socket,
    'space:load-doc',
    { spaceType: 'workspace', spaceId: workspaceId, docId },
    (ack) => {
      if (ack?.error) {
        if (ack.error.name === 'DOC_NOT_FOUND') return { notFound: true };
        throw new Error(ackErrorMessage(ack, "load-doc failed") || "load-doc failed");
      }
      return ack?.data || {};
    },
    timeoutMs,
  );
}

export async function loadDoc(socket: WorkspaceSocket, workspaceId: string, docId: string): Promise<LoadDocResult> {
  const mutation = activeDocumentMutation(workspaceId);
  if (!mutation) return loadDocRaw(socket, workspaceId, docId);

  if (docId === workspaceId) {
    const snapshot = await loadDocRaw(socket, workspaceId, docId);
    mutation.observeRegistration(snapshot.missing);
    if (docId === mutation.docId) mutation.observeSnapshot(snapshot.missing);
    return snapshot;
  }

  if (docId !== mutation.docId) return loadDocRaw(socket, workspaceId, docId);

  // Capture registration before the content snapshot used by this mutation.
  // Always use the same public snapshot contract, but bypass tracking on this
  // preparatory read to avoid recursively changing the mutation's target state.
  if (!mutation.hasRegistration) {
    let workspaceSnapshot: LoadDocResult;
    // The write queue stays locked, so all registration attempts share one ACK budget.
    const deadline = performance.now() + WS_ACK_TIMEOUT_MS;
    let remaining = WS_ACK_TIMEOUT_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        workspaceSnapshot = await loadDocRaw(socket, workspaceId, workspaceId, remaining);
        break;
      } catch (error) {
        const retryDelay = WORKSPACE_METADATA_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || performance.now() + retryDelay >= deadline || !isTransientWorkspaceMetadataError(error)) {
          throw error;
        }
        await delay(retryDelay);
        remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw error;
      }
    }
    mutation.observeRegistration(workspaceSnapshot.missing);
  }
  const snapshot = await loadDocRaw(socket, workspaceId, docId);
  mutation.observeSnapshot(snapshot.missing);
  return snapshot;
}

function findWorkspacePage(doc: Y.Doc, docId: string): Y.Map<any> | undefined {
  const pages = doc.getMap("meta").get("pages");
  if (!(pages instanceof Y.Array)) return undefined;

  for (const page of pages) {
    if (page instanceof Y.Map && page.get("id") === docId) return page;
  }
  return undefined;
}

function updateHasChanges(updateBase64: string): boolean {
  try {
    const update = Y.decodeUpdate(Buffer.from(updateBase64, "base64"));
    return update.structs.length > 0 || update.ds.clients.size > 0;
  } catch {
    return true;
  }
}

async function pushDocUpdateRaw(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  updateBase64: string,
  requireAcknowledgement = false,
): Promise<number> {
  const { mode, protocolVersion } = socketState(socket).settings;
  if (mode === 'batch' && protocolVersion === 2) {
    throw new ToolFailure('Protocol 2 writes require AFFiNE lifecycle registration, which this client does not support. Use protocol 1 only on workspaces whose lifecycle is inactive.', 'sync_protocol_unsupported');
  }
  try {
    return await emitWithAck<number>(
      socket,
      'space:push-doc-update',
      { spaceType: 'workspace', spaceId: workspaceId, docId, update: updateBase64,
        // Protocol 1 uses create for legacy upserts, including existing documents.
        ...(mode === 'batch' ? { intent: 'create' } : {}),
      },
      (ack) => {
        const message = ackErrorMessage(ack, "push-doc-update failed");
        if (message) throw new Error(message);
        const timestamp = ack?.data?.timestamp;
        if (requireAcknowledgement && ack?.data?.accepted !== true) {
          throw uncertainWriteAcknowledgement(docId);
        }
        return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
          ? timestamp
          : Date.now();
      },
    );
  } catch (error) {
    if (requireAcknowledgement && error instanceof SocketAckTimeout && error.message.startsWith("space:push-doc-update timeout after ")) {
      throw uncertainWriteAcknowledgement(docId);
    }
    throw error;
  }
}

function uncertainWriteAcknowledgement(docId: string): ToolFailure {
  return new ToolFailure(
    `AFFiNE may have applied the update to document ${docId}, but did not confirm it. Read the document before retrying.`,
    "write_ack_uncertain",
    `Read document ${docId} before retrying; the write may already have been applied.`,
  );
}

async function workspacePageHasUpdatedDate(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  updatedDate: number,
): Promise<boolean> {
  const snapshot = await loadDoc(socket, workspaceId, workspaceId);
  if (typeof snapshot.missing !== "string") return false;

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
    const page = findWorkspacePage(doc, docId);
    const currentDate = page?.get("updatedDate");
    return typeof currentDate === "number" && currentDate >= updatedDate;
  } finally {
    doc.destroy();
  }
}

/** Keep permanent acknowledgement identities authoritative over message fallbacks. */
function isTransientWorkspaceMetadataError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  let transientIdentity = false;
  for (const identity of [error.name, (error as { code?: unknown }).code]) {
    if (identity === undefined) continue;
    if (typeof identity !== "string") return false;
    if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)$/i.test(identity)) {
      transientIdentity = true;
    } else if (!/^(Error|INTERNAL_SERVER_ERROR|Internal Server Error)$/i.test(identity)) {
      return false;
    }
  }
  return transientIdentity
    || /^Too many concurrent writings[.!]?$/i.test(error.message)
    || /^space:(load-doc|push-doc-update) timeout after \d+ms$/.test(error.message);
}

async function updateWorkspacePageUpdatedDate(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  updatedDate: number,
  requireAcknowledgement = false,
): Promise<void> {
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const snapshot = await loadDoc(socket, workspaceId, workspaceId);
        if (typeof snapshot.missing !== "string") {
          throw new Error("Workspace root document was unavailable.");
        }

        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
          const page = findWorkspacePage(doc, docId);
          if (!page) throw new Error("Document is not registered in workspace page metadata.");

          const currentDate = page.get("updatedDate");
          if (typeof currentDate === "number" && currentDate >= updatedDate) return;

          const pendingUpdate = captureDocUpdate(doc);
          page.set("updatedDate", updatedDate);
          const update = Buffer.from(pendingUpdate.finish()).toString("base64");
          try {
            await pushDocUpdateRaw(socket, workspaceId, workspaceId, update, requireAcknowledgement);
            return;
          } catch (error) {
            try {
              if (await workspacePageHasUpdatedDate(socket, workspaceId, docId, updatedDate)) return;
            } catch {
              // Preserve the write error when readback cannot confirm it.
            }
            throw error;
          }
        } finally {
          doc.destroy();
        }
      } catch (error) {
        const retryDelay = WORKSPACE_METADATA_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || !isTransientWorkspaceMetadataError(error)) {
          throw error;
        }
        // Retry only metadata, reloading the root after the server has had time to recover.
        await delay(retryDelay);
      }
    }
  } catch (error) {
    const cause = error instanceof Error ? ` ${error.message}` : "";
    throw new ToolFailure(
      `Document ${docId} was saved, but its workspace updatedDate could not be confirmed.${cause}`,
      "workspace_page_updated_date_failed",
      `Read document ${docId} in workspace ${workspaceId} before taking further action. Do not retry the page mutation; repair its workspace updatedDate separately.`,
    );
  }
}

/** Push an update to any workspace document without side effects on other documents. */
export async function pushDocUpdate(socket: WorkspaceSocket, workspaceId: string, docId: string, updateBase64: string): Promise<number> {
  const mutation = activeDocumentMutation(workspaceId);
  const trackedWorkspaceRootWrite = mutation !== undefined && docId === workspaceId;
  const trackedRootMutation = trackedWorkspaceRootWrite && mutation.docId === docId;
  const timestamp = await pushDocUpdateRaw(socket, workspaceId, docId, updateBase64, trackedWorkspaceRootWrite);
  if (trackedRootMutation) mutation.recordUpdate(updateBase64);
  return timestamp;
}

/** Push page content and mirror its acknowledgement timestamp to root page metadata. */
export async function pushPageDocUpdate(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  updateBase64: string,
  options: { requireAcknowledgement?: boolean; requireTimestampAcknowledgement?: boolean } = {},
): Promise<number> {
  const mutation = activeDocumentMutation(workspaceId);
  const trackedPageWrite = mutation !== undefined && mutation.docId === docId && docId !== workspaceId;
  const requireAcknowledgement = options.requireAcknowledgement === true || trackedPageWrite;
  const timestamp = await pushDocUpdateRaw(socket, workspaceId, docId, updateBase64, requireAcknowledgement);
  if (trackedPageWrite) mutation.recordUpdate(updateBase64);
  if (docId !== workspaceId && updateHasChanges(updateBase64)) {
    await updateWorkspacePageUpdatedDate(socket, workspaceId, docId, timestamp, options.requireTimestampAcknowledgement);
  }
  return timestamp;
}

export type DeleteDocResult = {
  acknowledged: boolean;
  verifiedAbsent: boolean;
};

export type DeleteDocOptions = {
  timeoutMs?: number;
  verificationIntervalMs?: number;
};

/**
 * Request document deletion and verify content absence separately.
 *
 * AFFiNE versions may return no successful acknowledgement, `{ deleted: true }`,
 * or `{ data: { success: true } }`. Some versions acknowledge deletion while
 * retaining readable content. Only a follow-up DOC_NOT_FOUND proves absence.
 */
export function deleteDoc(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  options: DeleteDocOptions = {},
): Promise<DeleteDocResult> {
  const timeoutMs = options.timeoutMs ?? WS_ACK_TIMEOUT_MS;
  const verificationIntervalMs = options.verificationIntervalMs ?? Math.min(250, timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`space:delete-doc timeout must be positive. Received: ${timeoutMs}`));
  }
  if (!Number.isFinite(verificationIntervalMs) || verificationIntervalMs <= 0) {
    return Promise.reject(
      new Error(`space:delete-doc verification interval must be positive. Received: ${verificationIntervalMs}`),
    );
  }

  const payload = { spaceType: 'workspace', spaceId: workspaceId, docId };

  return new Promise<DeleteDocResult>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let verificationTimer: NodeJS.Timeout | undefined;
    const deadline = Date.now() + timeoutMs;

    const cleanup = () => {
      clearTimeout(operationTimer);
      if (verificationTimer) clearTimeout(verificationTimer);
      socket.off('disconnect', onDisconnect);
    };
    const resolveOnce = (result: DeleteDocResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onDisconnect = () => {
      if (acknowledged) {
        resolveOnce({ acknowledged: true, verifiedAbsent: false });
        return;
      }
      rejectOnce(new Error('space:delete-doc failed because the socket disconnected before completion.'));
    };
    const operationTimer = setTimeout(() => {
      if (acknowledged) {
        resolveOnce({ acknowledged: true, verifiedAbsent: false });
        return;
      }
      rejectOnce(
        new Error(
          `space:delete-doc was not acknowledged and deletion could not be verified within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    const verifyDeletion = async () => {
      if (settled) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const acknowledgedBeforeRead = acknowledged;

      try {
        const absent = await emitWithAck<boolean>(
          socket,
          'space:load-doc',
          payload,
          (ack) => {
            if (ack?.error) {
              if (ack.error.name === 'DOC_NOT_FOUND') return true;
              throw new Error(ackErrorMessage(ack, 'load-doc verification failed') || 'load-doc verification failed');
            }
            return false;
          },
          Math.max(1, Math.min(remainingMs, verificationIntervalMs)),
        );
        if (absent) {
          resolveOnce({ acknowledged, verifiedAbsent: true });
          return;
        }
        if (acknowledgedBeforeRead) {
          resolveOnce({ acknowledged: true, verifiedAbsent: false });
          return;
        }
      } catch (error) {
        if (settled) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('space:load-doc timeout after ')) {
          if (acknowledged) {
            resolveOnce({ acknowledged: true, verifiedAbsent: false });
            return;
          }
          rejectOnce(error instanceof Error ? error : new Error(message));
          return;
        }
      }

      if (!settled) {
        verificationTimer = setTimeout(verifyDeletion, Math.min(verificationIntervalMs, Math.max(1, deadline - Date.now())));
      }
    };

    socket.once('disconnect', onDisconnect);
    socket.emit('space:delete-doc', payload, (ack: any) => {
      if (settled) return;
      const message = ackErrorMessage(ack, 'delete-doc failed');
      if (message) {
        rejectOnce(new Error(message));
        return;
      }
      if (deleteAcknowledged(ack)) {
        acknowledged = true;
        return;
      }
      if (deleteRejected(ack)) {
        rejectOnce(new Error('AFFiNE did not confirm document deletion.'));
      }
    });
    verificationTimer = setTimeout(verifyDeletion, 0);
  });
}
