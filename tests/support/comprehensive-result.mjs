const NON_SUCCESS_STATUSES = new Set(["failed", "partial", "not_applied"]);

export function getToolResultError(result, parsed) {
  if (result?.isError) {
    if (typeof parsed === "string" && parsed.length > 0) {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      if (parsed.error) return String(parsed.error);
      return JSON.stringify(parsed);
    }
    return "MCP tool returned isError=true";
  }

  if (typeof parsed === "string") {
    if (/^GraphQL error:/i.test(parsed) || /^Error:/i.test(parsed)) return parsed;
    return null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.error) {
      return String(parsed.error);
    }
    const status = typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : null;
    if (
      parsed.ok === false ||
      parsed.success === false ||
      (status !== null && NON_SUCCESS_STATUSES.has(status))
    ) {
      return JSON.stringify(parsed);
    }
  }
  return null;
}
