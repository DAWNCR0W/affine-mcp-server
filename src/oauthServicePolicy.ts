export function createToolFilterEnvironment(
  authMode: "bearer" | "oauth",
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  if (authMode === "oauth" && !resolved.AFFINE_TOOL_PROFILE?.trim()) {
    resolved.AFFINE_TOOL_PROFILE = "read_only";
  }
  return resolved;
}

export function assertOAuthServiceWritePolicy(input: {
  authMode: "bearer" | "oauth";
  allowServiceWrites: boolean;
  enabledWriteTools: readonly string[];
}): void {
  if (
    input.authMode === "oauth"
    && input.enabledWriteTools.length > 0
    && !input.allowServiceWrites
  ) {
    throw new Error(
      "OAuth mode uses one shared AFFiNE service identity. Write-capable tools require " +
      "AFFINE_OAUTH_ALLOW_SERVICE_WRITES=true. Prefer AFFINE_TOOL_PROFILE=read_only.",
    );
  }
}
