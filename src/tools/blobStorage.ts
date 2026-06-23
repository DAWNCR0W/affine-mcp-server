import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import FormData from "form-data";
import fetch from "node-fetch";

function decodeBlobContent(content: string): Buffer {
  const normalized = content.trim().replace(/\s+/g, "");
  const base64Like = normalized.length > 0 && normalized.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(normalized);
  if (base64Like) {
    try {
      const decoded = Buffer.from(normalized, "base64");
      if (decoded.length > 0) {
        return decoded;
      }
    } catch {
      // Fallback to UTF-8 text below.
    }
  }
  return Buffer.from(content, "utf8");
}

export function registerBlobTools(server: McpServer, gql: GraphQLClient) {
  // UPLOAD BLOB/FILE
  const uploadBlobHandler = async ({ workspaceId, content, filename, contentType }: { workspaceId: string; content: string; filename?: string; contentType?: string }) => {
    try {
      const endpoint = gql.endpoint;
      const headers = gql.headers;
      const cookie = gql.cookie;
      const payload = decodeBlobContent(content);
      const safeFilename = filename || `blob-${Date.now()}.bin`;
      const mime = contentType || "application/octet-stream";

      const form = new FormData();
      form.append("operations", JSON.stringify({
        query: `mutation SetBlob($workspaceId: String!, $blob: Upload!) {
          setBlob(workspaceId: $workspaceId, blob: $blob)
        }`,
        variables: {
          workspaceId,
          blob: null
        }
      }));
      form.append("map", JSON.stringify({ "0": ["variables.blob"] }));
      form.append("0", payload, { filename: safeFilename, contentType: mime });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...headers,
          Cookie: cookie,
          ...form.getHeaders(),
        },
        body: form as any,
      });
      const result = await response.json() as any;
      if (result.errors?.length) {
        throw new Error(result.errors[0].message);
      }
      const blobKey = result.data?.setBlob;
      if (!blobKey) {
        throw new Error("Upload succeeded but no blob key was returned.");
      }

      return text({
        id: blobKey,
        key: blobKey,
        workspaceId,
        filename: safeFilename,
        contentType: mime,
        size: payload.length,
        uploadedAt: new Date().toISOString()
      });
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "upload_blob",
    {
      title: "Upload Blob",
      description: "Upload a file or blob into AFFiNE workspace storage and return its blob key. This creates stored content but does not attach it to a document by itself.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        content: z.string().describe("Base64-encoded file content or plain UTF-8 text to upload."),
        filename: z.string().optional().describe("Optional filename stored with the upload. Defaults to a generated .bin name."),
        contentType: z.string().optional().describe("Optional MIME type. Defaults to application/octet-stream.")
      }
    },
    uploadBlobHandler as any
  );

  // DELETE BLOB
  const deleteBlobHandler = async ({ workspaceId, key, permanently = false }: { workspaceId: string; key: string; permanently?: boolean }) => {
    try {
      const mutation = `
        mutation DeleteBlob($workspaceId: String!, $key: String!, $permanently: Boolean) {
          deleteBlob(workspaceId: $workspaceId, key: $key, permanently: $permanently)
        }
      `;
      
      const data = await gql.request<{ deleteBlob: boolean }>(mutation, {
        workspaceId,
        key,
        permanently
      });
      
      return text({ success: data.deleteBlob, key, workspaceId, permanently });
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "delete_blob",
    {
      title: "Delete Blob",
      description: "Delete a blob from AFFiNE workspace storage. Set permanently only when the blob should bypass recoverable deletion.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        key: z.string().describe("Blob key returned by upload_blob or AFFiNE document metadata."),
        permanently: z.boolean().optional().describe("If true, permanently delete the blob instead of marking it deleted.")
      }
    },
    deleteBlobHandler as any
  );

  // RELEASE DELETED BLOBS
  const cleanupBlobsHandler = async ({ workspaceId }: { workspaceId: string }) => {
    try {
      const mutation = `
        mutation ReleaseDeletedBlobs($workspaceId: String!) {
          releaseDeletedBlobs(workspaceId: $workspaceId)
        }
      `;
      
      const data = await gql.request<{ releaseDeletedBlobs: boolean }>(mutation, {
        workspaceId
      });
      
      return text({ success: true, workspaceId, blobsReleased: data.releaseDeletedBlobs });
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "cleanup_blobs",
    {
      title: "Cleanup Deleted Blobs",
      description: "Permanently release blobs that were already marked deleted in a workspace. This is destructive cleanup and should be used only after confirming deleted blobs are no longer needed.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id whose deleted blobs should be released.")
      }
    },
    cleanupBlobsHandler as any
  );
}
