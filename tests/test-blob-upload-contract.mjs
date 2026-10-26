#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";

import {
  decodeBlobContent,
  loadBlobUploadConfig,
  normalizeBlobKey,
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
    const body = await readRequest(req);
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
  });
  assert.deepEqual(loadBlobUploadConfig({
    AFFINE_BLOB_UPLOAD_MAX_BYTES: "128",
    AFFINE_BLOB_UPLOAD_TIMEOUT_MS: "250",
    AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES: "512",
  }), {
    maxDecodedBytes: 128,
    timeoutMs: 250,
    maxResponseBytes: 512,
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
  const storage = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  });
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
        return { endpoint: `${affine.baseUrl}/graphql`, headers: { Cookie: "session=test-cookie" } };
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
  } finally {
    await affine.close();
    await storage.close();
  }
}

testContentDecoding();
testConfiguration();
await testToolContract();
await testGetBlobContract();
console.log("Blob upload contract tests passed");
