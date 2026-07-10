const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// upload_blob returns an opaque id/key, and Markdown export represents that
// exact key as affine://blob/<key>. It is not an arbitrary external URL.
const BLOB_SOURCE_ID = /^[A-Za-z0-9._~-]+$/;

export const URL_BEARING_BLOCK_TYPES = [
  "bookmark",
  "embed_youtube",
  "embed_github",
  "embed_figma",
  "embed_loom",
  "embed_iframe",
] as const;

export type UrlBearingBlockType = typeof URL_BEARING_BLOCK_TYPES[number];
export type BlobBackedBlockType = "image" | "attachment";

type UrlPolicy = "bookmark" | "iframe" | "youtube" | "github" | "figma" | "loom";

// Keep provider hosts exact so suffix lookalikes and unrecognized subdomains
// cannot reach provider-specific embed renderers.
const PROVIDER_HOSTS: Record<Exclude<UrlPolicy, "bookmark" | "iframe">, ReadonlySet<string>> = {
  youtube: new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
  ]),
  github: new Set(["github.com", "www.github.com"]),
  figma: new Set(["figma.com", "www.figma.com"]),
  loom: new Set(["loom.com", "www.loom.com"]),
};

const POLICY_BY_BLOCK_TYPE: Record<UrlBearingBlockType, UrlPolicy> = {
  bookmark: "bookmark",
  embed_youtube: "youtube",
  embed_github: "github",
  embed_figma: "figma",
  embed_loom: "loom",
  embed_iframe: "iframe",
};

function assertNoControlCharacters(value: string, field: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${field} must not contain control or line-separator characters.`);
  }
}

function parseAbsoluteUrl(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid absolute URL.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not contain embedded credentials.`);
  }
  return parsed;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function assertCanonicalWebUrl(value: string, parsed: URL, field: string): void {
  if (value.includes("\\")) {
    throw new Error(`${field} must not contain backslashes.`);
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${field} must use canonical http:// or https:// syntax.`);
  }
  if (!parsed.hostname) {
    throw new Error(`${field} must include a hostname.`);
  }
}

export function normalizeBlobSourceId(
  value: string | undefined,
  blockType: BlobBackedBlockType = "image",
): string {
  const raw = value ?? "";
  assertNoControlCharacters(raw, `${blockType} sourceId`);
  const normalized = raw.trim();
  if (!normalized) {
    return "";
  }
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.length > 2048 ||
    !BLOB_SOURCE_ID.test(normalized)
  ) {
    throw new Error(`${blockType} sourceId must be an opaque AFFiNE blob key, not a URL or path.`);
  }
  return normalized;
}

function assertAffineBlobUrl(parsed: URL, field: string): void {
  if (
    parsed.username ||
    parsed.password ||
    parsed.port ||
    normalizedHostname(parsed) !== "blob" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${field} only supports AFFiNE internal URLs in the form affine://blob/<key>.`);
  }

  let blobKey: string;
  try {
    blobKey = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error(`${field} contains an invalid AFFiNE blob key encoding.`);
  }
  if (!normalizeBlobSourceId(blobKey, "image")) {
    throw new Error(`${field} must include an AFFiNE blob key.`);
  }
}

export function normalizeBlockUrl(
  value: string | undefined,
  blockType: UrlBearingBlockType,
  field: "url" | "iframeUrl" = "url",
): string {
  const raw = value ?? "";
  const fieldLabel = `${blockType} ${field}`;
  assertNoControlCharacters(raw, fieldLabel);
  const normalized = raw.trim();
  if (!normalized) {
    return "";
  }

  const policy = field === "iframeUrl" ? "iframe" : POLICY_BY_BLOCK_TYPE[blockType];
  const parsed = parseAbsoluteUrl(normalized, fieldLabel);
  const protocol = parsed.protocol.toLowerCase();

  if (policy === "bookmark") {
    if (protocol === "affine:") {
      assertAffineBlobUrl(parsed, fieldLabel);
      return normalized;
    }
    if (protocol === "http:" || protocol === "https:") {
      assertCanonicalWebUrl(normalized, parsed, fieldLabel);
      return normalized;
    }
    if (protocol === "mailto:" || protocol === "tel:") {
      return normalized;
    }
    throw new Error(`${fieldLabel} must use http, https, mailto, tel, or affine://blob.`);
  }

  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`${fieldLabel} must use http or https.`);
  }
  assertCanonicalWebUrl(normalized, parsed, fieldLabel);

  if (policy === "iframe") {
    return normalized;
  }

  if (protocol !== "https:") {
    throw new Error(`${fieldLabel} must use https for provider embeds.`);
  }
  if (parsed.port) {
    throw new Error(`${fieldLabel} must not use a non-default port.`);
  }
  const allowedHosts = PROVIDER_HOSTS[policy];
  if (!allowedHosts.has(normalizedHostname(parsed))) {
    throw new Error(`${fieldLabel} must use an official ${policy} host.`);
  }
  return normalized;
}

export function normalizeUrlBearingBlockFields(input: {
  type: string;
  url?: string;
  iframeUrl?: string;
  sourceId?: string;
}): { url: string; iframeUrl: string; sourceId: string } {
  const type = input.type;
  const isUrlBearing = (URL_BEARING_BLOCK_TYPES as readonly string[]).includes(type);
  const url = isUrlBearing
    ? normalizeBlockUrl(input.url, type as UrlBearingBlockType)
    : (input.url ?? "").trim();
  const iframeUrl = type === "embed_iframe"
    ? normalizeBlockUrl(input.iframeUrl, "embed_iframe", "iframeUrl")
    : (input.iframeUrl ?? "").trim();
  const sourceId = type === "image" || type === "attachment"
    ? normalizeBlobSourceId(input.sourceId, type)
    : (input.sourceId ?? "").trim();
  return { url, iframeUrl, sourceId };
}

function accepts(value: () => unknown): boolean {
  try {
    value();
    return true;
  } catch {
    return false;
  }
}

export function isSafeUrlInput(value: string): boolean {
  return accepts(() => normalizeBlockUrl(value, "bookmark"));
}

export function isSafeIframeUrlInput(value: string): boolean {
  return accepts(() => normalizeBlockUrl(value, "embed_iframe", "iframeUrl"));
}

export function isSafeBlobSourceIdInput(value: string): boolean {
  return accepts(() => normalizeBlobSourceId(value));
}
