import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { createHash } from "node:crypto";
import { receipt, text, toolError, ToolFailure } from "../util/mcp.js";
import FormData from "form-data";
import fetch, { type Response } from "node-fetch";
import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { requireMatchingConfirmation } from "../util/inputSchemas.js";
import { readLimitedResponseBody, readLimitedResponseBuffer, cancelResponseBody } from "../util/httpResponse.js";
import { normalizeBlobSourceId } from "../urlSafety.js";
import { isLoopbackHostname } from "../networkSecurity.js";

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

/** Storage URLs come only from the configured AFFiNE server, never from callers. */
export function validateBlobRedirect(target: URL, source: URL): void {
  if (target.username || target.password) {
    throw new Error("Blob download redirect must not contain embedded credentials.");
  }
  // Preserve local development and explicitly configured same-origin HTTP, but
  // never downgrade HTTPS or silently extend insecure HTTP to another host.
  const localHttp = source.protocol === "http:" && target.protocol === "http:"
    && isLoopbackHostname(source.hostname) && isLoopbackHostname(target.hostname);
  if (target.protocol !== "https:" && !(target.origin === source.origin && target.protocol === "http:") && !localHttp) {
    throw new Error("Blob download redirected to an unsupported or insecure URL scheme.");
  }
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
      let resolved: string;
      try {
        resolved = realpathSync(entry);
      } catch {
        throw new Error(`AFFINE_BLOB_UPLOAD_FILE_ROOTS entry does not exist: ${entry}`);
      }
      if (!statSync(resolved).isDirectory()) {
        throw new Error(`AFFINE_BLOB_UPLOAD_FILE_ROOTS entry must be a directory: ${entry}`);
      }
      return resolved;
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
 * be swapped. Linux exposes the descriptor's canonical path through procfs, so
 * the check is bound to the opened file. Elsewhere the descriptor must be the
 * same inode the resolved path names now; that is best effort, because a
 * writer inside a root can still swap a parent directory back and forth around
 * the stat. Roots must therefore not be writable by untrusted local users.
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
  // Resolve again before comparing identity, to reject a parent that was
  // replaced with a symlink. This is still best effort on hosts without procfs:
  // repeated local directory swaps cannot be excluded by pathname checks.
  const currentPath = await realpath(resolvedPath).catch(() => null);
  if (!currentPath || !fileRoots.some((root) => isWithinRoot(currentPath, root))) {
    throw new Error(FILE_OUTSIDE_ROOTS_ERROR);
  }
  const [opened, current] = await Promise.all([handle.stat(), stat(currentPath).catch(() => null)]);
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

/** Read exactly the checked length, rejecting truncation instead of hanging a
 * length-delimited multipart request. Growth is intentionally excluded. */
export function createUploadFileStream(file: { handle: FileHandle; size: number }): Readable {
  return Readable.from((async function* () {
    let position = 0;
    while (position < file.size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - position));
      const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        throw new Error("Upload file was truncated while being read. Keep upload files unchanged until the request finishes.");
      }
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  })(), { objectMode: false });
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
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_GET_BLOB_MAX_BYTES) {
        throw new Error(`maxBytes must be a positive integer no greater than ${MAX_GET_BLOB_MAX_BYTES}.`);
      }
      const url = new URL(
        `${gql.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${encodeURIComponent(key)}`,
      );

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GET_BLOB_TIMEOUT_MS);
      let response: Response | undefined;
      try {
        // Bound authentication too. A late auth resolution must not start a request.
        const { headers } = await Promise.race([
          gql.getConnectionAuth(),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("Blob download timed out.")), { once: true });
          }),
        ]);
        response = await fetch(url, { headers, redirect: "manual", signal: controller.signal });
        // AFFiNE Cloud redirects to a pre-signed storage URL. Follow one hop and
        // send credentials only when the redirect stays on the AFFiNE origin.
        const location = response.status >= 300 && response.status < 400
          ? response.headers.get("location")
          : null;
        if (location) {
          cancelResponseBody(response);
          const target = new URL(location, url);
          validateBlobRedirect(target, url);
          response = await fetch(target, {
            headers: target.origin === url.origin ? headers : {},
            redirect: "error",
            signal: controller.signal,
          });
        }
        if (response.status === 404) {
          cancelResponseBody(response);
          throw new ToolFailure(
            `Blob ${key} was not found in workspace ${workspaceId}.`,
            "blob_not_found",
            "Check the key from the image or attachment block (affine://blob/<key>) and the workspaceId.",
          );
        }
        if (!response.ok) {
          cancelResponseBody(response);
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
        // node-fetch errors can include a signed storage URL. Never expose it.
        if (error instanceof Error && error.name === "FetchError") {
          const networkFailure = "type" in error && error.type === "system";
          throw new Error(networkFailure ? "Blob download fetch failed." : "Blob download request failed.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        if (response) cancelResponseBody(response);
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
    let fileBody: Readable | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), uploadConfig.timeoutMs);
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
      controller.signal.throwIfAborted();
      const { endpoint, headers } = await Promise.race([
        gql.getConnectionAuth(),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new BlobUploadTimeoutError(uploadConfig.timeoutMs)), { once: true });
        }),
      ]);

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
        fileBody = file.size === 0 ? undefined : createUploadFileStream(file);
        form.append("0", fileBody ?? Buffer.alloc(0), {
          filename: safeFilename,
          contentType: mime,
          knownLength: file.size,
        });
      } else {
        form.append("0", payload!, { filename: safeFilename, contentType: mime });
      }

      const requestHeaders = buildMultipartHeaders(headers, form.getHeaders());

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
      }
    } catch (error: any) {
      if (controller.signal.aborted) error = new BlobUploadTimeoutError(uploadConfig.timeoutMs);
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
      clearTimeout(timeout);
      fileBody?.destroy();
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
