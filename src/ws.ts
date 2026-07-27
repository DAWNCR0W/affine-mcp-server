import { io, Socket } from "socket.io-client";

export type WorkspaceSocket = Socket<any, any>;
const DEFAULT_WS_CLIENT_VERSION = process.env.AFFINE_WS_CLIENT_VERSION || '0.26.0';
const WS_CONNECT_TIMEOUT_MS = Number(process.env.AFFINE_WS_CONNECT_TIMEOUT_MS || 10000);
const WS_ACK_TIMEOUT_MS = Number(process.env.AFFINE_WS_ACK_TIMEOUT_MS || 10000);

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

function emitWithAck<T>(
  socket: WorkspaceSocket,
  event: string,
  payload: Record<string, any>,
  onAck: (ack: any) => T,
  timeoutMs: number = WS_ACK_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${event} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.emit(event, payload, (ack: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        resolve(onAck(ack));
      } catch (err) {
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
  return new Promise((resolve, reject) => {
    let settled = false;
    const extraHeaders: Record<string, string> = {};
    if (cookie) extraHeaders['Cookie'] = cookie;
    if (bearer) extraHeaders['Authorization'] = `Bearer ${bearer}`;
    const socket = io(wsUrl, {
      transports: ['websocket'],
      path: '/socket.io/',
      extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : undefined,
      autoConnect: true
    });
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

export async function joinWorkspace(socket: WorkspaceSocket, workspaceId: string, clientVersion: string = DEFAULT_WS_CLIENT_VERSION) {
  return emitWithAck<void>(
    socket,
    'space:join',
    { spaceType: 'workspace', spaceId: workspaceId, clientVersion },
    (ack) => {
      const message = ackErrorMessage(ack, "join failed");
      if (message) throw new Error(message);
    },
  );
}

type LoadDocResult = { missing?: string; state?: string; timestamp?: number };

export async function loadDoc(socket: WorkspaceSocket, workspaceId: string, docId: string): Promise<LoadDocResult> {
  return emitWithAck<LoadDocResult>(
    socket,
    'space:load-doc',
    { spaceType: 'workspace', spaceId: workspaceId, docId },
    (ack) => {
      if (ack?.error) {
        if (ack.error.name === 'DOC_NOT_FOUND') return {};
        throw new Error(ackErrorMessage(ack, "load-doc failed") || "load-doc failed");
      }
      return ack?.data || {};
    },
  );
}

export async function pushDocUpdate(socket: WorkspaceSocket, workspaceId: string, docId: string, updateBase64: string): Promise<number> {
  return emitWithAck<number>(
    socket,
    'space:push-doc-update',
    { spaceType: 'workspace', spaceId: workspaceId, docId, update: updateBase64 },
    (ack) => {
      const message = ackErrorMessage(ack, "push-doc-update failed");
      if (message) throw new Error(message);
      return ack?.data?.timestamp || Date.now();
    },
  );
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
 * Delete a document and wait for a trustworthy completion signal.
 *
 * AFFiNE versions may return no successful acknowledgement, `{ deleted: true }`,
 * or `{ data: { success: true } }`. AFFiNE 0.27.3 also retains the underlying
 * snapshot for garbage collection, so a successful acknowledgement must be
 * recognized instead of relying exclusively on a follow-up DOC_NOT_FOUND.
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
      rejectOnce(new Error('space:delete-doc failed because the socket disconnected before completion.'));
    };
    const operationTimer = setTimeout(() => {
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
          resolveOnce({ acknowledged: false, verifiedAbsent: true });
          return;
        }
      } catch (error) {
        if (settled) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('space:load-doc timeout after ')) {
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
      const message = ackErrorMessage(ack, 'delete-doc failed');
      if (message) {
        rejectOnce(new Error(message));
        return;
      }
      if (deleteAcknowledged(ack)) {
        resolveOnce({ acknowledged: true, verifiedAbsent: false });
        return;
      }
      if (deleteRejected(ack)) {
        rejectOnce(new Error('AFFiNE did not confirm document deletion.'));
      }
    });
    verificationTimer = setTimeout(verifyDeletion, 0);
  });
}
