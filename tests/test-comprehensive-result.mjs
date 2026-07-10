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

console.log("Comprehensive result handling tests passed");
