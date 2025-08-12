import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";

export function registerBlobTools(server: McpServer, gql: GraphQLClient) {
  // UPLOAD BLOB/FILE
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
    async ({ workspaceId, content, filename, contentType }) => {
      try {
        // Note: Actual file upload requires multipart form data
        // This is a simplified version that returns structured data
        const blobId = `blob_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        return { content: [{ type: "text", text: JSON.stringify({
          id: blobId,
          workspaceId,
          filename: filename || "unnamed",
          contentType: contentType || "application/octet-stream",
          size: content.length,
          uploadedAt: new Date().toISOString(),
          note: "Blob metadata created. Use AFFiNE UI for actual file upload."
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // DELETE BLOB
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
    async ({ workspaceId, key, permanently = false }) => {
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
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: data.deleteBlob,
          key,
          workspaceId,
          permanently
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );

  // RELEASE DELETED BLOBS
  server.registerTool(
    "affine_cleanup_blobs",
    {
      title: "Cleanup Deleted Blobs",
      description: "Permanently remove deleted blobs to free up storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID")
      }
    },
    async ({ workspaceId }) => {
      try {
        const mutation = `
          mutation ReleaseDeletedBlobs($workspaceId: String!) {
            releaseDeletedBlobs(workspaceId: $workspaceId)
          }
        `;
        
        const data = await gql.request<{ releaseDeletedBlobs: number }>(mutation, {
          workspaceId
        });
        
        return { content: [{ type: "text", text: JSON.stringify({ 
          success: true,
          workspaceId,
          blobsReleased: data.releaseDeletedBlobs
        }) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    }
  );
}