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

export async function joinWorkspace(socket: WorkspaceSocket, workspaceId: string, clientVersionOverride?: string) {
  return new Promise<void>((resolve, reject) => {
    // AFFiNE validates `clientVersion` on `space:join`. Using a non-version string can
    // cause the server to never ACK the join, hanging WebSocket-based tools.
    const clientVersion = (clientVersionOverride && clientVersionOverride.trim()) ||
      process.env.AFFINE_CLIENT_VERSION ||
      process.env.AFFINE_APP_VERSION ||
      process.env.AFFINE_VERSION ||
      '0.26.2';

    const timeoutMs = Number.parseInt(process.env.AFFINE_JOIN_TIMEOUT_MS || '', 10) || 15000;
    const timeout = setTimeout(() => reject(new Error('join timeout')), timeoutMs);

    socket.emit(
      'space:join',
      { spaceType: 'workspace', spaceId: workspaceId, clientVersion },
      (ack: any) => {
        clearTimeout(timeout);
        if (ack?.error) return reject(new Error(ack.error.message || 'join failed'));
        if (ack?.data?.success === false) return reject(new Error('join failed'));
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
