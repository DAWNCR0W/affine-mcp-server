import { fetch } from "undici";

function extractCookiePairs(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const sc of setCookies) {
    const first = sc.split(";")[0];
    if (first) pairs.push(first.trim());
  }
  return pairs.join("; ");
}

export async function loginWithPassword(baseUrl: string, email: string, password: string): Promise<{ cookieHeader: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/auth/sign-in`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sign-in failed: ${res.status} ${text}`);
  }
  const anyHeaders = res.headers as any;
  let setCookies: string[] = [];
  if (typeof anyHeaders.getSetCookie === "function") {
    setCookies = anyHeaders.getSetCookie();
  } else {
    const sc = res.headers.get("set-cookie");
    if (sc) setCookies = [sc];
  }
  if (!setCookies.length) {
    throw new Error("Sign-in succeeded but no Set-Cookie received");
  }
  const cookieHeader = extractCookiePairs(setCookies);
  return { cookieHeader };
}

