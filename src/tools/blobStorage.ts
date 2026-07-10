import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text, toolError } from "../util/mcp.js";
import FormData from "form-data";
import fetch, { type Response } from "node-fetch";

export type BlobContentEncoding = "utf8" | "base64";

export type BlobUploadConfig = {
  maxDecodedBytes: number;
  timeoutMs: number;
  maxResponseBytes: number;
};

const DEFAULT_MAX_DECODED_BYTES = 25 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type BlobUploadGraphQLResponse = {
  data?: {
    setBlob?: unknown;
  };
  errors?: Array<{
    message?: unknown;
  }>;
};

class BlobUploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Blob upload timed out after ${timeoutMs}ms.`);
    this.name = "BlobUploadTimeoutError";
  }
}

function parsePositiveInteger(name: string, raw: string | undefined, fallback: number): number {
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

function cancelResponseBody(response: Response): void {
  const body = response.body as unknown as {
    destroy?: () => void;
    cancel?: () => Promise<void>;
  } | null;
  if (typeof body?.destroy === "function") {
    body.destroy();
    return;
  }
  if (typeof body?.cancel === "function") {
    void body.cancel().catch(() => undefined);
  }
}

async function readLimitedResponseBody(response: Response, maxResponseBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      cancelResponseBody(response);
      throw new Error(
        `Blob upload response declared ${declaredLength} bytes; the configured limit is ${maxResponseBytes} bytes.`,
      );
    }
  }

  if (!response.body) {
    return "";
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxResponseBytes) {
      cancelResponseBody(response);
      throw new Error(
        `Blob upload response exceeded the configured limit of ${maxResponseBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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

export function registerBlobTools(
  server: McpServer,
  gql: GraphQLClient,
  uploadConfig: BlobUploadConfig = loadBlobUploadConfig(),
) {
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
      const endpoint = gql.endpoint;
      const headers = gql.headers;
      const cookie = gql.cookie;
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

      const requestHeaders: Record<string, string> = {
        ...headers,
        ...form.getHeaders(),
      };
      if (cookie) {
        requestHeaders.Cookie = cookie;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), uploadConfig.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: requestHeaders,
          body: form as any,
          signal: controller.signal,
        });
        const responseBody = await readLimitedResponseBody(response, uploadConfig.maxResponseBytes);
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

      return text({ success: data.deleteBlob, key, workspaceId, permanently });
    } catch (error: any) {
      return toolError(error, {
        code: "blob_delete_failed",
        retryable: false,
        data: {
          kind: "blob.delete",
          status: "failed",
          workspaceId,
          key,
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

      return text({ success: data.releaseDeletedBlobs, workspaceId, blobsReleased: data.releaseDeletedBlobs });
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
        workspaceId: z.string().describe("AFFiNE workspace id whose deleted blobs should be released.")
      }
    },
    cleanupBlobsHandler as any
  );
}
