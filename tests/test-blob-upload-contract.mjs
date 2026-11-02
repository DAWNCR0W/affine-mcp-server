#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fsPromises, { mkdir, mkdtemp, realpath, rm, symlink, writeFile, appendFile, truncate, rename } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decodeBlobContent,
  guessContentType,
  openUploadFile,
  createUploadFileStream,
  loadBlobUploadConfig,
  normalizeBlobKey,
  validateBlobRedirect,
  registerBlobTools,
} from "../dist/tools/blobStorage.js";
import { normalizeBlobSourceId } from "../dist/urlSafety.js";

function parseToolResult(result) {
  if (result?.structuredContent) {
    return result.structuredContent;
  }
  const raw = result?.content?.[0]?.text;
  return raw ? JSON.parse(raw) : null;
}

function expectToolFailure(result, expected, label) {
  const payload = parseToolResult(result);
  assert.equal(result.isError, true, `${label}: MCP isError`);
  assert.equal(payload.ok, false, `${label}: ok`);
  assert.equal(payload.code, expected.code, `${label}: code`);
  assert.equal(payload.retryable, expected.retryable, `${label}: retryable`);
  assert.equal(payload.status, expected.status, `${label}: status`);
  assert.equal("success" in payload, false, `${label}: failure must not include success`);
  if (expected.error) assert.match(payload.error, expected.error, `${label}: error`);
  return payload;
}

class ToolRegistry {
  tools = new Map();

  registerTool(name, _definition, handler) {
    this.tools.set(name, handler);
  }
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startUploadServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body;
    try { body = await readRequest(req); } catch { res.destroy(); return; }
    requests.push({ path: req.url, body, headers: req.headers });

    if (req.url === "/status") {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "payload rejected" }] }));
      return;
    }

    if (req.url === "/oversized") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":{"setBlob":"');
      res.end(`${"x".repeat(512)}"}}`);
      return;
    }

    if (req.url === "/timeout") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":');
      const timer = setTimeout(() => {
        if (!res.destroyed) {
          res.end('{"setBlob":"late-key"}}');
        }
      }, 1_000);
      req.once("aborted", () => clearTimeout(timer));
      res.once("close", () => clearTimeout(timer));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: {
        setBlob: req.url === "/opaque-key" ? "Folder/My image (1).png" : "blob-key",
      },
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}

function testContentDecoding() {
  assert.equal(decodeBlobContent("test").toString("utf8"), "test");
  assert.equal(decodeBlobContent("test").length, 4, "plain text must not be guessed as Base64");
  assert.equal(decodeBlobContent("  test\n", "utf8").toString("utf8"), "  test\n");
  assert.equal(decodeBlobContent("dGVz\ndA==", "base64").toString("utf8"), "test");

  assert.throws(
    () => decodeBlobContent("dGVzdA=", "base64"),
    /valid canonical Base64/,
  );
  assert.throws(
    () => decodeBlobContent("Zh==", "base64"),
    /valid canonical Base64/,
    "non-canonical padding bits must be rejected",
  );
  assert.throws(
    () => decodeBlobContent("hello", "utf8", 4),
    /configured limit is 4 bytes/,
  );
  assert.throws(
    () => decodeBlobContent("aGVsbG8=", "base64", 4),
    /configured limit is 4 bytes/,
  );
}

