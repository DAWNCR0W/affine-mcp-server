#!/usr/bin/env node
/**
 * Pure geometry rules behind image placement and updates.
 *
 * These states (stored size with a zero xywh, or an editor resize that leaves
 * xywh stale) are produced by the AFFiNE editor and cannot be created through
 * the MCP surface, so the rules are unit-tested directly.
 */
import assert from "node:assert/strict";

import {
  resolveImageUpdateGeometry,
  resolveSurfaceImageSize,
} from "../src/edgeless/layout.ts";

const zero = { x: 0, y: 0, width: 0, height: 0 };

// Updating only x must keep the stored dimensions and never write zero back.
assert.deepEqual(
  resolveImageUpdateGeometry({
    prev: zero,
    storedWidth: 640,
    storedHeight: 480,
    x: 10,
  }),
  { x: 10, y: 0, width: 640, height: 480, propWidth: 640, propHeight: 480 },
);

// A supplied dimension wins; the other one falls back to the stored value.
assert.deepEqual(
  resolveImageUpdateGeometry({
    prev: zero,
    storedWidth: 640,
    storedHeight: 480,
    width: 300,
  }),
  { x: 0, y: 0, width: 300, height: 480, propWidth: 300, propHeight: 480 },
);

// A non-zero xywh wins over stored dimensions when nothing is supplied.
assert.deepEqual(
  resolveImageUpdateGeometry({
    prev: { x: 5, y: 6, width: 200, height: 100 },
    storedWidth: 300,
    storedHeight: 150,
    x: 7,
  }),
  { x: 7, y: 6, width: 200, height: 100, propWidth: 200, propHeight: 100 },
);

// All-zero input returns no prop writes, so an existing value is left alone.
assert.deepEqual(
  resolveImageUpdateGeometry({ prev: zero, storedWidth: 0, storedHeight: 0, x: 1 }),
  { x: 1, y: 0, width: 0, height: 0, propWidth: undefined, propHeight: undefined },
);

// Page -> surface: the editor's newer stored size wins over stale xywh.
assert.deepEqual(
  resolveSurfaceImageSize({
    placed: { x: 0, y: 0, width: 200, height: 100 },
    storedWidth: 300,
    storedHeight: 150,
    preferStored: true,
  }),
  { x: 0, y: 0, width: 300, height: 150 },
);

// Surface -> surface: xywh stays authoritative.
assert.deepEqual(
  resolveSurfaceImageSize({
    placed: { x: 0, y: 0, width: 200, height: 100 },
    storedWidth: 300,
    storedHeight: 150,
    preferStored: false,
  }),
  { x: 0, y: 0, width: 200, height: 100 },
);

// Nothing known anywhere: fall back to 100x100.
assert.deepEqual(
  resolveSurfaceImageSize({ placed: zero, storedWidth: 0, storedHeight: 0, preferStored: false }),
  { x: 0, y: 0, width: 100, height: 100 },
);

// Missing xywh with a stored size: keep the stored size either way.
assert.deepEqual(
  resolveSurfaceImageSize({ placed: zero, storedWidth: 640, storedHeight: 480, preferStored: false }),
  { x: 0, y: 0, width: 640, height: 480 },
);
assert.deepEqual(
  resolveSurfaceImageSize({ placed: zero, storedWidth: 640, storedHeight: 480, preferStored: true }),
  { x: 0, y: 0, width: 640, height: 480 },
);

// Half-zero geometry keeps the nonzero placed dimension and fills the other.
assert.deepEqual(
  resolveSurfaceImageSize({
    placed: { x: 0, y: 0, width: 200, height: 0 },
    storedWidth: 0,
    storedHeight: 0,
    preferStored: true,
  }),
  { x: 0, y: 0, width: 200, height: 100 },
);

console.log("Image geometry rule tests passed");
