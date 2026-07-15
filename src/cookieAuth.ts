export const AFFINE_SESSION_COOKIE = "affine_session";
export const AFFINE_USER_COOKIE = "affine_user_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{1,128})$/i;

/**
 * Accept an affine_session value, an `affine_session=...` pair, or a complete
 * browser Cookie header. Return only the AFFiNE authentication cookies so
 * unrelated browser and Cloudflare cookies are never persisted.
 */
export function normalizeAffineCookieInput(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error("No session cookie provided.");
  if (raw.length > 16_384) throw new Error("Cookie input is unexpectedly large.");
  if (/[\r\n]/.test(raw)) {
    throw new Error("Cookie input must be a single line.");
  }

  raw = raw.replace(/^cookie\s*:\s*/i, "").trim();
  if (!raw.includes("=")) {
    raw = `${AFFINE_SESSION_COOKIE}=${raw}`;
  }

  const cookies = new Map<string, string>();
  for (const part of raw.split(";")) {
    const pair = part.trim();
    if (!pair) continue;
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    const name = pair.slice(0, equals).trim().toLowerCase();
    const value = pair.slice(equals + 1).trim();
    if (name === AFFINE_SESSION_COOKIE || name === AFFINE_USER_COOKIE) {
      cookies.set(name, value);
    }
  }

  const session = cookies.get(AFFINE_SESSION_COOKIE);
  if (!session) {
    throw new Error(
      `Cookie input does not contain ${AFFINE_SESSION_COOKIE}. Copy its value from the browser's cookie storage.`,
    );
  }
  if (!UUID.test(session)) {
    throw new Error(
      `${AFFINE_SESSION_COOKIE} is not a valid AFFiNE session ID. Copy the cookie value again without quotes.`,
    );
  }

  const userId = cookies.get(AFFINE_USER_COOKIE);
  if (userId && !USER_ID.test(userId)) {
    throw new Error(`${AFFINE_USER_COOKIE} has an invalid value.`);
  }

  return [
    `${AFFINE_SESSION_COOKIE}=${session}`,
    ...(userId ? [`${AFFINE_USER_COOKIE}=${userId}`] : []),
  ].join("; ");
}
