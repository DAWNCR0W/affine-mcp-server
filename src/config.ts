import dotenv from "dotenv";
import { EndpointMap } from "./types.js";

dotenv.config();

export type ServerConfig = {
  baseUrl: string;
  apiToken?: string;
  cookie?: string;
  headers?: Record<string, string>;
  graphqlPath: string;
  email?: string;
  password?: string;
  defaultWorkspaceId?: string;
  transport: "ws" | "stdio";
  wsPort: number;
  endpoints: EndpointMap;
};

const defaultEndpoints: EndpointMap = {
  listWorkspaces: { method: "GET", path: "/api/workspaces" },
  listDocs: { method: "GET", path: "/api/workspaces/:workspaceId/docs" },
  getDoc: { method: "GET", path: "/api/docs/:docId" },
  createDoc: { method: "POST", path: "/api/workspaces/:workspaceId/docs" },
  updateDoc: { method: "PATCH", path: "/api/docs/:docId" },
  deleteDoc: { method: "DELETE", path: "/api/docs/:docId" },
  searchDocs: {
    method: "GET",
    path: "/api/workspaces/:workspaceId/search"
  }
};

export function loadConfig(): ServerConfig {
  const baseUrl = process.env.AFFINE_BASE_URL?.replace(/\/$/, "") || "http://localhost:3010";
  const apiToken = process.env.AFFINE_API_TOKEN;
  const cookie = process.env.AFFINE_COOKIE;
  const email = process.env.AFFINE_EMAIL;
  const password = process.env.AFFINE_PASSWORD;
  let headers: Record<string, string> | undefined = undefined;
  const headersJson = process.env.AFFINE_HEADERS_JSON;
  if (headersJson) {
    try {
      headers = JSON.parse(headersJson);
    } catch (e) {
      console.warn("Failed to parse AFFINE_HEADERS_JSON; ignoring.");
    }
  }
  if (cookie) {
    headers = { ...(headers || {}), Cookie: cookie };
  }
  const graphqlPath = process.env.AFFINE_GRAPHQL_PATH || "/graphql";
  const defaultWorkspaceId = process.env.AFFINE_WORKSPACE_ID;
  const transport = (process.env.MCP_TRANSPORT as "ws" | "stdio") || "ws";
  const wsPort = Number(process.env.MCP_WS_PORT || 7821);

  let endpoints = defaultEndpoints;
  const endpointsJson = process.env.AFFINE_ENDPOINTS_JSON;
  if (endpointsJson) {
    try {
      endpoints = { ...defaultEndpoints, ...JSON.parse(endpointsJson) } as EndpointMap;
    } catch (e) {
      console.warn("Failed to parse AFFINE_ENDPOINTS_JSON; using defaults.");
    }
  }

  return { baseUrl, apiToken, cookie, headers, graphqlPath, email, password, defaultWorkspaceId, transport, wsPort, endpoints };
}
