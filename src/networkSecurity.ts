/** Parse an explicit boolean environment flag and reject ambiguous values. */
export function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  throw new Error(`${name} must be either "true" or "false". Received: ${raw}`);
}

/** Return true only for hostnames that are unambiguously loopback addresses. */
export function isLoopbackHostname(input: string): boolean {
  const hostname = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") return true;

  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

/** Return true when a URL uses plain HTTP for a non-loopback destination. */
export function isRemotePlainHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
}
