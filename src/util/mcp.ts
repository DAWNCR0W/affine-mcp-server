function cloneJsonValue<T>(data: T): T {
  if (data === undefined) {
    return data;
  }
  return JSON.parse(JSON.stringify(data)) as T;
}

export function text(data: unknown) {
  if (typeof data === "string") {
    return { content: [{ type: "text" as const, text: data }] };
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const structuredContent = cloneJsonValue(data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function receipt(kind: string, data: Record<string, unknown>) {
  return text({
    kind,
    ok: true,
    ...data,
  });
}
