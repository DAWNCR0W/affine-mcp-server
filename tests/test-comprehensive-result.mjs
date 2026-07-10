#!/usr/bin/env node
import assert from "node:assert/strict";

import { getToolResultError } from "./support/comprehensive-result.mjs";

assert.equal(getToolResultError({ isError: true }, "Permission denied"), "Permission denied");
assert.equal(getToolResultError({ isError: true }, { error: "Mutation failed" }), "Mutation failed");
assert.equal(getToolResultError({ isError: true }, { status: "failed" }), '{"status":"failed"}');
assert.equal(getToolResultError({ isError: true }, null), "MCP tool returned isError=true");
assert.equal(getToolResultError({ isError: false }, "GraphQL error: unavailable"), "GraphQL error: unavailable");
assert.equal(getToolResultError({}, "ordinary text response"), null);
assert.equal(getToolResultError({}, { ok: true }), null);
assert.equal(
  getToolResultError({}, { ok: false, status: "failed" }),
  '{"ok":false,"status":"failed"}',
);
assert.equal(
  getToolResultError({}, { success: false, message: "Mutation was not confirmed" }),
  '{"success":false,"message":"Mutation was not confirmed"}',
);
assert.equal(
  getToolResultError({}, { status: "partial", requiresManualRepair: true }),
  '{"status":"partial","requiresManualRepair":true}',
);
assert.equal(
  getToolResultError({}, { status: "not_applied", applied: false }),
  '{"status":"not_applied","applied":false}',
);
assert.equal(getToolResultError({}, { ok: true, status: "deleted" }), null);
assert.equal(getToolResultError({}, { ok: true, status: "already_absent" }), null);

console.log("Comprehensive result handling tests passed");