function testConfiguration() {
  assert.deepEqual(loadBlobUploadConfig({}), {
    maxDecodedBytes: 25 * 1024 * 1024,
    timeoutMs: 30_000,
    maxResponseBytes: 1024 * 1024,
    fileRoots: [],
  });
  assert.deepEqual(loadBlobUploadConfig({
    AFFINE_BLOB_UPLOAD_MAX_BYTES: "128",
    AFFINE_BLOB_UPLOAD_TIMEOUT_MS: "250",
    AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES: "512",
  }), {
    maxDecodedBytes: 128,
    timeoutMs: 250,
    maxResponseBytes: 512,
    fileRoots: [],
  });
  assert.throws(
    () => loadBlobUploadConfig({ AFFINE_BLOB_UPLOAD_MAX_BYTES: "0" }),
    /must be a positive integer/,
  );
  assert.throws(
    () => loadBlobUploadConfig({ AFFINE_BLOB_UPLOAD_TIMEOUT_MS: "1.5" }),
    /must be a positive integer/,
  );
  assert.throws(
    () => loadBlobUploadConfig({ AFFINE_BLOB_UPLOAD_TIMEOUT_MS: "2147483648" }),
    /must not exceed 2147483647/,
  );
  assert.throws(
    () => loadBlobUploadConfig({ AFFINE_BLOB_UPLOAD_FILE_ROOTS: "relative/dir" }),
    /must be absolute paths/,
  );
  assert.throws(
    () => loadBlobUploadConfig({ AFFINE_BLOB_UPLOAD_FILE_ROOTS: path.join(tmpdir(), "affine-mcp-missing-root-xyz") }),
    /does not exist/,
  );
}

async function testFileRootConfiguration(root) {
  const config = loadBlobUploadConfig({
    AFFINE_BLOB_UPLOAD_FILE_ROOTS: ` ${root}${path.delimiter}${path.delimiter}${path.join(root, "nested", "..")} `,
  });
  assert.deepEqual(config.fileRoots, [root, root], "roots are trimmed, empty entries dropped and realpath'd");
  assert.equal(guessContentType("/x/Photo.JPG"), "image/jpeg");
  assert.equal(guessContentType("/x/doc.pdf"), "application/pdf");
  assert.equal(guessContentType("/x/noext"), "application/octet-stream");
}

