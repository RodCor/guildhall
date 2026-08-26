import {
  authenticateSession,
  authorizeSessionMutation,
  revokeSession,
  type SessionPrincipal,
} from "../repositories/authRepository.js";
import type { GuildhallEnv } from "../types.js";
import { hashOpaqueCredential, timingResistantEqual } from "./crypto.js";
import {
  clearHostCookie,
  CSRF_COOKIE,
  CSRF_HEADER,
  hasExactOrigin,
  noStoreJson,
  readCookie,
  SESSION_COOKIE,
} from "./httpSecurity.js";

export type OwnerAuthorization =
  | {
      readonly ok: true;
      readonly principal: SessionPrincipal;
      readonly sessionHash: string;
    }
  | { readonly ok: false; readonly response: Response };

export async function authenticateOwner(
  request: Request,
  env: GuildhallEnv,
): Promise<OwnerAuthorization> {
  const sessionToken = readCookie(request, SESSION_COOKIE);
  if (sessionToken === null) return unauthorized();
  const sessionHash = await hashOpaqueCredential(sessionToken);
  const principal = await authenticateSession(
    env.GUILD_DB,
    sessionHash,
    new Date().toISOString(),
  );
  return principal === null
    ? unauthorized()
    : { ok: true, principal, sessionHash };
}

export async function authorizeOwnerMutation(
  request: Request,
  env: GuildhallEnv,
): Promise<OwnerAuthorization> {
  if (!hasExactOrigin(request, env.PUBLIC_ORIGIN)) return forbidden();
  const sessionToken = readCookie(request, SESSION_COOKIE);
  const csrfCookie = readCookie(request, CSRF_COOKIE);
  const csrfHeader = request.headers.get(CSRF_HEADER);
  if (
    sessionToken === null ||
    csrfCookie === null ||
    csrfHeader === null ||
    !timingResistantEqual(csrfCookie, csrfHeader)
  ) {
    return forbidden();
  }

  const [sessionHash, csrfHash] = await Promise.all([
    hashOpaqueCredential(sessionToken),
    hashOpaqueCredential(csrfHeader),
  ]);
  const principal = await authorizeSessionMutation(
    env.GUILD_DB,
    sessionHash,
    csrfHash,
    new Date().toISOString(),
  );
  return principal === null
    ? unauthorized()
    : { ok: true, principal, sessionHash };
}

export async function handleSessionRoute(
  request: Request,
  env: GuildhallEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/session" && request.method === "GET") {
    const authorization = await authenticateOwner(request, env);
    if (!authorization.ok) return authorization.response;
    return noStoreJson({
      authenticated: true,
      owner: {
        ownerId: authorization.principal.ownerId,
        githubUserId: authorization.principal.githubUserId,
        login: authorization.principal.githubLogin,
        avatarUrl: authorization.principal.githubAvatarUrl,
      },
      expiresAt: authorization.principal.sessionExpiresAt,
    });
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const authorization = await authorizeOwnerMutation(request, env);
    if (!authorization.ok) return authorization.response;
    await revokeSession(
      env.GUILD_DB,
      authorization.sessionHash,
      new Date().toISOString(),
    );
    const headers = new Headers();
    headers.append("Set-Cookie", clearHostCookie(SESSION_COOKIE, true));
    headers.append("Set-Cookie", clearHostCookie(CSRF_COOKIE, false));
    return noStoreJson({ authenticated: false }, { headers });
  }

  return null;
}

function unauthorized(): OwnerAuthorization {
  return {
    ok: false,
    response: noStoreJson(
      { error: "UNAUTHENTICATED", message: "Owner authentication is required" },
      { status: 401 },
    ),
  };
}

function forbidden(): OwnerAuthorization {
  return {
    ok: false,
    response: noStoreJson(
      {
        error: "REQUEST_NOT_AUTHORIZED",
        message: "Request authorization failed",
      },
      { status: 403 },
    ),
  };
}
