#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertOAuthServiceWritePolicy,
  createToolFilterEnvironment,
} from "../dist/oauthServicePolicy.js";
import { createToolFilter } from "../dist/toolSurface.js";

const oauthDefaultEnvironment = createToolFilterEnvironment("oauth", {});
assert.equal(oauthDefaultEnvironment.AFFINE_TOOL_PROFILE, "read_only");
const oauthDefaultFilter = createToolFilter(oauthDefaultEnvironment);
assert.equal(oauthDefaultFilter.profile, "read_only");
assert.deepEqual(oauthDefaultFilter.enabledWriteTools, []);
assert.doesNotThrow(() => assertOAuthServiceWritePolicy({
  authMode: "oauth",
  allowServiceWrites: false,
  enabledWriteTools: oauthDefaultFilter.enabledWriteTools,
}));

const bearerDefaultEnvironment = createToolFilterEnvironment("bearer", {});
assert.equal(bearerDefaultEnvironment.AFFINE_TOOL_PROFILE, undefined);
const bearerDefaultFilter = createToolFilter(bearerDefaultEnvironment);
assert.equal(bearerDefaultFilter.profile, "full");
assert(bearerDefaultFilter.enabledWriteTools.length > 0);
assert.doesNotThrow(() => assertOAuthServiceWritePolicy({
  authMode: "bearer",
  allowServiceWrites: false,
  enabledWriteTools: bearerDefaultFilter.enabledWriteTools,
}));

for (const profile of ["full", "core", "authoring"]) {
  const filter = createToolFilter(createToolFilterEnvironment("oauth", {
    AFFINE_TOOL_PROFILE: profile,
  }));
  assert(filter.enabledWriteTools.length > 0, `${profile} must expose write tools`);
  assert.throws(
    () => assertOAuthServiceWritePolicy({
      authMode: "oauth",
      allowServiceWrites: false,
      enabledWriteTools: filter.enabledWriteTools,
    }),
    /AFFINE_OAUTH_ALLOW_SERVICE_WRITES=true/,
  );
  assert.doesNotThrow(() => assertOAuthServiceWritePolicy({
    authMode: "oauth",
    allowServiceWrites: true,
    enabledWriteTools: filter.enabledWriteTools,
  }));
}

const explicitlyRestrictedFullFilter = createToolFilter(
  createToolFilterEnvironment("oauth", {
    AFFINE_TOOL_PROFILE: "full",
    AFFINE_DISABLED_GROUPS: "write",
  }),
);
assert.deepEqual(explicitlyRestrictedFullFilter.enabledWriteTools, []);
assert.doesNotThrow(() => assertOAuthServiceWritePolicy({
  authMode: "oauth",
  allowServiceWrites: false,
  enabledWriteTools: explicitlyRestrictedFullFilter.enabledWriteTools,
}));

assert.throws(
  () => createToolFilter(
    createToolFilterEnvironment("oauth", { AFFINE_TOOL_PROFILE: "readonly" }),
  ),
  /Unknown AFFINE_TOOL_PROFILE "readonly"/,
);

const inputEnvironment = { AFFINE_DISABLED_TOOLS: "delete_doc" };
const resolvedEnvironment = createToolFilterEnvironment("oauth", inputEnvironment);
assert.notEqual(resolvedEnvironment, inputEnvironment);
assert.equal(inputEnvironment.AFFINE_TOOL_PROFILE, undefined, "input environment must not be mutated");

const projectDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const isolatedEnvironment = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(os.tmpdir(), `affine-oauth-policy-${process.pid}`),
  AFFINE_API_TOKEN: "test-service-token",
  AFFINE_MCP_AUTH_MODE: "oauth",
  AFFINE_OAUTH_ALLOW_SERVICE_WRITES: "false",
  AFFINE_TOOL_PROFILE: "full",
  AFFINE_DISABLED_GROUPS: "",
  AFFINE_DISABLED_TOOLS: "",
  MCP_TRANSPORT: "http",
};
const deniedProcess = spawnSync(process.execPath, ["dist/index.js"], {
  cwd: projectDirectory,
  env: isolatedEnvironment,
  encoding: "utf8",
  timeout: 5_000,
});
assert.equal(deniedProcess.status, 1);
assert.match(deniedProcess.stderr, /AFFINE_OAUTH_ALLOW_SERVICE_WRITES=true/);

const invalidBooleanProcess = spawnSync(process.execPath, ["dist/index.js"], {
  cwd: projectDirectory,
  env: {
    ...isolatedEnvironment,
    AFFINE_OAUTH_ALLOW_SERVICE_WRITES: "yes",
  },
  encoding: "utf8",
  timeout: 5_000,
});
assert.equal(invalidBooleanProcess.status, 1);
assert.match(invalidBooleanProcess.stderr, /must be ['"]true['"] or ['"]false['"]/);

console.log("OAuth service-account policy tests passed");
