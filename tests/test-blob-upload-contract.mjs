#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decodeBlobContent,
  guessContentType,
  loadBlobUploadConfig,
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
  } finally {
    await uploadServer.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

testContentDecoding();
testConfiguration();
await testToolContract();
await testFilePathContract();
console.log("Blob upload contract tests passed");
