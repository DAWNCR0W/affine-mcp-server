import { io, Socket } from "socket.io-client";

export type WorkspaceSocket = Socket<any, any>;
const DEFAULT_WS_CLIENT_VERSION = process.env.AFFINE_WS_CLIENT_VERSION || '0.26.0';
const WS_CONNECT_TIMEOUT_MS = Number(process.env.AFFINE_WS_CONNECT_TIMEOUT_MS || 10000);
const WS_ACK_TIMEOUT_MS = Number(process.env.AFFINE_WS_ACK_TIMEOUT_MS || 10000);

export function wsUrlFromGraphQLEndpoint(endpoint: string): string {
  return endpoint
    .replace('https://', 'wss://')
    .replace('http://', 'ws://')
    .replace(/\/graphql\/?$/, '');
}

export async function connectWorkspaceSocket(wsUrl: string, cookie?: string, bearer?: string): Promise<WorkspaceSocket> {
  return new Promise((resolve, reject) => {
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
      cleanup();
      socket.disconnect();
      reject(new Error(`socket connect timeout after ${WS_CONNECT_TIMEOUT_MS}ms`));
    }, WS_CONNECT_TIMEOUT_MS);
    const onError = (err: any) => {
      cleanup();
      socket.disconnect();
      reject(err);
    };
    const onConnect = () => {
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
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`space:join timeout after ${WS_ACK_TIMEOUT_MS}ms`));
    }, WS_ACK_TIMEOUT_MS);
    socket.emit(
      'space:join',
      { spaceType: 'workspace', spaceId: workspaceId, clientVersion },
      (ack: any) => {
        clearTimeout(timeout);
        if (ack?.error) return reject(new Error(ack.error.message || 'join failed'));
        resolve();
      }
    );
  });
}

export async function loadDoc(socket: WorkspaceSocket, workspaceId: string, docId: string): Promise<{ missing?: string; state?: string; timestamp?: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`space:load-doc timeout after ${WS_ACK_TIMEOUT_MS}ms`));
    }, WS_ACK_TIMEOUT_MS);
    socket.emit(
      'space:load-doc',
      { spaceType: 'workspace', spaceId: workspaceId, docId },
      (ack: any) => {
        clearTimeout(timeout);
        if (ack?.error) {
          if (ack.error.name === 'DOC_NOT_FOUND') return resolve({});
          return reject(new Error(ack.error.message || 'load-doc failed'));
        }
        resolve(ack?.data || {});
      }
    );
  });
}

export async function pushDocUpdate(socket: WorkspaceSocket, workspaceId: string, docId: string, updateBase64: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`space:push-doc-update timeout after ${WS_ACK_TIMEOUT_MS}ms`));
    }, WS_ACK_TIMEOUT_MS);
    socket.emit(
      'space:push-doc-update',
      { spaceType: 'workspace', spaceId: workspaceId, docId, update: updateBase64 },
      (ack: any) => {
        clearTimeout(timeout);
        if (ack?.error) return reject(new Error(ack.error.message || 'push-doc-update failed'));
        resolve(ack?.data?.timestamp || Date.now());
      }
    );
  });
}

export function deleteDoc(socket: WorkspaceSocket, workspaceId: string, docId: string) {
  socket.emit('space:delete-doc', { spaceType: 'workspace', spaceId: workspaceId, docId });
}
