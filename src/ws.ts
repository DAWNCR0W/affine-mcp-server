import { io, Socket } from "socket.io-client";

export type WorkspaceSocket = Socket<any, any>;

export function wsUrlFromGraphQLEndpoint(endpoint: string): string {
  return endpoint
    .replace('https://', 'wss://')
    .replace('http://', 'ws://')
    .replace(/\/graphql\/?$/, '');
}

export async function connectWorkspaceSocket(wsUrl: string, cookie?: string): Promise<WorkspaceSocket> {
  return new Promise((resolve, reject) => {
    const socket = io(wsUrl, {
      transports: ['websocket'],
      path: '/socket.io/',
      extraHeaders: cookie ? { Cookie: cookie } : undefined,
      autoConnect: true
    });
    const onError = (err: any) => {
      cleanup();
      reject(err);
    };
    const onConnect = () => {
      socket.off('connect_error', onError);
      resolve(socket);
    };
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

export async function joinWorkspace(socket: WorkspaceSocket, workspaceId: string) {
  return new Promise<void>((resolve, reject) => {
    socket.emit(
      'space:join',
      { spaceType: 'workspace', spaceId: workspaceId, clientVersion: 'mcp' },
      (ack: any) => {
        if (ack?.error) return reject(new Error(ack.error.message || 'join failed'));
        resolve();
      }
    );
  });
}

export async function loadDoc(socket: WorkspaceSocket, workspaceId: string, docId: string): Promise<{ missing?: string; state?: string; timestamp?: number }> {
  return new Promise((resolve, reject) => {
    socket.emit(
      'space:load-doc',
      { spaceType: 'workspace', spaceId: workspaceId, docId },
      (ack: any) => {
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
    socket.emit(
      'space:push-doc-update',
      { spaceType: 'workspace', spaceId: workspaceId, docId, update: updateBase64 },
      (ack: any) => {
        if (ack?.error) return reject(new Error(ack.error.message || 'push-doc-update failed'));
        resolve(ack?.data?.timestamp || Date.now());
      }
    );
  });
}

export function deleteDoc(socket: WorkspaceSocket, workspaceId: string, docId: string) {
  socket.emit('space:delete-doc', { spaceType: 'workspace', spaceId: workspaceId, docId });
}

