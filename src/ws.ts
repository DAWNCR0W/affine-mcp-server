import { io, Socket } from "socket.io-client";

type WorkspaceSocket = Socket<any, any>;
const DEFAULT_WS_CLIENT_VERSION = process.env.AFFINE_WS_CLIENT_VERSION || '0.26.0';
const WS_CONNECT_TIMEOUT_MS = Number(process.env.AFFINE_WS_CONNECT_TIMEOUT_MS || 10000);
const WS_ACK_TIMEOUT_MS = Number(process.env.AFFINE_WS_ACK_TIMEOUT_MS || 10000);

function ackErrorMessage(ack: any, fallback: string): string | null {
  const message = ack?.error?.message;
  if (typeof message === "string" && message.trim()) return message;
  return ack?.error ? fallback : null;
}

function emitWithAck<T>(
  socket: WorkspaceSocket,
  event: string,
  payload: Record<string, any>,
  onAck: (ack: any) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${event} timeout after ${WS_ACK_TIMEOUT_MS}ms`));
    }, WS_ACK_TIMEOUT_MS);

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
  return endpoint
    .replace('https://', 'wss://')
    .replace('http://', 'ws://')
    .replace(/\/graphql\/?$/, '');
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

export function deleteDoc(socket: WorkspaceSocket, workspaceId: string, docId: string) {
  socket.emit('space:delete-doc', { spaceType: 'workspace', spaceId: workspaceId, docId });
}
