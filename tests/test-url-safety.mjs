#!/usr/bin/env node
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';
import {
  blobSourceIdToUrl,
  isSafeBlobSourceIdInput,
  isSafeIframeUrlInput,
  isSafeUrlInput,
  normalizeBlobSourceId,
  normalizeBlockUrl,
  normalizeUrlBearingBlockFields,
} from '../dist/urlSafety.js';

function testBookmarkSchemesAndInternalBlobUrls() {
  const allowed = [
    'https://example.com/path?query=value#section',
    'http://localhost:3010/doc',
    'mailto:test@example.com',
    'tel:+12025550123',
    'affine://blob/fake-source-id',
    'affine://doc/document-id',
  ];
  for (const url of allowed) {
    assert.equal(normalizeBlockUrl(`  ${url}  `, 'bookmark'), url);
    assert.equal(isSafeUrlInput(url), true, url);
  }

  const rejected = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'mailto:test@example.com?body=%0aInjected',
    'https://user:password@example.com',
    'https:\\example.com\\path',
    'https://example.com\n.evil.test',
    'https://example.com\u0000.evil.test',
    'https://example.com\u2028.evil.test',
    'affine://blob/',
    'affine://blob/fake-source-id?download=1',
  ];
  for (const url of rejected) {
    assert.throws(() => normalizeBlockUrl(url, 'bookmark'), undefined, url);
    assert.equal(isSafeUrlInput(url), false, url);
  }

  assert.equal(normalizeBlockUrl('affine://blob/%66oo', 'bookmark'), 'affine://blob/foo');
  assert.equal(
    normalizeBlockUrl('affine://blob/Folder%2FMy%20image%20(1).png', 'bookmark'),
    'affine://blob/Folder%2FMy%20image%20(1).png',
  );
}

function testProviderSpecificHosts() {
  const accepted = [
    ['embed_youtube', 'https://www.youtube.com/watch?v=video-id'],
    ['embed_youtube', 'https://youtu.be/video-id'],
    ['embed_youtube', 'https://www.youtube-nocookie.com/embed/video-id'],
    ['embed_github', 'https://github.com/toeverything/AFFiNE/pull/11796'],
    ['embed_figma', 'https://www.figma.com/design/file-id'],
    ['embed_loom', 'https://www.loom.com/share/video-id'],
  ];
  for (const [type, url] of accepted) {
    assert.equal(normalizeBlockUrl(url, type), url, `${type}: ${url}`);
  }
  assert.equal(
    normalizeBlockUrl('HTTPS://%79outube.com./a/%2e%2e/watch?v=video-id', 'embed_youtube'),
    'https://youtube.com/watch?v=video-id',
  );

  const rejected = [
    ['embed_youtube', 'http://www.youtube.com/watch?v=video-id'],
    ['embed_youtube', 'https://youtube.com.evil.test/watch?v=video-id'],
    ['embed_youtube', 'https://evil.youtube.com/watch?v=video-id'],
    ['embed_youtube', 'https://www.youtube.com:8443/watch?v=video-id'],
    ['embed_youtube', 'https://www.youtube.com@evil.test/watch?v=video-id'],
    ['embed_github', 'https://gist.github.com/user/id'],
    ['embed_github', 'https://github.example.com/org/repo/issues/1'],
    ['embed_figma', 'https://figma.com.evil.test/design/file-id'],
    ['embed_loom', 'https://loom.example.com/share/video-id'],
    ['embed_loom', 'javascript:alert(1)'],
  ];
  for (const [type, url] of rejected) {
    assert.throws(() => normalizeBlockUrl(url, type), undefined, `${type}: ${url}`);
  }
}

