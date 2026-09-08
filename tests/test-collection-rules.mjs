#!/usr/bin/env node
import assert from "node:assert/strict";
import { z } from "zod";

import { registerOrganizeTools } from "../dist/tools/organize.js";

const registered = new Map();
let authCalls = 0;
const gql = {
  async getConnectionAuth() {
    authCalls += 1;
    throw new Error("Unexpected AFFiNE connection in collection rule contract test.");
  },
};

registerOrganizeTools({
  registerTool(name, definition, handler) {
    registered.set(name, { definition, handler });
  },
}, gql, {});

function inputSchema(name) {
  const definition = registered.get(name)?.definition;
  assert(definition, `${name} must be registered`);
  return z.object(definition.inputSchema);
}

const updateSchema = inputSchema("update_collection_rules");
const createSchema = inputSchema("create_collection");

const validFilters = [
  { field: "title", operator: "contains", value: "  project " },
  { field: "title", operator: "equals", value: " Project " },
  { field: "title", operator: "startsWith", value: "  Pro " },
  { field: "tag", operator: "contains", value: "  proj " },
  { field: "tag", operator: "equals", value: " Project " },
  { field: "docId", operator: "equals", value: "  doc-1 " },
  { field: "docId", operator: "in", value: [" doc-1 ", "doc-2"] },
];
const valid = updateSchema.safeParse({
  workspaceId: "workspace-1",
  collectionId: "collection-1",
  rules: { match: "all", filters: validFilters },
});
assert.equal(valid.success, true, "supported collection rule combinations must be accepted");
assert.deepEqual(valid.data.rules.filters, [
  { field: "title", operator: "contains", value: "project" },
  { field: "title", operator: "equals", value: "Project" },
  { field: "title", operator: "startsWith", value: "Pro" },
  { field: "tag", operator: "contains", value: "proj" },
  { field: "tag", operator: "equals", value: "Project" },
  { field: "docId", operator: "equals", value: "doc-1" },
  { field: "docId", operator: "in", value: ["doc-1", "doc-2"] },
]);

const invalidFilters = [
  { field: "title", operator: "in", value: ["doc-1"] },
  { field: "tag", operator: "startsWith", value: "project" },
  { field: "tag", operator: "in", value: ["project"] },
  { field: "docId", operator: "contains", value: "doc" },
  { field: "docId", operator: "startsWith", value: "doc" },
  { field: "title", operator: "contains", value: ["project"] },
  { field: "docId", operator: "equals", value: ["doc-1"] },
  { field: "docId", operator: "in", value: "doc-1" },
  { field: "docId", operator: "in", value: ["doc-1", 2] },
  { field: "docId", operator: "in", value: [null] },
  { field: "docId", operator: "in", value: [] },
  { field: "docId", operator: "in", value: ["  ", "\t"] },
  { field: "tag", operator: "equals", value: "   " },
  { field: "title", operator: "contains", value: "\n\t" },
];
for (const filter of invalidFilters) {
  assert.equal(
    updateSchema.safeParse({
      workspaceId: "workspace-1",
      collectionId: "collection-1",
      rules: { filters: [filter] },
    }).success,
    false,
    `invalid collection rule must be rejected: ${JSON.stringify(filter)}`,
  );
}

const mixedInvalidRules = {
  match: "any",
  filters: [
    { field: "title", operator: "contains", value: "project" },
    { field: "title", operator: "in", value: ["legacy-invalid"] },
  ],
};
assert.equal(
  updateSchema.safeParse({
    workspaceId: "workspace-1",
    collectionId: "collection-1",
    rules: mixedInvalidRules,
  }).success,
  false,
  "a mixed valid and invalid filter set must be rejected as a whole",
);

await assert.rejects(
  () => registered.get("update_collection_rules").handler({
    workspaceId: "workspace-1",
    collectionId: "collection-1",
    rules: mixedInvalidRules,
  }),
  "direct handler validation must reject malformed rules before connecting",
);
assert.equal(authCalls, 0, "malformed collection rules must not reach AFFiNE");

const createInvalid = await createSchema.safeParseAsync({
  workspaceId: "workspace-1",
  name: "Collection",
  rules: { filters: [{ field: "title", operator: "in", value: ["x"] }] },
});
assert.equal(createInvalid.success, false, "create_collection must share the strict rule contract");

console.log("Collection rule contract tests passed");
