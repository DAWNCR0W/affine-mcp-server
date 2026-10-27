import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { receipt, text, toolError } from "../util/mcp.js";
import FormData from "form-data";
import fetch from "node-fetch";
import { constants as fsConstants, realpathSync } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { requireMatchingConfirmation } from "../util/inputSchemas.js";
import { readLimitedResponseBody } from "../util/httpResponse.js";

export type BlobContentEncoding = "utf8" | "base64";

export type BlobUploadConfig = {
  maxDecodedBytes: number;
  timeoutMs: number;
  maxResponseBytes: number;
  fileRoots: string[];
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
const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};
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

function parseFileRoots(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!path.isAbsolute(entry)) {
        throw new Error(`AFFINE_BLOB_UPLOAD_FILE_ROOTS entries must be absolute paths. Received: ${entry}`);
      }
      try {
        return realpathSync(entry);
      } catch {
        throw new Error(`AFFINE_BLOB_UPLOAD_FILE_ROOTS entry does not exist: ${entry}`);
      }
    });
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
    fileRoots: parseFileRoots(env.AFFINE_BLOB_UPLOAD_FILE_ROOTS),
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

export function guessContentType(filePath: string): string {
  return CONTENT_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

const FILE_OUTSIDE_ROOTS_ERROR = "filePath is not an accessible file inside AFFINE_BLOB_UPLOAD_FILE_ROOTS.";

/**
 * Confirms that an opened descriptor still refers to a file inside the roots,
 * closing the window between realpath and open in which a path component could
 * be swapped. Linux exposes the descriptor's canonical path through procfs;
 * elsewhere the descriptor must be the same inode the resolved path names now.
 */
async function assertOpenedWithinRoots(
  handle: FileHandle,
  resolvedPath: string,
  fileRoots: string[],
): Promise<void> {
  if (process.platform === "linux") {
    try {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!fileRoots.some((root) => isWithinRoot(openedPath, root))) {
        throw new Error(FILE_OUTSIDE_ROOTS_ERROR);
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message === FILE_OUTSIDE_ROOTS_ERROR) {
        throw error;
      }
      // procfs unavailable: fall through to the inode comparison.
    }
  }
  const [opened, current] = await Promise.all([handle.stat(), stat(resolvedPath).catch(() => null)]);
  if (!current || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(FILE_OUTSIDE_ROOTS_ERROR);
  }
}

/**
 * Resolves filePath against the configured roots and opens it for reading.
 * Symlinks are resolved before the containment check, the opened descriptor is
 * checked again, and size/type are taken from that descriptor so they describe
 * the file that will be streamed.
 */
export async function openUploadFile(
  filePath: string,
  fileRoots: string[],
  maxDecodedBytes: number = DEFAULT_MAX_DECODED_BYTES,
): Promise<{ handle: FileHandle; resolvedPath: string; size: number }> {
  if (fileRoots.length === 0) {
    throw new Error("filePath uploads are disabled. Set AFFINE_BLOB_UPLOAD_FILE_ROOTS to the directories the server may read from.");
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error("filePath must be an absolute path.");
  }
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    // Same error as a rejected path, so callers cannot probe for files outside the roots.
    throw new Error(FILE_OUTSIDE_ROOTS_ERROR);
  }
  if (!fileRoots.some((root) => isWithinRoot(resolvedPath, root))) {
    throw new Error(FILE_OUTSIDE_ROOTS_ERROR);
  }

  // O_NONBLOCK keeps a FIFO from blocking the open before the regular-file check;
  // O_NOFOLLOW rejects a symlink planted at the resolved path after realpath.
  let handle: FileHandle;
  try {
    handle = await open(
      resolvedPath,
      fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(FILE_OUTSIDE_ROOTS_ERROR);
  }
  try {
    await assertOpenedWithinRoots(handle, resolvedPath, fileRoots);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("filePath must point to a regular file.");
    }
    assertWithinDecodedLimit(stats.size, maxDecodedBytes);
    return { handle, resolvedPath, size: stats.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
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
) {
  // UPLOAD BLOB/FILE
  const uploadBlobHandler = async ({
    workspaceId,
    content,
    filePath,
    encoding = "utf8",
    filename,
    contentType,
  }: {
    workspaceId: string;
    content?: string;
    filePath?: string;
    encoding?: BlobContentEncoding;
    filename?: string;
    contentType?: string;
  }) => {
    let file: Awaited<ReturnType<typeof openUploadFile>> | undefined;
    try {
      if ((content === undefined) === (filePath === undefined)) {
        throw new Error("Provide exactly one of content or filePath.");
      }
      let payload: Buffer | undefined;
      if (filePath !== undefined) {
        file = await openUploadFile(filePath, uploadConfig.fileRoots, uploadConfig.maxDecodedBytes);
      } else {
        payload = decodeBlobContent(content!, encoding, uploadConfig.maxDecodedBytes);
      }
      const safeFilename = validateMultipartMetadata(
        filename ?? (file ? path.basename(file.resolvedPath) : `blob-${Date.now()}.bin`),
        "filename",
      );
      const mime = validateMultipartMetadata(
        contentType ?? (file ? guessContentType(file.resolvedPath) : "application/octet-stream"),
        "contentType",
      );
      const { endpoint, headers } = await gql.getConnectionAuth();

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
      if (file) {
        // knownLength keeps the request length-delimited instead of chunked, and
        // the stream is bounded so a file growing after fstat cannot exceed it.
        const fileBody = file.size === 0
          ? Buffer.alloc(0)
          : file.handle.createReadStream({ autoClose: false, start: 0, end: file.size - 1 });
        form.append("0", fileBody, {
          filename: safeFilename,
          contentType: mime,
          knownLength: file.size,
        });
      } else {
        form.append("0", payload!, { filename: safeFilename, contentType: mime });
      }

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
          source: file ? "file" : "content",
          ...(file ? {} : { encoding }),
          size: file ? file.size : payload!.length,
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
          ...(filePath === undefined ? { encoding } : { filePath }),
        },
      });
    } finally {
      await file?.handle.close();
    }
  };
  server.registerTool(
    "upload_blob",
    {
      title: "Upload Blob",
      description: "Upload a file or blob into AFFiNE workspace storage and return its blob key. Pass either inline content or, when the server allows it, a local filePath. This creates stored content but does not attach it to a document by itself.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        content: z.string().optional().describe("Blob content encoded according to the encoding field. Mutually exclusive with filePath."),
        filePath: z.string().min(1).optional().describe("Absolute path of a file on the MCP server host to upload instead of content. Only works inside directories listed in AFFINE_BLOB_UPLOAD_FILE_ROOTS; prefer it for images and other binary files."),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Content encoding. Defaults to utf8; use base64 explicitly for binary data. Ignored for filePath."),
        filename: z.string().min(1).max(255).optional().describe("Optional filename stored with the upload. Defaults to the file's basename for filePath, otherwise a generated .bin name."),
        contentType: z.string().min(1).max(255).optional().describe("Optional MIME type. Defaults to a guess from the filePath extension, otherwise application/octet-stream.")
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
