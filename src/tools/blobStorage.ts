import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { createHash } from "node:crypto";
import { receipt, text, toolError, ToolFailure } from "../util/mcp.js";
import FormData from "form-data";
import fetch from "node-fetch";
import { requireMatchingConfirmation } from "../util/inputSchemas.js";
import { readLimitedResponseBody, readLimitedResponseBuffer } from "../util/httpResponse.js";
import { normalizeBlobSourceId } from "../urlSafety.js";

export type BlobContentEncoding = "utf8" | "base64";

export type BlobUploadConfig = {
  maxDecodedBytes: number;
  timeoutMs: number;
  maxResponseBytes: number;
};

const DEFAULT_MAX_DECODED_BYTES = 25 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MULTIPART_MANAGED_HEADERS = new Set([
  "content-length",
  "content-type",
  "transfer-encoding",
]);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type BlobUploadGraphQLResponse = {
  data?: {
    setBlob?: unknown;
  };
  errors?: Array<{
    message?: unknown;
  }>;
};

const DEFAULT_GET_BLOB_MAX_BYTES = 10 * 1024 * 1024;
const MAX_GET_BLOB_MAX_BYTES = 25 * 1024 * 1024;
const GET_BLOB_TIMEOUT_MS = 30_000;
const AFFINE_BLOB_PREFIX = "affine://blob/";
// Image types MCP clients render inline; anything else is returned as an embedded resource.
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Accept a raw blob key or an affine://blob/<key> reference and return the exact key. */
export function normalizeBlobKey(value: string): string {
  let key = value;
  if (key.startsWith(AFFINE_BLOB_PREFIX)) {
    try {
      key = decodeURIComponent(key.slice(AFFINE_BLOB_PREFIX.length));
    } catch {
      throw new Error("Blob reference contains invalid percent encoding.");
    }
  }
  key = normalizeBlobSourceId(key, "image");
  // encodeURIComponent keeps "." and "..", which URL resolution would treat as path traversal.
  if (!key || key === "." || key === "..") {
    throw new Error("Blob key must be a non-empty AFFiNE blob key.");
  }
  return key;
}

class BlobUploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Blob upload timed out after ${timeoutMs}ms.`);
    this.name = "BlobUploadTimeoutError";
  }
}

function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  max?: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must not exceed ${max}. Received: ${raw}`);
  }
  return parsed;
}

export function loadBlobUploadConfig(env: NodeJS.ProcessEnv = process.env): BlobUploadConfig {
  return {
    maxDecodedBytes: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_MAX_BYTES",
      env.AFFINE_BLOB_UPLOAD_MAX_BYTES,
      DEFAULT_MAX_DECODED_BYTES,
    ),
    timeoutMs: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_TIMEOUT_MS",
      env.AFFINE_BLOB_UPLOAD_TIMEOUT_MS,
      DEFAULT_UPLOAD_TIMEOUT_MS,
      MAX_TIMER_DELAY_MS,
    ),
    maxResponseBytes: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES",
      env.AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
    ),
  };
}

function assertWithinDecodedLimit(size: number, maxDecodedBytes: number): void {
  if (size > maxDecodedBytes) {
    throw new Error(`Blob content is ${size} bytes after decoding; the configured limit is ${maxDecodedBytes} bytes.`);
  }
}

export function decodeBlobContent(
  content: string,
  encoding: BlobContentEncoding = "utf8",
  maxDecodedBytes: number = DEFAULT_MAX_DECODED_BYTES,
): Buffer {
  if (encoding === "utf8") {
    const size = Buffer.byteLength(content, "utf8");
    assertWithinDecodedLimit(size, maxDecodedBytes);
    return Buffer.from(content, "utf8");
  }

  const normalized = content.replace(/[ \t\r\n\f]/g, "");
  if (!CANONICAL_BASE64.test(normalized)) {
    throw new Error("Blob content is not valid canonical Base64.");
  }

  const paddingBytes = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedSize = (normalized.length / 4) * 3 - paddingBytes;
  assertWithinDecodedLimit(decodedSize, maxDecodedBytes);

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error("Blob content is not valid canonical Base64.");
  }
  return decoded;
}

function parseUploadResponse(body: string): BlobUploadGraphQLResponse {
  if (!body) {
    throw new Error("Blob upload returned an empty response.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Blob upload returned a response that was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Blob upload returned a JSON value that was not an object.");
  }
  return parsed as BlobUploadGraphQLResponse;
}

