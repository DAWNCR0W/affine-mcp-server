function cloneJsonValue<T>(data: T): T {
  if (data === undefined) {
    return data;
  }
  return JSON.parse(JSON.stringify(data)) as T;
}

export function text(data: unknown) {
  if (typeof data === "string") {
    return {
      content: [{ type: "text" as const, text: data }],
      structuredContent: { text: data },
    };
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const structuredContent = cloneJsonValue(data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }

  if (Array.isArray(data)) {
    const items = cloneJsonValue(data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(items) }],
      structuredContent: { items },
    };
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: { value: cloneJsonValue(data) },
  };
}

/**
 * The MCP SDK converts Zod v3 schemas with zod-to-json-schema, which stamps every
 * advertised tool schema with `"$schema": "http://json-schema.org/draft-07/schema#"`.
 * Clients that reject an explicitly declared draft-07 dialect cannot discover those tools.
 * Removing the marker leaves schema interpretation to the client context.
 */
export function stripSchemaDialect(server: { server?: unknown }): void {
  const handlers = (server.server as { _requestHandlers?: Map<string, Function> } | undefined)?._requestHandlers;
  if (!(handlers instanceof Map)) {
    throw new Error(
      "[affine-mcp] Server request handlers not found - the advertised JSON Schema dialect cannot be " +
      "normalized. The MCP SDK API may have changed. Refusing to start because clients that support " +
      "JSON Schema 2020-12 only would reject every tool.",
    );
  }
  // No handler until the first tool is registered; a fully filtered surface has nothing to fix.
  const listTools = handlers.get("tools/list");
  if (!listTools) return;
  handlers.set("tools/list", async (...args: unknown[]) => {
    const result = await listTools(...args);
    for (const tool of (result as { tools?: Array<Record<string, any>> })?.tools ?? []) {
      delete tool.inputSchema?.$schema;
      delete tool.outputSchema?.$schema;
    }
    return result;
  });
}

export type ToolErrorOptions = {
  code?: string;
  retryable?: boolean;
  recoveryGuidance?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

/** A failure whose cause is known without asking clients to parse backend text. */
export class ToolFailure extends Error {
  constructor(message: string, readonly code: string, readonly recoveryGuidance?: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown tool error";
}

function failureCode(error: unknown): string {
  if (error instanceof ToolFailure) return error.code;
  const message = errorMessage(error);
  if (/(?:HTTP|status|sign-in failed:)\s*401\b|UNAUTHENTICATED|AUTHENTICATION_REQUIRED|SESSION_EXPIRED|INVALID_TOKEN|no authentication configured|GraphQL error: (?:unauthorized|authentication required|not authenticated|session expired)\b/i.test(message)) return "auth_required";
  if (/(?:HTTP|status|sign-in failed:)\s*403\b|FORBIDDEN|ACCESS_DENIED|PERMISSION_DENIED/i.test(message)) return "access_denied";
  if (/workspaceId.*required|workspace id.*required/i.test(message)) return "workspace_required";
  if (/(?:HTTP|status)\s*429\b|rate limit|too many requests/i.test(message)) return "rate_limited";
  if (/timeout|timed out|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|(?:HTTP|status)\s*50[0234]\b/i.test(message)) return "upstream_unavailable";
  if (error instanceof Error && error.name === "ZodError") return "invalid_arguments";
  return "tool_error";
}

function recoveryFor(code: string): string {
  switch (code) {
    case "auth_required":
      return "Run affine-mcp login, then restart or reconnect this MCP server. If your client embeds AFFINE_COOKIE or another credential, remove or refresh that copied value; environment credentials override saved login settings.";
    case "access_denied":
      return "Check the active account and workspace with affine-mcp status and affine-mcp workspaces. Confirm that the account has permission for this operation; logging in again does not grant missing permissions.";
    case "workspace_required":
      return "Call list_workspaces and pass the chosen workspaceId, or run affine-mcp workspace to set a default and then restart or reconnect the MCP server.";
    case "workspace_root_unavailable":
      return "The workspace contents could not be confirmed. Check the workspace in AFFiNE and run affine-mcp doctor; do not treat this as an empty workspace.";
    case "rate_limited":
      return "Wait before retrying. For a write, inspect the target first to determine whether it already completed.";
    case "upstream_unavailable":
      return "Check AFFiNE connectivity with affine-mcp doctor. For a write, read the target before retrying because the server may have applied it before the connection failed.";
    case "invalid_arguments":
      return "Check this tool's input schema, correct the indicated fields, and try again.";
    default:
      return "Check the error details and active workspace. For a write, inspect the target before retrying to avoid duplicating a completed change.";
  }
}

/** Return a machine-readable MCP failure while preserving the legacy error string. */
export function toolError(error: unknown, options: ToolErrorOptions = {}) {
  const classified = failureCode(error);
  const code = options.code || classified;
  const result = text({
    ...(options.data || {}),
    ok: false,
    error: errorMessage(error),
    code,
    ...(classified !== "tool_error" && classified !== code ? { causeCode: classified } : {}),
    retryable: options.retryable ?? false,
    recoveryGuidance: options.recoveryGuidance
      || (typeof options.data?.recoveryGuidance === "string" ? options.data.recoveryGuidance : undefined)
      || (error instanceof ToolFailure ? error.recoveryGuidance : undefined)
      || recoveryFor(classified === "tool_error" ? code : classified),
    ...(options.details ? { details: cloneJsonValue(options.details) } : {}),
  });
  return {
    ...result,
    isError: true,
  };
}

/** Normalize every handler failure while preserving specific partial-write receipts. */
export function withToolErrors<T extends (...args: any[]) => any>(
  handler: T,
  context: { toolName: string; authMode: "bearer" | "oauth"; readOnly: boolean },
) {
  return async (...args: Parameters<T>) => {
    try {
      const result = await handler(...args);
      if (!result?.isError || !result.structuredContent) return result;
      const payload = result.structuredContent;
      return normalize(payload.error || "Tool operation failed", payload);
    } catch (error) {
      return normalize(error);
    }

    function normalize(error: unknown, payload?: Record<string, any>) {
      const classified = failureCode(error);
      const result = toolError(error, {
        code: payload?.code,
        data: payload,
        retryable: payload?.retryable ?? (context.readOnly && ["upstream_unavailable", "rate_limited"].includes(classified)),
        recoveryGuidance: payload?.recoveryGuidance,
        details: payload?.details,
      });
      const normalized = result.structuredContent as Record<string, unknown> & { code: string };
      if (context.authMode === "oauth" && (normalized.code === "auth_required" || normalized.causeCode === "auth_required")) {
        return toolError(error, {
          code: normalized.code,
          data: normalized,
          recoveryGuidance: "Ask the MCP server operator to refresh its AFFiNE service credentials and restart the server. If the MCP connection itself requests authorization, reconnect using your client's OAuth flow.",
        });
      }
      return result;
    }
  };
}

export function receipt(kind: string, data: Record<string, unknown>) {
  const ok = typeof data.ok === "boolean"
    ? data.ok
    : typeof data.success === "boolean"
      ? data.success
      : data.status === "failed"
        ? false
        : true;
  const result = text({
    kind,
    ...data,
    ok,
  });
  return ok ? result : { ...result, isError: true };
}