async function testToolContract() {
  const uploadServer = await startUploadServer();
  try {
    const registry = new ToolRegistry();
    const mutationBehavior = {
      cleanup: "false",
      delete: "false",
    };
    const gql = {
      endpoint: `${uploadServer.baseUrl}/success`,
      headers: {
        "x-test-header": "blob-contract",
        "Content-Type": "application/json",
        "CONTENT-LENGTH": "1",
        "Transfer-Encoding": "identity",
      },
      async getConnectionAuth() {
        return {
          endpoint: this.endpoint,
          headers: {
            ...this.headers,
            Cookie: "session=test-cookie",
          },
        };
      },
      async request(query) {
        if (query.includes("deleteBlob")) {
          if (mutationBehavior.delete === "throw") throw new Error("blob deletion timed out");
          return { deleteBlob: mutationBehavior.delete === "true" };
        }
        if (query.includes("releaseDeletedBlobs")) {
          if (mutationBehavior.cleanup === "throw") throw new Error("blob cleanup timed out");
          return { releaseDeletedBlobs: mutationBehavior.cleanup === "true" };
        }
        throw new Error("Unexpected GraphQL request in blob contract test.");
      },
    };
    registerBlobTools(registry, gql, {
      maxDecodedBytes: 16,
      timeoutMs: 100,
      maxResponseBytes: 128,
    });

    const uploadBlob = registry.tools.get("upload_blob");
    const deleteBlob = registry.tools.get("delete_blob");
    const cleanupBlobs = registry.tools.get("cleanup_blobs");
    assert.equal(typeof uploadBlob, "function");
    assert.equal(typeof deleteBlob, "function");
    assert.equal(typeof cleanupBlobs, "function");

    const utf8Result = parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      content: "test",
      filename: "plain.txt",
      contentType: "text/plain",
    }));
    assert.equal(utf8Result.key, "blob-key");
    assert.equal(utf8Result.encoding, "utf8");
    assert.equal(utf8Result.size, 4);

    const base64Result = parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      content: "AAECAw==",
      encoding: "base64",
      filename: "binary.bin",
    }));
    assert.equal(base64Result.encoding, "base64");
    assert.equal(base64Result.size, 4);

    gql.endpoint = `${uploadServer.baseUrl}/opaque-key`;
    const opaqueKeyResult = parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      content: "image",
      filename: "My image (1).png",
    }));
    assert.equal(opaqueKeyResult.key, "Folder/My image (1).png");
    assert.equal(normalizeBlobSourceId(opaqueKeyResult.key), opaqueKeyResult.key);
    gql.endpoint = uploadServer.baseUrl;

    assert.equal(uploadServer.requests[0].headers.cookie, "session=test-cookie");
    assert.equal(uploadServer.requests[0].headers["x-test-header"], "blob-contract");
    assert.match(uploadServer.requests[0].headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.notEqual(uploadServer.requests[0].headers["content-length"], "1");
    assert.notEqual(uploadServer.requests[0].headers["transfer-encoding"], "identity");
    assert.match(uploadServer.requests[0].body.toString("utf8"), /plain\.txt/);

    const tooLarge = expectToolFailure(await uploadBlob({
      workspaceId: "workspace-1",
      content: "x".repeat(17),
    }), {
      code: "blob_upload_failed",
      retryable: false,
      status: "failed",
      error: /configured limit is 16 bytes/,
    }, "oversized request");
    assert.equal(tooLarge.kind, "blob.upload");

    expectToolFailure(await uploadBlob({
      workspaceId: "workspace-1",
      content: "ok",
      filename: "unsafe\r\nname.txt",
    }), {
      code: "blob_upload_failed",
      retryable: false,
      status: "failed",
      error: /filename must not contain null bytes or line breaks/,
    }, "unsafe filename");

    gql.endpoint = `${uploadServer.baseUrl}/status`;
    expectToolFailure(await uploadBlob({
      workspaceId: "workspace-1",
      content: "ok",
    }), {
      code: "blob_upload_failed",
      retryable: false,
      status: "failed",
      error: /HTTP 413: payload rejected/,
    }, "HTTP status failure");

    gql.endpoint = `${uploadServer.baseUrl}/oversized`;
    expectToolFailure(await uploadBlob({
      workspaceId: "workspace-1",
      content: "ok",
    }), {
      code: "blob_upload_failed",
      retryable: false,
      status: "failed",
      error: /response exceeded the configured limit of 128 bytes/,
    }, "oversized response");

    gql.endpoint = `${uploadServer.baseUrl}/timeout`;
    expectToolFailure(await uploadBlob({
      workspaceId: "workspace-1",
      content: "ok",
    }), {
      code: "blob_upload_timeout",
      retryable: false,
      status: "failed",
      error: /timed out after 100ms/,
    }, "upload timeout");

    const deleteNotApplied = expectToolFailure(await deleteBlob({
      workspaceId: "workspace-1",
      key: "blob-key",
    }), {
      code: "blob_delete_failed",
      retryable: false,
      status: "not_applied",
      error: /did not confirm blob deletion/,
    }, "delete false result");
    assert.equal(deleteNotApplied.deleted, false);

    const cleanupNotApplied = expectToolFailure(
      await cleanupBlobs({
        workspaceId: "workspace-1",
        confirmWorkspaceId: "workspace-1",
      }),
      {
        code: "blob_cleanup_failed",
        retryable: false,
        status: "not_applied",
        error: /did not confirm deleted blob cleanup/,
      },
      "cleanup false result",
    );
    assert.equal(cleanupNotApplied.blobsReleased, false);

    mutationBehavior.delete = "throw";
    expectToolFailure(await deleteBlob({ workspaceId: "workspace-1", key: "blob-key" }), {
      code: "blob_delete_failed",
      retryable: false,
      status: "failed",
      error: /blob deletion timed out/,
    }, "delete exception");
    mutationBehavior.cleanup = "throw";
    expectToolFailure(await cleanupBlobs({
      workspaceId: "workspace-1",
      confirmWorkspaceId: "workspace-1",
    }), {
      code: "blob_cleanup_failed",
      retryable: false,
      status: "failed",
      error: /blob cleanup timed out/,
    }, "cleanup exception");

    mutationBehavior.delete = "true";
    mutationBehavior.cleanup = "true";
    assert.equal(parseToolResult(await deleteBlob({
      workspaceId: "workspace-1",
      key: "blob-key",
    })).success, true);
    assert.equal(parseToolResult(await cleanupBlobs({
      workspaceId: "workspace-1",
      confirmWorkspaceId: "workspace-1",
    })).success, true);
  } finally {
    await uploadServer.close();
  }
}

async function listen(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}

