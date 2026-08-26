export const FLOW_COOKIE = "__Host-guild_flow";
export const SESSION_COOKIE = "__Host-guild_session";
export const CSRF_COOKIE = "__Host-guild_csrf";
export const CSRF_HEADER = "X-Guild-CSRF";

interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly httpOnly: boolean;
}

export function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader === null) return null;

  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const candidateName = segment.slice(0, separator).trim();
    if (candidateName !== name) continue;
    const candidateValue = segment.slice(separator + 1).trim();
    return /^[A-Za-z0-9._~-]+$/u.test(candidateValue) ? candidateValue : null;
  }
  return null;
}

export function setHostCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  if (!name.startsWith("__Host-") || !/^[A-Za-z0-9._~-]+$/u.test(value)) {
    throw new TypeError("Invalid host cookie");
  }
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`,
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

export function clearHostCookie(name: string, httpOnly: boolean): string {
  return setHostCookie(name, "cleared", { maxAgeSeconds: 0, httpOnly });
}

export function hasExactOrigin(
  request: Request,
  publicOrigin: string,
): boolean {
  const expected = normalizeOrigin(publicOrigin);
  const actual = request.headers.get("Origin");
  if (expected === null || actual === null) return false;
  return normalizeOrigin(actual) === expected;
}

export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
