import type { GuildhallEnv } from "../types.js";

const DEFAULT_OAUTH_ORIGIN = "https://github.com";
const DEFAULT_API_ORIGIN = "https://api.github.com";

export interface GitHubProfile {
  readonly githubUserId: number;
  readonly login: string;
  readonly avatarUrl: string | null;
}

export interface GitHubAuthorizationRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export class GitHubProviderError extends Error {
  readonly code: "TOKEN_EXCHANGE_FAILED" | "PROFILE_FETCH_FAILED";

  constructor(code: GitHubProviderError["code"]) {
    super("GitHub authorization could not be completed");
    this.name = "GitHubProviderError";
    this.code = code;
  }
}

export function createGitHubAuthorizationUrl(
  env: GuildhallEnv,
  input: GitHubAuthorizationRequest,
): string {
  const authorizationUrl = new URL(
    "/login/oauth/authorize",
    env.GITHUB_OAUTH_BASE_URL ?? DEFAULT_OAUTH_ORIGIN,
  );
  authorizationUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
  authorizationUrl.searchParams.set("state", input.state);
  authorizationUrl.searchParams.set("code_challenge", input.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return authorizationUrl.toString();
}

export async function exchangeGitHubCode(
  env: GuildhallEnv,
  input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  },
): Promise<GitHubProfile> {
  const tokenUrl = new URL(
    "/login/oauth/access_token",
    env.GITHUB_OAUTH_BASE_URL ?? DEFAULT_OAUTH_ORIGIN,
  );
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });

  const tokenBody = await readJsonRecord(tokenResponse);
  const accessToken = tokenBody?.access_token;
  if (
    !tokenResponse.ok ||
    typeof accessToken !== "string" ||
    accessToken.length === 0
  ) {
    throw new GitHubProviderError("TOKEN_EXCHANGE_FAILED");
  }

  const profileUrl = new URL(
    "/user",
    env.GITHUB_API_BASE_URL ?? DEFAULT_API_ORIGIN,
  );
  const profileResponse = await fetch(profileUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Guildhall-WebMCP-Challenge",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const profileBody = await readJsonRecord(profileResponse);
  const githubUserId = profileBody?.id;
  const login = profileBody?.login;
  const avatarUrl = profileBody?.avatar_url;

  if (
    !profileResponse.ok ||
    typeof githubUserId !== "number" ||
    !Number.isSafeInteger(githubUserId) ||
    githubUserId <= 0 ||
    typeof login !== "string" ||
    login.length === 0 ||
    (avatarUrl !== null &&
      avatarUrl !== undefined &&
      typeof avatarUrl !== "string")
  ) {
    throw new GitHubProviderError("PROFILE_FETCH_FAILED");
  }

  return {
    githubUserId,
    login,
    avatarUrl: typeof avatarUrl === "string" ? avatarUrl : null,
  };
}

async function readJsonRecord(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
