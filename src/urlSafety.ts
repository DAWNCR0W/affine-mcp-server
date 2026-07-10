const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_OPAQUE_ID_LENGTH = 2_048;

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

function assertNoEncodedControlCharacters(value: string, field: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${field} must use valid percent encoding.`);
  }
  assertNoControlCharacters(decoded, field);
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

function canonicalWebUrl(value: string, parsed: URL, field: string): string {
  if (value.includes("\\")) {
    throw new Error(`${field} must not contain backslashes.`);
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${field} must use canonical http:// or https:// syntax.`);
  }
  if (!parsed.hostname) {
    throw new Error(`${field} must include a hostname.`);
  }
  parsed.hostname = normalizedHostname(parsed);
  return parsed.href;
}

export function normalizeBlobSourceId(
  value: string | undefined,
  blockType: BlobBackedBlockType = "image",
): string {
  const raw = value ?? "";
  assertNoControlCharacters(raw, `${blockType} sourceId`);
  if (!raw.trim()) {
    return "";
  }
  if (raw.length > MAX_OPAQUE_ID_LENGTH) {
    throw new Error(`${blockType} sourceId must not exceed ${MAX_OPAQUE_ID_LENGTH} characters.`);
  }
  return raw;
}

function canonicalAffineInternalUrl(parsed: URL, field: string): string {
  const kind = normalizedHostname(parsed);
  if (
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (kind !== "blob" && kind !== "doc") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${field} only supports AFFiNE internal URLs in the form affine://blob/<key> or affine://doc/<id>.`);
  }

  let identifier: string;
  try {
    identifier = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error(`${field} contains invalid AFFiNE identifier encoding.`);
  }
  const normalizedIdentifier = normalizeBlobSourceId(identifier, "image");
  if (!normalizedIdentifier) {
    throw new Error(`${field} must include an AFFiNE identifier.`);
  }
  return `affine://${kind}/${encodeURIComponent(normalizedIdentifier)}`;
}

export function blobSourceIdToUrl(value: string): string {
  const key = normalizeBlobSourceId(value, "image");
  if (!key) {
    throw new Error("image sourceId must include an AFFiNE blob key.");
  }
  return `affine://blob/${encodeURIComponent(key)}`;
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
  assertNoEncodedControlCharacters(normalized, fieldLabel);

  const policy = field === "iframeUrl" ? "iframe" : POLICY_BY_BLOCK_TYPE[blockType];
  const parsed = parseAbsoluteUrl(normalized, fieldLabel);
  const protocol = parsed.protocol.toLowerCase();

  if (policy === "bookmark") {
    if (protocol === "affine:") {
      return canonicalAffineInternalUrl(parsed, fieldLabel);
    }
    if (protocol === "http:" || protocol === "https:") {
      return canonicalWebUrl(normalized, parsed, fieldLabel);
    }
    if (protocol === "mailto:" || protocol === "tel:") {
      return parsed.href;
    }
    throw new Error(`${fieldLabel} must use http, https, mailto, tel, affine://blob, or affine://doc.`);
  }

  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`${fieldLabel} must use http or https.`);
  }
  const canonical = canonicalWebUrl(normalized, parsed, fieldLabel);

  if (policy === "iframe") {
    return canonical;
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
  return canonical;
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
  return accepts(() => {
    if (!normalizeBlockUrl(value, "bookmark")) throw new Error("url is empty");
  });
}

export function isSafeIframeUrlInput(value: string): boolean {
  return accepts(() => {
    if (!normalizeBlockUrl(value, "embed_iframe", "iframeUrl")) throw new Error("iframeUrl is empty");
  });
}

export function isSafeBlobSourceIdInput(value: string): boolean {
  return accepts(() => {
    if (!normalizeBlobSourceId(value)) throw new Error("sourceId is empty");
  });
}
