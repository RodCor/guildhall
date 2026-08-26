import {
  consumeOAuthFlow,
  createOAuthFlow,
  getPendingOAuthFlow,
  upsertGithubOwnerAndSession,
} from "../repositories/authRepository.js";
import type { GuildhallEnv } from "../types.js";
import {
  generatePkcePair,
  hashOpaqueCredential,
  randomBase64UrlToken,
  sealPkceVerifier,
  sha256Base64Url,
  signCompactValue,
  timingResistantEqual,
  unsealPkceVerifier,
  verifyCompactValue,
} from "./crypto.js";
import {
  createGitHubAuthorizationUrl,
  exchangeGitHubCode,
} from "./githubProvider.js";
import type { GitHubProfile } from "./githubProvider.js";
import {
  clearHostCookie,
  CSRF_COOKIE,
  FLOW_COOKIE,
  noStoreJson,
  readCookie,
  SESSION_COOKIE,
  setHostCookie,
} from "./httpSecurity.js";

const FLOW_LIFETIME_MS = 10 * 60 * 1_000;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export async function handleOAuthRoute(
  request: Request,
  env: GuildhallEnv,
  dependencies: {
    readonly exchangeCode?: (
      env: GuildhallEnv,
      input: {
        readonly code: string;
        readonly codeVerifier: string;
        readonly redirectUri: string;
      },
    ) => Promise<GitHubProfile>;
  } = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/github/start" && request.method === "GET") {
    return beginGitHubAuthorization(env);
  }
  if (
    url.pathname === "/api/auth/github/callback" &&
    request.method === "GET"
  ) {
    return completeGitHubAuthorization(
      request,
      env,
      dependencies.exchangeCode ?? exchangeGitHubCode,
    );
  }
  return null;
}

async function beginGitHubAuthorization(env: GuildhallEnv): Promise<Response> {
  const now = Date.now();
  const expiresAt = now + FLOW_LIFETIME_MS;
  const redirectUri = exactCallbackUri(env.PUBLIC_ORIGIN);
  const flowId = randomBase64UrlToken(24);
  const state = randomBase64UrlToken();
  const pkce = await generatePkcePair();
  const aad = flowAdditionalData(flowId, redirectUri);
  const [stateHash, verifierHash, verifierCiphertext, flowCookie] =
    await Promise.all([
      sha256Base64Url(state),
      sha256Base64Url(pkce.verifier),
      sealPkceVerifier(pkce.verifier, env.AUTH_COOKIE_SECRET, aad),
      signCompactValue(flowId, expiresAt, env.AUTH_COOKIE_SECRET),
    ]);

  const nowIso = new Date(now).toISOString();
  await createOAuthFlow(env.GUILD_DB, {
    flowId,
    stateHash,
    pkceVerifierHash: verifierHash,
    pkceVerifierCiphertext: verifierCiphertext,
    exactRedirectUri: redirectUri,
    expiresAt: new Date(expiresAt).toISOString(),
    createdAt: nowIso,
  });

  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: createGitHubAuthorizationUrl(env, {
      state,
      codeChallenge: pkce.challenge,
      redirectUri,
    }),
  });
  headers.append(
    "Set-Cookie",
    setHostCookie(FLOW_COOKIE, flowCookie, {
      maxAgeSeconds: FLOW_LIFETIME_MS / 1_000,
      httpOnly: true,
    }),
  );
  return new Response(null, { status: 302, headers });
}

async function completeGitHubAuthorization(
  request: Request,
  env: GuildhallEnv,
  exchangeCode: (
    env: GuildhallEnv,
    input: {
      readonly code: string;
      readonly codeVerifier: string;
      readonly redirectUri: string;
    },
  ) => Promise<GitHubProfile>,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const compactFlow = readCookie(request, FLOW_COOKIE);
    if (code === null || state === null || compactFlow === null)
      return oauthFailure();

    const verifiedFlow = await verifyCompactValue(
      compactFlow,
      env.AUTH_COOKIE_SECRET,
    );
    if (!verifiedFlow.valid) return oauthFailure();

    const pending = await getPendingOAuthFlow(
      env.GUILD_DB,
      verifiedFlow.payload,
      new Date().toISOString(),
    );
    if (pending === null) return oauthFailure();

    const redirectUri = exactCallbackUri(env.PUBLIC_ORIGIN);
    if (pending.exactRedirectUri !== redirectUri) return oauthFailure();
    const stateHash = await sha256Base64Url(state);
    if (!timingResistantEqual(stateHash, pending.stateHash))
      return oauthFailure();

    const verifier = await unsealPkceVerifier(
      pending.pkceVerifierCiphertext,
      env.AUTH_COOKIE_SECRET,
      flowAdditionalData(pending.flowId, pending.exactRedirectUri),
    );
    if (verifier === null) return oauthFailure();
    const verifierHash = await sha256Base64Url(verifier);
    if (!timingResistantEqual(verifierHash, pending.pkceVerifierHash)) {
      return oauthFailure();
    }

    const consumedAt = new Date().toISOString();
    const consumed = await consumeOAuthFlow(env.GUILD_DB, {
      flowId: pending.flowId,
      stateHash,
      pkceVerifierHash: verifierHash,
      exactRedirectUri: redirectUri,
      now: consumedAt,
      consumedAt,
    });
    if (consumed.status !== "applied") return oauthFailure();

    const profile = await exchangeCode(env, {
      code,
      codeVerifier: verifier,
      redirectUri,
    });
    const sessionToken = randomBase64UrlToken();
    const csrfToken = randomBase64UrlToken();
    const sessionExpiresAt = Date.now() + SESSION_LIFETIME_MS;
    const [sessionHash, csrfHash] = await Promise.all([
      hashOpaqueCredential(sessionToken),
      hashOpaqueCredential(csrfToken),
    ]);
    await upsertGithubOwnerAndSession(env.GUILD_DB, {
      proposedOwnerId: crypto.randomUUID(),
      githubUserId: profile.githubUserId,
      githubLogin: profile.login,
      githubAvatarUrl: profile.avatarUrl,
      sessionHash,
      csrfHash,
      expiresAt: new Date(sessionExpiresAt).toISOString(),
      createdAt: consumedAt,
    });

    const headers = new Headers({
      "Cache-Control": "no-store",
      Location: new URL("/?login=success", env.PUBLIC_ORIGIN).toString(),
    });
    headers.append("Set-Cookie", clearHostCookie(FLOW_COOKIE, true));
    headers.append(
      "Set-Cookie",
      setHostCookie(SESSION_COOKIE, sessionToken, {
        maxAgeSeconds: SESSION_LIFETIME_MS / 1_000,
        httpOnly: true,
      }),
    );
    headers.append(
      "Set-Cookie",
      setHostCookie(CSRF_COOKIE, csrfToken, {
        maxAgeSeconds: SESSION_LIFETIME_MS / 1_000,
        httpOnly: false,
      }),
    );
    return new Response(null, { status: 302, headers });
  } catch {
    return oauthFailure();
  }
}

function exactCallbackUri(publicOrigin: string): string {
  return new URL(
    "/api/auth/github/callback",
    new URL(publicOrigin).origin,
  ).toString();
}

function flowAdditionalData(flowId: string, redirectUri: string): string {
  return `guildhall/oauth-flow/v1\n${flowId}\n${redirectUri}`;
}

function oauthFailure(): Response {
  const response = noStoreJson(
    {
      error: "OAUTH_FLOW_FAILED",
      message: "GitHub authorization could not be completed",
    },
    { status: 400 },
  );
  response.headers.append("Set-Cookie", clearHostCookie(FLOW_COOKIE, true));
  return response;
}