function testIframePolicyAndOverride() {
  for (const url of ['https://example.com/embed', 'http://localhost:8080/embed']) {
    assert.equal(normalizeBlockUrl(url, 'embed_iframe'), url);
    assert.equal(normalizeBlockUrl(url, 'embed_iframe', 'iframeUrl'), url);
    assert.equal(isSafeIframeUrlInput(url), true);
  }

  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<h1>unsafe</h1>',
    'file:///etc/passwd',
    'mailto:test@example.com',
    'affine://blob/fake-source-id',
    'https://user:password@example.com/embed',
    'https://example.com\n.evil.test/embed',
    'https://example.com/%0aevil',
  ]) {
    assert.throws(() => normalizeBlockUrl(url, 'embed_iframe', 'iframeUrl'), undefined, url);
    assert.equal(isSafeIframeUrlInput(url), false, url);
  }

  assert.throws(() => normalizeUrlBearingBlockFields({
    type: 'embed_iframe',
    url: 'https://example.com/card',
    iframeUrl: 'javascript:alert(1)',
  }));
}

function testOpaqueBlobSourceIds() {
  for (const sourceId of [
    'fake-source-id',
    'template-attachment-source',
    '_blob.key~123',
    'Folder/My image (1).png',
    'https://example.com/image.png',
    ' blob key ',
  ]) {
    assert.equal(normalizeBlobSourceId(sourceId), sourceId);
    assert.equal(isSafeBlobSourceIdInput(sourceId), true);
  }

  for (const sourceId of [
    'blob\nkey',
    'x'.repeat(2_049),
  ]) {
    assert.throws(() => normalizeBlobSourceId(sourceId), undefined, sourceId);
    assert.equal(isSafeBlobSourceIdInput(sourceId), false, sourceId);
  }
  assert.equal(normalizeBlobSourceId('   '), '');
  assert.equal(isSafeBlobSourceIdInput('   '), false);

  const opaqueUrlShapedKey = normalizeUrlBearingBlockFields({
    type: 'attachment',
    sourceId: 'file:///tmp/payload',
  });
  assert.equal(opaqueUrlShapedKey.sourceId, 'file:///tmp/payload');
  assert.equal(
    blobSourceIdToUrl('Folder/My image (1).png'),
    'affine://blob/Folder%2FMy%20image%20(1).png',
  );
}

function testRuntimeNormalizationAndMarkdownImportPath() {
  const normalized = normalizeUrlBearingBlockFields({
    type: 'embed_youtube',
    url: '  https://www.youtube.com/watch?v=video-id  ',
  });
  assert.equal(normalized.url, 'https://www.youtube.com/watch?v=video-id');

  assert.throws(() => normalizeUrlBearingBlockFields({
    type: 'embed_youtube',
    url: 'https://youtube.com.evil.test/watch?v=video-id',
  }));

  const affineImage = parseMarkdownToOperations('![image](affine://blob/fake-source-id)');
  assert.equal(affineImage.operations[0]?.type, 'bookmark');
  assert.equal(normalizeUrlBearingBlockFields({
    type: affineImage.operations[0].type,
    url: affineImage.operations[0].url,
  }).url, 'affine://blob/fake-source-id');

  const internalDoc = parseMarkdownToOperations('[Internal doc](affine://doc/document-id)');
  assert.equal(internalDoc.operations[0]?.type, 'bookmark');
  assert.equal(normalizeUrlBearingBlockFields({
    type: internalDoc.operations[0].type,
    url: internalDoc.operations[0].url,
  }).url, 'affine://doc/document-id');

  const dataImage = parseMarkdownToOperations('![image](data:image/png;base64,abc)');
  assert.equal(dataImage.operations[0]?.type, 'bookmark');
  assert.throws(() => normalizeUrlBearingBlockFields({
    type: dataImage.operations[0].type,
    url: dataImage.operations[0].url,
  }), undefined, 'Markdown image imports must not bypass runtime URL validation');
}

testBookmarkSchemesAndInternalBlobUrls();
testProviderSpecificHosts();
testIframePolicyAndOverride();
testOpaqueBlobSourceIds();
testRuntimeNormalizationAndMarkdownImportPath();
console.log('External URL safety tests passed');
