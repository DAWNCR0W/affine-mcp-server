export type EndpointDef = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string; // may contain :params
};

export type EndpointMap = {
  listWorkspaces: EndpointDef;
  listDocs: EndpointDef; // requires :workspaceId
  getDoc: EndpointDef; // requires :docId
  createDoc: EndpointDef; // requires :workspaceId
  updateDoc: EndpointDef; // requires :docId
  deleteDoc: EndpointDef; // requires :docId
  searchDocs: EndpointDef; // requires :workspaceId and query param ?q=
};

export type AffineDocInput = {
  title?: string;
  content?: unknown;
  properties?: Record<string, unknown>;
};

export type AffineDoc = {
  id: string;
  title?: string;
  content?: unknown;
  [key: string]: unknown;
};

