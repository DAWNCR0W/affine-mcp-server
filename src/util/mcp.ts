export function text(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text' as const, text }] };
}