async function testGetBlobContract() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Stands in for a pre-signed object-storage URL on another origin.
  const storage = await listen((req, res) => {
    if (req.url.startsWith("/second-hop")) {
      res.writeHead(302, { location: "/must-not-follow" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  });
  const abandonedBodies = new Set();
  const affine = await listen((req, res) => {
    const blobs = "/api/workspaces/workspace-1/blobs/";
    if (req.url === `${blobs}card.png` || req.url === `${blobs}Folder%2FMy%20image%20(1).png`) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    } else if (req.url === `${blobs}notes.txt`) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("hello");
    } else if (req.url === `${blobs}redirected.png`) {
      res.writeHead(302, { location: `${storage.baseUrl}/signed/redirected.png?sig=abc` });
      res.end();
    } else if (req.url === `${blobs}same-origin.png`) {
      res.writeHead(302, { location: `${blobs}card.png` });
      res.end();
    } else if (req.url === `${blobs}credentials.png`) {
      res.writeHead(302, { location: storage.baseUrl.replace("http://", "http://leaked-user:leaked-password@") + "/signed" });
      res.end();
    } else if (req.url === `${blobs}second-hop.png`) {
      res.writeHead(302, { location: `${storage.baseUrl}/second-hop?secret=signed-secret` });
      res.end();
    } else if (req.url === `${blobs}chunked.png`) {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(png.subarray(0, 4));
      res.end(png.subarray(4));
    } else if (req.url === `${blobs}empty.bin`) {
      res.writeHead(200);
      res.end();
    } else if (req.url === `${blobs}hanging-error` || req.url === `${blobs}hanging-redirect` || req.url === `${blobs}hanging-success`) {
      const key = req.url.split("/").at(-1);
      res.once("close", () => abandonedBodies.add(key));
      res.writeHead(key === "hanging-error" ? 500 : key === "hanging-redirect" ? 302 : 200,
        key === "hanging-redirect" ? { location: `${blobs}card.png` } : {});
      res.write("never ending body");
    } else if (req.url === `${blobs}private.png`) {
      res.writeHead(401);
      res.end();
    } else if (req.url === "/api/workspaces/workspace-default/blobs/card.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const registry = new ToolRegistry();
    const gql = {
      baseUrl: affine.baseUrl,
      async getConnectionAuth() {
        return { endpoint: `${affine.baseUrl}/graphql`, headers: { Cookie: "session=test-cookie", Authorization: "Bearer test-token", "x-private-header": "private-header" } };
      },
    };
    registerBlobTools(registry, gql, undefined, { workspaceId: "workspace-default" });
    const getBlob = registry.tools.get("get_blob");
    assert.equal(typeof getBlob, "function");

    // Image blobs must be visible to MCP clients as image content, with verifiable metadata.
    const image = await getBlob({ workspaceId: "workspace-1", key: "card.png" });
    assert.equal(image.isError, undefined);
    assert.deepEqual(parseToolResult(image), {
      workspaceId: "workspace-1",
      key: "card.png",
      contentType: "image/png",
      size: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
    });
    assert.deepEqual(image.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });
    assert.equal(affine.requests.at(-1).headers.cookie, "session=test-cookie");

    // Block references (affine://blob/<url-encoded key>) resolve to the exact opaque key.
    const referenced = parseToolResult(await getBlob({
      workspaceId: "workspace-1",
      key: "affine://blob/Folder%2FMy%20image%20(1).png",
    }));
    assert.equal(referenced.key, "Folder/My image (1).png");
    assert.equal(affine.requests.at(-1).path, "/api/workspaces/workspace-1/blobs/Folder%2FMy%20image%20(1).png");

    const defaultWorkspace = parseToolResult(await getBlob({ key: "card.png" }));
    assert.equal(defaultWorkspace.workspaceId, "workspace-default");

    const textBlob = await getBlob({ workspaceId: "workspace-1", key: "notes.txt" });
    assert.equal(parseToolResult(textBlob).contentType, "text/plain");
    assert.equal(textBlob.content[1].type, "resource");
    assert.equal(Buffer.from(textBlob.content[1].resource.blob, "base64").toString("utf8"), "hello");

    // A cross-origin storage redirect must never receive AFFiNE credentials.
    const redirected = parseToolResult(await getBlob({ workspaceId: "workspace-1", key: "redirected.png" }));
    assert.equal(redirected.size, png.length);
    assert.equal(storage.requests.length, 1);
    assert.equal(storage.requests[0].headers.cookie, undefined);
    assert.equal(storage.requests[0].headers.authorization, undefined);
    assert.equal(storage.requests[0].headers["x-private-header"], undefined);

    assert.equal(parseToolResult(await getBlob({ workspaceId: "workspace-1", key: "same-origin.png" })).size, png.length);
    assert.equal(affine.requests.at(-1).headers.authorization, "Bearer test-token");
    const beforeCredentials = storage.requests.length;
    const credentials = await getBlob({ workspaceId: "workspace-1", key: "credentials.png" });
    assert.equal(credentials.isError, true);
    assert.equal(storage.requests.length, beforeCredentials, "embedded redirect credentials must never be sent");
    assert.doesNotMatch(JSON.stringify(credentials), /leaked-user|leaked-password/);

    const secondHop = await getBlob({ workspaceId: "workspace-1", key: "second-hop.png" });
    assert.equal(secondHop.isError, true);
    assert.doesNotMatch(JSON.stringify(secondHop), /signed-secret|second-hop\?secret=/);
    assert.equal(storage.requests.filter(request => request.path === "/must-not-follow").length, 0);

    const empty = await getBlob({ workspaceId: "workspace-1", key: "empty.bin" });
    assert.equal(parseToolResult(empty).size, 0);
    assert.equal(empty.content[1].resource.blob, "");
    assert.equal(parseToolResult(empty).contentType, "application/octet-stream");

    // Traversal keys would resolve to a different API route, so they are rejected before any request.
    assert.throws(() => normalizeBlobKey(".."), /non-empty AFFiNE blob key/);
    const requestCount = affine.requests.length;
    for (const key of ["..", "affine://blob/..", "affine://blob/", "affine://blob/%E0%A4%A", "bad\nkey"]) {
      expectToolFailure(await getBlob({ workspaceId: "workspace-1", key }), {
        code: "blob_read_failed",
        retryable: false,
        status: "failed",
      }, `invalid key ${JSON.stringify(key)}`);
    }
    for (const maxBytes of [0, -1, NaN, Infinity, 1.5, 25 * 1024 * 1024 + 1]) {
      assert.equal((await getBlob({ workspaceId: "workspace-1", key: "card.png", maxBytes })).isError, true);
    }
    for (const workspaceId of [".", ".."]) {
      expectToolFailure(await getBlob({ workspaceId, key: "image.png" }), {
        code: "blob_read_failed",
        retryable: false,
        status: "failed",
        error: /valid AFFiNE workspace id/,
      }, `invalid workspaceId ${JSON.stringify(workspaceId)}`);
    }
    assert.equal(normalizeBlobKey("a/../b"), "a/../b", "slashes stay inside one encoded path segment");
    assert.equal(affine.requests.length, requestCount);

    expectToolFailure(await getBlob({ workspaceId: "workspace-1", key: "missing.png" }), {
      code: "blob_not_found",
      retryable: false,
      status: "failed",
      error: /Blob missing\.png was not found in workspace workspace-1/,
    }, "missing blob");

    const unauthorized = expectToolFailure(await getBlob({ workspaceId: "workspace-1", key: "private.png" }), {
      code: "blob_read_failed",
      retryable: false,
      status: "failed",
      error: /HTTP 401/,
    }, "unauthorized blob");
    assert.equal(unauthorized.causeCode, "auth_required");
    assert.doesNotMatch(JSON.stringify(unauthorized), /test-cookie/);

    expectToolFailure(await getBlob({ workspaceId: "workspace-1", key: "card.png", maxBytes: 4 }), {
      code: "blob_read_failed",
      retryable: false,
      status: "failed",
      error: /configured limit (?:is|of) 4 bytes/,
    }, "oversized blob");
    assert.equal((await getBlob({ workspaceId: "workspace-1", key: "chunked.png", maxBytes: 4 })).isError, true);

    await getBlob({ workspaceId: "workspace-1", key: "hanging-error" });
    assert.equal(parseToolResult(await getBlob({ workspaceId: "workspace-1", key: "hanging-redirect" })).size, png.length);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert(abandonedBodies.has("hanging-error"), "error bodies must be destroyed, not drained indefinitely");
    assert(abandonedBodies.has("hanging-redirect"), "redirect bodies must be destroyed before following");

    // Accelerate only the production deadline; leave HTTP and socket timers alone.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 30_000 ? 30 : ms, ...args);
    try {
      const timedOut = await getBlob({ workspaceId: "workspace-1", key: "hanging-success" });
      assert.equal(timedOut.isError, true);
      assert.match(parseToolResult(timedOut).error, /timed out/);
      let resolveAuth;
      const pendingAuth = new Promise(resolve => { resolveAuth = resolve; });
      const pendingRegistry = new ToolRegistry();
      registerBlobTools(pendingRegistry, { baseUrl: affine.baseUrl, getConnectionAuth: () => pendingAuth });
      const beforeAuth = affine.requests.length;
      const authTimeout = await pendingRegistry.tools.get("get_blob")({ workspaceId: "workspace-1", key: "card.png" });
      assert.equal(authTimeout.isError, true);
      assert.match(parseToolResult(authTimeout).error, /timed out/);
      resolveAuth({ headers: {} });
      await new Promise(resolve => realSetTimeout(resolve, 20));
      assert.equal(affine.requests.length, beforeAuth, "late authentication must not start a download");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert(abandonedBodies.has("hanging-success"), "timeout must cancel the response body");
  } finally {
    await affine.close();
    await storage.close();
  }
}

function testRedirectPolicy() {
  const https = new URL("https://affine.example");
  for (const target of ["http://storage.example/file", "file:///etc/passwd", "ftp://storage.example/file", "https://user:password@storage.example/file"]) {
    assert.throws(() => validateBlobRedirect(new URL(target), https));
  }
  validateBlobRedirect(new URL("https://storage.example/file?signature=opaque"), https);
  validateBlobRedirect(new URL("http://127.0.0.1:5000/file"), new URL("http://localhost:3000"));
  assert.throws(() => validateBlobRedirect(new URL("http://other.example/file"), new URL("http://affine.example")));
}

async function testFilePathContract() {
  const uploadServer = await startUploadServer();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "affine-mcp-blob-")));
  try {
    const root = path.join(sandbox, "allowed");
    const outside = path.join(sandbox, "outside");
    await mkdir(path.join(root, "sub"), { recursive: true });
    await mkdir(outside);
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await writeFile(path.join(root, "sub", "frame.png"), imageBytes);
    await writeFile(path.join(root, "big.bin"), Buffer.alloc(17));
    await writeFile(path.join(root, "..dotted.txt"), "dotted");
    await writeFile(path.join(root, "empty.txt"), "");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
    await symlink(path.join(root, "sub", "frame.png"), path.join(root, "alias.png"));

    await testFileRootConfiguration(root);
    assert.throws(() => loadBlobUploadConfig({ AFFINE_BLOB_UPLOAD_FILE_ROOTS: path.join(root, "empty.txt") }), /must be a directory/);

    const gql = {
      async getConnectionAuth() {
        return { endpoint: uploadServer.baseUrl, headers: { Cookie: "session=test-cookie" } };
      },
    };
    const register = (fileRoots) => {
      const registry = new ToolRegistry();
      registerBlobTools(registry, gql, {
        maxDecodedBytes: 16,
        timeoutMs: 1_000,
        maxResponseBytes: 128,
        fileRoots,
      });
      return registry.tools.get("upload_blob");
    };
    const uploadBlob = register([root]);

    const uploaded = parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      filePath: path.join(root, "sub", "frame.png"),
    }));
    assert.equal(uploaded.key, "blob-key");
    assert.equal(uploaded.source, "file");
    assert.equal(uploaded.filename, "frame.png");
    assert.equal(uploaded.contentType, "image/png");
    assert.equal(uploaded.size, imageBytes.length);
    assert.equal("encoding" in uploaded, false, "file uploads do not report a content encoding");
    const request = uploadServer.requests.at(-1);
    assert.equal(request.headers.cookie, "session=test-cookie");
    assert.equal(Number(request.headers["content-length"]), request.body.length, "file upload must be length-delimited");
    assert.equal(request.headers["transfer-encoding"], undefined);
    assert.ok(request.body.includes(imageBytes), "multipart body carries the exact file bytes");
    assert.match(request.body.toString("latin1"), /filename="frame\.png"\r\nContent-Type: image\/png/);

    const overridden = parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      filePath: path.join(root, "alias.png"),
      filename: "storyboard.png",
      contentType: "image/x-custom",
    }));
    assert.equal(overridden.filename, "storyboard.png", "explicit filename wins over the basename");
    assert.equal(overridden.contentType, "image/x-custom");
    const dotted = parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      filePath: path.join(root, "..dotted.txt"),
    }));
    assert.equal(dotted.filename, "..dotted.txt", "names starting with '..' stay inside the root");
    assert.equal(dotted.contentType, "text/plain");
    const empty = parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      filePath: path.join(root, "empty.txt"),
    }));
    assert.equal(empty.size, 0);
    const emptyRequest = uploadServer.requests.at(-1);
    assert.equal(Number(emptyRequest.headers["content-length"]), emptyRequest.body.length, "empty file upload stays length-delimited");
    assert.equal(parseToolResult(await uploadBlob({
      workspaceId: "workspace-1",
      content: "inline",
    })).source, "content");

    const requestsBeforeRejections = uploadServer.requests.length;
    const rejected = async (args, error, label, upload = uploadBlob) => {
      const payload = expectToolFailure(await upload({ workspaceId: "workspace-1", ...args }), {
        code: "blob_upload_failed",
        retryable: false,
        status: "failed",
        error,
      }, label);
      assert.equal(payload.kind, "blob.upload");
      return payload;
    };

    const disabled = await rejected(
      { filePath: path.join(root, "sub", "frame.png") },
      /filePath uploads are disabled/,
      "file roots unset",
      register([]),
    );
    assert.equal(disabled.filePath, path.join(root, "sub", "frame.png"));
    assert.equal("encoding" in disabled, false);
    await rejected({ filePath: "sub/frame.png" }, /must be an absolute path/, "relative path");
    await rejected({ filePath: path.join(outside, "secret.txt") }, /not an accessible file inside AFFINE_BLOB_UPLOAD_FILE_ROOTS/, "outside root");
    await rejected({ filePath: path.join(root, "..", "outside", "secret.txt") }, /not an accessible file inside AFFINE_BLOB_UPLOAD_FILE_ROOTS/, "dot-dot escape");
    await rejected({ filePath: path.join(root, "escape.txt") }, /not an accessible file inside AFFINE_BLOB_UPLOAD_FILE_ROOTS/, "symlink escape");
    await rejected({ filePath: root }, /not an accessible file inside AFFINE_BLOB_UPLOAD_FILE_ROOTS/, "root itself");
    await rejected({ filePath: path.join(root, "sub") }, /must point to a regular file/, "directory");
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path.join(root, "pipe")]);
      await rejected({ filePath: path.join(root, "pipe") }, /must point to a regular file/, "fifo");
    }
    const missing = await rejected(
      { filePath: path.join(root, "missing.png") },
      /not an accessible file inside AFFINE_BLOB_UPLOAD_FILE_ROOTS/,
      "missing file",
    );
    assert.equal(missing.error.includes("missing.png"), false, "errors must not echo the supplied path");
    await rejected({ filePath: path.join(root, "big.bin") }, /configured limit is 16 bytes/, "oversized file");
    await rejected(
      { filePath: path.join(root, "sub", "frame.png"), content: "x" },
      /exactly one of content or filePath/,
      "both sources",
    );
    await rejected({}, /exactly one of content or filePath/, "no source");
    assert.equal(uploadServer.requests.length, requestsBeforeRejections, "rejected uploads must not reach AFFiNE");

    // A bounded stream never includes bytes appended after the descriptor check.
    const changingPath = path.join(root, "changing.txt");
    await writeFile(changingPath, "original");
    const growingFile = await openUploadFile(changingPath, [root], 16);
    try {
      await appendFile(changingPath, "extra beyond limit");
      const chunks = [];
      for await (const chunk of createUploadFileStream(growingFile)) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), "original");
    } finally { await growingFile.handle.close(); }

    await writeFile(changingPath, "original");
    const shrinkingFile = await openUploadFile(changingPath, [root], 16);
    try {
      await truncate(changingPath, 2);
      await assert.rejects(async () => {
        for await (const _chunk of createUploadFileStream(shrinkingFile)) { /* consume */ }
      }, /truncated/);
    } finally { await shrinkingFile.handle.close(); }

    // Track descriptors so pre-request failures and stalled authentication cannot leak them.
    const originalOpen = fsPromises.open;
    const handles = [];
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      handles.push(handle);
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await rejected({ filePath: path.join(root, "empty.txt"), filename: "bad\nname" }, /line breaks/, "invalid file metadata");
      assert.equal(handles.at(-1).fd, -1, "metadata failure closes the file");
      const pendingRegistry = new ToolRegistry();
      registerBlobTools(pendingRegistry, { getConnectionAuth: () => new Promise(() => {}) }, {
        maxDecodedBytes: 16, timeoutMs: 30, maxResponseBytes: 128, fileRoots: [root],
      });
      const timeoutResult = await pendingRegistry.tools.get("upload_blob")({ workspaceId: "workspace-1", filePath: path.join(root, "empty.txt") });
      assert.equal(parseToolResult(timeoutResult).code, "blob_upload_timeout");
      assert.equal(handles.at(-1).fd, -1, "authentication timeout closes the file");

      // Change the file after opening, before multipart creation, through the auth seam.
      await writeFile(changingPath, "original");
      const shrinkingRegistry = new ToolRegistry();
      registerBlobTools(shrinkingRegistry, { getConnectionAuth: async () => {
        await truncate(changingPath, 2);
        return { endpoint: uploadServer.baseUrl, headers: {} };
      } }, { maxDecodedBytes: 16, timeoutMs: 1_000, maxResponseBytes: 128, fileRoots: [root] });
      const shortUpload = await shrinkingRegistry.tools.get("upload_blob")({ workspaceId: "workspace-1", filePath: changingPath });
      assert.equal(shortUpload.isError, true);
      assert.equal(parseToolResult(shortUpload).code, "blob_upload_failed", "truncation fails promptly instead of waiting for timeout");
      assert.equal(handles.at(-1).fd, -1, "stream failure closes the file");
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }

    // Deterministically replace a parent after the first realpath. Exercise Linux
    // descriptor verification and the non-procfs algorithm (not a native macOS test).
    if (process.platform === "linux") {
      await writeFile(path.join(outside, "frame.png"), "outside-secret");
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const originalRealpath = fsPromises.realpath;
      for (const platform of ["linux", "darwin"]) {
        let swapped = false;
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
        fsPromises.realpath = async (...args) => {
          const resolved = await originalRealpath(...args);
          if (!swapped && args[0] === path.join(root, "sub", "frame.png")) {
            swapped = true;
            await rename(path.join(root, "sub"), path.join(root, "held"));
            await symlink(outside, path.join(root, "sub"));
          }
          return resolved;
        };
        syncBuiltinESMExports();
        try {
          await assert.rejects(() => openUploadFile(path.join(root, "sub", "frame.png"), [root], 16), /not an accessible file/);
        } finally {
          fsPromises.realpath = originalRealpath;
          syncBuiltinESMExports();
          Object.defineProperty(process, "platform", platformDescriptor);
          if (swapped) {
            await rm(path.join(root, "sub"));
            await rename(path.join(root, "held"), path.join(root, "sub"));
          }
        }
      }
    }
  } finally {
    await uploadServer.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

testRedirectPolicy();
testContentDecoding();
testConfiguration();
await testToolContract();
await testGetBlobContract();
await testFilePathContract();
console.log("Blob upload contract tests passed");
