import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import FormData from "form-data";
import fetch from "node-fetch";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { basename, extname } from "path";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
};

/**
 * Compute the blob key the same way AFFiNE's native UI does:
 * SHA-256 of the file content, base64url-encoded (no padding issues).
 * GraphQL setBlob returns the filename instead — causing "Failed to download image"
 * in the browser. REST PUT with this hash matches native behaviour exactly.
 */
function computeBlobKey(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBlobContent(content: string): Buffer {
  const normalized = content.trim().replace(/\s+/g, "");
  const base64Like = normalized.length >= 8 && normalized.length % 4 !== 1 && /^[A-Za-z0-9+/=]+$/.test(normalized);
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
  const uploadBlobHandler = async ({ workspaceId, filePath, content, filename, contentType }: {
    workspaceId: string;
    filePath?: string;
    content?: string;
    filename?: string;
    contentType?: string;
  }) => {
    try {
      const endpoint = gql.endpoint;
      const headers = gql.headers;
      const cookie = gql.cookie;

      let payload: Buffer;
      let safeFilename: string;
      let mime: string;

      // Resolve file path: explicit filePath param OR file:// URI in content
      const resolvedPath = filePath || (content?.startsWith("file://") ? content.slice(7) : null);
      if (resolvedPath) {
        if (!existsSync(resolvedPath)) {
          throw new Error(`File not found: ${resolvedPath}`);
        }
        payload = readFileSync(resolvedPath);
        safeFilename = filename || basename(resolvedPath);
        const ext = extname(resolvedPath).toLowerCase();
        mime = contentType || MIME_MAP[ext] || "application/octet-stream";
      } else {
        if (!content) throw new Error("Either filePath, file:// URI in content, or base64 content is required.");
        payload = decodeBlobContent(content);
        safeFilename = filename || `blob-${Date.now()}.bin`;
        mime = contentType || "application/octet-stream";
      }

      // Compute SHA-256 hash — AFFiNE native UI uses this as the blob key.
      // GraphQL setBlob returns the filename instead, causing broken images in browser.
      const blobKey = computeBlobKey(payload);

      // Upload via REST PUT (mirrors AFFiNE browser native upload mechanism)
      const baseUrl = endpoint.replace(/\/graphql$/, "");
      const blobUrl = `${baseUrl}/api/workspaces/${workspaceId}/blobs/${blobKey}`;
      const putResponse = await fetch(blobUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": mime },
        body: payload,
      });

      if (!putResponse.ok) {
        // Fallback: try GraphQL setBlob
        const form = new FormData();
        form.append("operations", JSON.stringify({
          query: `mutation SetBlob($workspaceId: String!, $blob: Upload!) {
            setBlob(workspaceId: $workspaceId, blob: $blob)
          }`,
          variables: { workspaceId, blob: null }
        }));
        form.append("map", JSON.stringify({ "0": ["variables.blob"] }));
        form.append("0", payload, { filename: safeFilename, contentType: mime });
        const gqlResponse = await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, Cookie: cookie, ...form.getHeaders() },
          body: form as any,
        });
        const result = await gqlResponse.json() as any;
        if (result.errors?.length) {
          throw new Error(`REST PUT failed (${putResponse.status}) and GraphQL fallback also failed: ${result.errors[0].message}`);
        }
        if (!result.data?.setBlob) {
          throw new Error(`REST PUT failed (${putResponse.status}) and GraphQL returned no key.`);
        }
        // GraphQL succeeded but returns filename-based key — warn so callers know
        return text({
          id: blobKey,
          key: blobKey,
          workspaceId,
          filename: safeFilename,
          contentType: mime,
          size: payload.length,
          uploadedAt: new Date().toISOString(),
          warning: "REST PUT failed; uploaded via GraphQL fallback. Browser may fail to load this blob."
        });
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
      description: "Upload a file or blob to workspace storage. Prefer filePath for local files (avoids base64 size limits). Use content only for small inline data. Returns a SHA-256-based blob key compatible with AFFiNE's native image rendering.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        filePath: z.string().optional().describe("Absolute path to a local file. Preferred over content for large files — server reads binary directly, no base64 size limits."),
        content: z.string().optional().describe("Base64-encoded file content or plain UTF-8 text. Use only when filePath is not available."),
        filename: z.string().optional().describe("Filename override (default: basename of filePath or blob-<ts>.bin)"),
        contentType: z.string().optional().describe("MIME type override")
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
      const data = await gql.request<{ deleteBlob: boolean }>(mutation, { workspaceId, key, permanently });
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
      const data = await gql.request<{ releaseDeletedBlobs: boolean }>(mutation, { workspaceId });
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
