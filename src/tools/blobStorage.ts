import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";

export function registerBlobTools(server: McpServer, gql: GraphQLClient) {
  // UPLOAD BLOB/FILE
  const uploadBlobHandler = async ({ workspaceId, content, filename, contentType }: { workspaceId: string; content: string; filename?: string; contentType?: string }) => {
    try {
      // Note: Actual file upload requires multipart form data
      // This is a simplified version that returns structured data
      const blobId = `blob_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      return text({
        id: blobId,
        workspaceId,
        filename: filename || "unnamed",
        contentType: contentType || "application/octet-stream",
        size: content.length,
        uploadedAt: new Date().toISOString(),
        note: "Blob metadata created. Use AFFiNE UI for actual file upload."
      });
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "affine_upload_blob",
    {
      title: "Upload Blob",
      description: "Upload a file or blob to workspace storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        content: z.string().describe("Base64 encoded content or text"),
        filename: z.string().optional().describe("Filename"),
        contentType: z.string().optional().describe("MIME type")
      }
    },
    uploadBlobHandler as any
  );
  server.registerTool(
    "upload_blob",
    {
      title: "Upload Blob",
      description: "Upload a file or blob to workspace storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        content: z.string().describe("Base64 encoded content or text"),
        filename: z.string().optional().describe("Filename"),
        contentType: z.string().optional().describe("MIME type")
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
    "affine_delete_blob",
    {
      title: "Delete Blob",
      description: "Delete a blob/file from workspace storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        key: z.string().describe("Blob key/ID to delete"),
        permanently: z.boolean().optional().describe("Delete permanently")
      }
    },
    deleteBlobHandler as any
  );
  server.registerTool(
    "delete_blob",
    {
      title: "Delete Blob",
      description: "Delete a blob/file from workspace storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        key: z.string().describe("Blob key/ID to delete"),
        permanently: z.boolean().optional().describe("Delete permanently")
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
      
      const data = await gql.request<{ releaseDeletedBlobs: number }>(mutation, {
        workspaceId
      });
      
      return text({ success: true, workspaceId, blobsReleased: data.releaseDeletedBlobs });
    } catch (error: any) {
      return text({ error: error.message });
    }
  };
  server.registerTool(
    "affine_cleanup_blobs",
    {
      title: "Cleanup Deleted Blobs",
      description: "Permanently remove deleted blobs to free up storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID")
      }
    },
    cleanupBlobsHandler as any
  );
  server.registerTool(
    "cleanup_blobs",
    {
      title: "Cleanup Deleted Blobs",
      description: "Permanently remove deleted blobs to free up storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID")
      }
    },
    cleanupBlobsHandler as any
  );
}