function firstGraphQLError(result: BlobUploadGraphQLResponse): string | null {
  const message = result?.errors?.[0]?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function validateMultipartMetadata(value: string, label: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain null bytes or line breaks.`);
  }
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new Error(`${label} must not exceed 255 UTF-8 bytes.`);
  }
  return value;
}

function buildMultipartHeaders(
  headers: Record<string, string>,
  formHeaders: Record<string, string>,
): Record<string, string> {
  const preserved = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !MULTIPART_MANAGED_HEADERS.has(name.toLowerCase()),
    ),
  );
  return {
    ...preserved,
    ...formHeaders,
  };
}

export function registerBlobTools(
  server: McpServer,
  gql: GraphQLClient,
  uploadConfig: BlobUploadConfig = loadBlobUploadConfig(),
  defaults: { workspaceId?: string } = {},
) {
  // GET BLOB
  const getBlobHandler = async ({
    workspaceId: requestedWorkspaceId,
    key: rawKey,
    maxBytes = DEFAULT_GET_BLOB_MAX_BYTES,
  }: {
    workspaceId?: string;
    key: string;
    maxBytes?: number;
  }) => {
    const workspaceId = requestedWorkspaceId || defaults.workspaceId;
    try {
      if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
      // Like the key, a dot segment would be collapsed by URL resolution into another API route.
      if (workspaceId === "." || workspaceId === "..") {
        throw new Error("workspaceId must be a valid AFFiNE workspace id.");
      }
      const key = normalizeBlobKey(rawKey);
      const { headers } = await gql.getConnectionAuth();
      const url = new URL(
        `${gql.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${encodeURIComponent(key)}`,
      );

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GET_BLOB_TIMEOUT_MS);
      try {
        let response = await fetch(url, { headers, redirect: "manual", signal: controller.signal });
        // AFFiNE Cloud redirects to a pre-signed storage URL. Follow one hop and
        // send credentials only when the redirect stays on the AFFiNE origin.
        const location = response.status >= 300 && response.status < 400
          ? response.headers.get("location")
          : null;
        if (location) {
          response.body?.resume();
          const target = new URL(location, url);
          if (target.protocol !== "https:" && target.protocol !== url.protocol) {
            throw new Error("Blob download redirected to an unsupported URL scheme.");
          }
          response = await fetch(target, {
            headers: target.origin === url.origin ? headers : {},
            redirect: "error",
            signal: controller.signal,
          });
        }
        if (response.status === 404) {
          response.body?.resume();
          throw new ToolFailure(
            `Blob ${key} was not found in workspace ${workspaceId}.`,
            "blob_not_found",
            "Check the key from the image or attachment block (affine://blob/<key>) and the workspaceId.",
          );
        }
        if (!response.ok) {
          response.body?.resume();
          throw new Error(`Blob download failed with HTTP ${response.status}.`);
        }

        const payload = await readLimitedResponseBuffer(response, maxBytes, "Blob");
        const contentType = (response.headers.get("content-type") || "application/octet-stream")
          .split(";")[0].trim().toLowerCase();
        const result = text({
          workspaceId,
          key,
          contentType,
          size: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
        });
        const data = payload.toString("base64");
        const blobContent = INLINE_IMAGE_TYPES.has(contentType)
          ? { type: "image" as const, data, mimeType: contentType }
          : {
              type: "resource" as const,
              resource: { uri: `${AFFINE_BLOB_PREFIX}${encodeURIComponent(key)}`, mimeType: contentType, blob: data },
            };
        return { ...result, content: [...result.content, blobContent] };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`Blob download timed out after ${GET_BLOB_TIMEOUT_MS}ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error: any) {
      return toolError(error, {
        code: error instanceof ToolFailure ? error.code : "blob_read_failed",
        data: { kind: "blob.read", status: "failed", workspaceId, key: rawKey },
      });
    }
  };
  server.registerTool(
    "get_blob",
    {
      title: "Get Blob",
      description: "Download a blob from AFFiNE workspace storage, such as the file behind an image or attachment block. Images are returned as MCP image content; other files as an embedded base64 resource. Read-only.",
      inputSchema: {
        workspaceId: z.string().optional().describe("AFFiNE workspace id that owns the blob. Omit only when AFFINE_WORKSPACE_ID is configured."),
        key: z.string().min(1).describe("Blob key, or an affine://blob/<key> reference from an image or attachment block."),
        maxBytes: z.number().int().positive().max(MAX_GET_BLOB_MAX_BYTES).optional()
          .describe(`Refuse blobs larger than this many bytes. Defaults to ${DEFAULT_GET_BLOB_MAX_BYTES}.`),
      },
    },
    getBlobHandler as any
  );

  // UPLOAD BLOB/FILE
  const uploadBlobHandler = async ({
    workspaceId,
    content,
    encoding = "utf8",
    filename,
    contentType,
  }: {
    workspaceId: string;
    content: string;
    encoding?: BlobContentEncoding;
    filename?: string;
    contentType?: string;
  }) => {
    try {
      const { endpoint, headers } = await gql.getConnectionAuth();
      const payload = decodeBlobContent(content, encoding, uploadConfig.maxDecodedBytes);
      const safeFilename = validateMultipartMetadata(filename ?? `blob-${Date.now()}.bin`, "filename");
      const mime = validateMultipartMetadata(contentType ?? "application/octet-stream", "contentType");

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

      const requestHeaders = buildMultipartHeaders(headers, form.getHeaders());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), uploadConfig.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: requestHeaders,
          body: form as any,
          signal: controller.signal,
        });
        const responseBody = await readLimitedResponseBody(
          response,
          uploadConfig.maxResponseBytes,
          "Blob upload response",
        );
        let result: BlobUploadGraphQLResponse;
        try {
          result = parseUploadResponse(responseBody);
        } catch (error) {
          if (!response.ok) {
            throw new Error(`Blob upload failed with HTTP ${response.status}.`);
          }
          throw error;
        }

        const graphQLError = firstGraphQLError(result);
        if (!response.ok) {
          const detail = graphQLError ? `: ${graphQLError}` : "";
          throw new Error(`Blob upload failed with HTTP ${response.status}${detail}`);
        }
        if (graphQLError) {
          throw new Error(graphQLError);
        }
        const blobKey = result.data?.setBlob;
        if (typeof blobKey !== "string" || !blobKey.trim()) {
          throw new Error("Upload succeeded but no blob key was returned.");
        }

        return text({
          id: blobKey,
          key: blobKey,
          workspaceId,
          filename: safeFilename,
          contentType: mime,
          encoding,
          size: payload.length,
          uploadedAt: new Date().toISOString()
        });
      } catch (error: any) {
        if (controller.signal.aborted) {
          throw new BlobUploadTimeoutError(uploadConfig.timeoutMs);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error: any) {
      return toolError(error, {
        code: error instanceof BlobUploadTimeoutError
          ? "blob_upload_timeout"
          : "blob_upload_failed",
        retryable: false,
        data: {
          kind: "blob.upload",
          status: "failed",
          workspaceId,
          encoding,
        },
      });
    }
  };
  server.registerTool(
    "upload_blob",
    {
      title: "Upload Blob",
      description: "Upload a file or blob into AFFiNE workspace storage and return its blob key. This creates stored content but does not attach it to a document by itself.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        content: z.string().describe("Blob content encoded according to the encoding field."),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Content encoding. Defaults to utf8; use base64 explicitly for binary data."),
        filename: z.string().min(1).max(255).optional().describe("Optional filename stored with the upload. Defaults to a generated .bin name."),
        contentType: z.string().min(1).max(255).optional().describe("Optional MIME type. Defaults to application/octet-stream.")
      }
    },
    uploadBlobHandler as any
  );

  // DELETE BLOB
  const deleteBlobHandler = async ({ workspaceId, key, permanently = false, confirmKey }: { workspaceId: string; key: string; permanently?: boolean; confirmKey?: string }) => {
    try {
      if (permanently) {
        requireMatchingConfirmation("permanent delete_blob", key, confirmKey);
      }
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

      if (!data.deleteBlob) {
        return toolError("AFFiNE did not confirm blob deletion.", {
          code: "blob_delete_failed",
          retryable: false,
          data: {
            kind: "blob.delete",
            status: "not_applied",
            workspaceId,
            key,
            permanently,
            deleted: false,
          },
        });
      }

      return receipt("blob.delete", {
        status: "deleted",
        key,
        workspaceId,
        permanently,
        deleted: true,
        success: true,
      });
    } catch (error: any) {
      return toolError(error, {
        code: "blob_delete_failed",
        retryable: false,
        data: {
          kind: "blob.delete",
          status: "failed",
          key,
          workspaceId,
          permanently,
          deleted: false,
        },
      });
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
        permanently: z.boolean().optional().describe("If true, permanently delete the blob instead of marking it deleted."),
        confirmKey: z.string().optional().describe("Required when permanently=true and must exactly match key.")
      }
    },
    deleteBlobHandler as any
  );

  // RELEASE DELETED BLOBS
  const cleanupBlobsHandler = async ({ workspaceId, confirmWorkspaceId }: { workspaceId: string; confirmWorkspaceId?: string }) => {
    try {
      requireMatchingConfirmation("cleanup_blobs", workspaceId, confirmWorkspaceId);
      const mutation = `
        mutation ReleaseDeletedBlobs($workspaceId: String!) {
          releaseDeletedBlobs(workspaceId: $workspaceId)
        }
      `;
      
      const data = await gql.request<{ releaseDeletedBlobs: boolean }>(mutation, {
        workspaceId
      });

      if (!data.releaseDeletedBlobs) {
        return toolError("AFFiNE did not confirm deleted blob cleanup.", {
          code: "blob_cleanup_failed",
          retryable: false,
          data: {
            kind: "blob.cleanup",
            status: "not_applied",
            workspaceId,
            blobsReleased: false,
          },
        });
      }

      return receipt("blob.cleanup", {
        status: "completed",
        workspaceId,
        blobsReleased: true,
        success: true,
      });
    } catch (error: any) {
      return toolError(error, {
        code: "blob_cleanup_failed",
        retryable: false,
        data: {
          kind: "blob.cleanup",
          status: "failed",
          workspaceId,
          blobsReleased: false,
        },
      });
    }
  };
  server.registerTool(
    "cleanup_blobs",
    {
      title: "Cleanup Deleted Blobs",
      description: "Permanently release blobs that were already marked deleted in a workspace. This is destructive cleanup and should be used only after confirming deleted blobs are no longer needed.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id whose deleted blobs should be released."),
        confirmWorkspaceId: z.string().describe("Must exactly match workspaceId to confirm permanent blob cleanup.")
      }
    },
    cleanupBlobsHandler as any
  );
}
