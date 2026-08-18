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
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown tool error";
}

/** Return a machine-readable MCP failure while preserving the legacy error string. */
export function toolError(error: unknown, options: ToolErrorOptions = {}) {
  const result = text({
    ...(options.data || {}),
    ok: false,
    error: errorMessage(error),
    code: options.code || "tool_error",
    retryable: options.retryable ?? false,
    ...(options.details ? { details: cloneJsonValue(options.details) } : {}),
  });
  return {
    ...result,
    isError: true,
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
