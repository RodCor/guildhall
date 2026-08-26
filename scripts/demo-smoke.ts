import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixtureDigest = "geKBB1Pr83xZU8RzZaoC-YcNy6MO2jw3lB_lupUQQ58";
const guildhall = requiredUrl("--guildhall", "GUILDHALL_URL");
const agents = {
  scout: requiredUrl("--scout", "SCOUT_URL"),
  scribe: requiredUrl("--scribe", "SCRIBE_URL"),
  warden: requiredUrl("--warden", "WARDEN_URL"),
} as const;

await checkGuildhall();
for (const [kind, baseUrl] of Object.entries(agents)) {
  await checkAgent(kind, baseUrl);
}
await runGuildNodeSmoke();
process.stdout.write("Deployed Guildhall demo smoke passed.\n");

async function checkGuildhall(): Promise<void> {
  const page = await checkedFetch(guildhall);
  const html = await page.text();
  assert(html.includes("Guildhall"), "Guildhall SPA shell is missing.");

  const health = await jsonRecord(new URL("/api/ready", guildhall));
  assert(health.status === "ok", "Guildhall readiness is not ok.");
  assert(
    health.protocolCore === "commitment/v1",
    "Guildhall protocol core is not commitment/v1.",
  );
  assert(
    health.phase === "complete" && health.database === "reachable",
    "Guildhall production topology is incomplete.",
  );

  const fixture = await checkedFetch(
    new URL("/fixtures/accessibility-dungeon-v1", guildhall),
  );
  const fixtureBody = await fixture.text();
  assert(
    fixture.headers.get("X-Guildhall-Content-Digest") === fixtureDigest,
    "Fixture response digest header changed.",
  );
  assert(
    (await sha256Base64Url(fixtureBody)) === fixtureDigest,
    "Fixture bytes do not match the committed digest.",
  );

  const issuer = await jsonRecord(
    new URL("/.well-known/guildhall-issuer-key.json", guildhall),
  );
  assert(typeof issuer.keyId === "string", "Issuer key ID is unavailable.");
  assert(isPublicEd25519Jwk(issuer.publicJwk), "Issuer public key is invalid.");

  const broker = await jsonRecord(
    new URL("/.well-known/agent-card.json", guildhall),
  );
  assert(
    broker.name === "Guildhall Guild Broker",
    "Guild Broker Agent Card is unavailable.",
  );
  assert(
    JSON.stringify(broker).includes("commitment/v1"),
    "Guild Broker card omits commitment/v1.",
  );

  const catalog = await jsonRecord(new URL("/api/missions?limit=3", guildhall));
  assert(Array.isArray(catalog.missions), "Public mission catalog is invalid.");

  const oauth = await fetch(new URL("/api/auth/github/start", guildhall), {
    redirect: "manual",
  });
  assert(oauth.status === 302, "GitHub OAuth start did not redirect.");
  const location = oauth.headers.get("Location");
  assert(location !== null, "GitHub OAuth redirect location is missing.");
  const authorization = new URL(location);
  assert(
    authorization.origin === "https://github.com",
    "GitHub OAuth redirect has the wrong provider origin.",
  );
  assert(
    authorization.searchParams.get("redirect_uri") ===
      new URL("/api/auth/github/callback", guildhall).toString(),
    "GitHub OAuth redirect URI is not the exact production callback.",
  );
  const flowCookie = oauth.headers.get("Set-Cookie") ?? "";
  assert(
    flowCookie.includes("Secure") && flowCookie.includes("HttpOnly"),
    "OAuth flow cookie is missing Secure or HttpOnly.",
  );
}

async function checkAgent(kind: string, baseUrl: URL): Promise<void> {
  const readiness = await jsonRecord(new URL("/ready", baseUrl));
  assert(readiness.status === "ok", `${kind} readiness is not ok.`);
  assert(
    readiness.autonomousRecruitmentConfigured === true,
    `${kind} autonomous recruitment is not configured.`,
  );
  const card = await jsonRecord(
    new URL("/.well-known/agent-card.json", baseUrl),
  );
  assert(
    typeof card.name === "string" && card.name.toLowerCase().includes(kind),
    `${kind} Agent Card has the wrong identity.`,
  );
  const serialized = JSON.stringify(card);
  assert(
    serialized.includes("commitment/v1"),
    `${kind} Agent Card omits commitment/v1.`,
  );
  assert(
    serialized.includes(new URL("/a2a/v1", baseUrl).toString()),
    `${kind} Agent Card has the wrong endpoint.`,
  );
  assert(
    serialized.includes('"crv":"Ed25519"'),
    `${kind} Agent Card has no Ed25519 public key.`,
  );
}

async function runGuildNodeSmoke(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const invocation = pnpmInvocation([
      "--filter",
      "@guildhall/node",
      "smoke:live",
      "--",
      "--base-url",
      guildhall.toString().replace(/\/$/u, ""),
    ]);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      code === 0
        ? resolvePromise()
        : reject(new Error(`Guild Node smoke exited with ${code}.`));
    });
  });
}

function pnpmInvocation(args: readonly string[]): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  const cli = process.env.npm_execpath;
  return cli === undefined
    ? { executable: "pnpm", args }
    : { executable: process.execPath, args: [cli, ...args] };
}

async function checkedFetch(input: URL): Promise<Response> {
  const response = await fetch(input, {
    headers: { Accept: "application/json, text/html" },
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${input} returned ${response.status}.`);
  return response;
}

async function jsonRecord(input: URL): Promise<Record<string, unknown>> {
  const response = await checkedFetch(input);
  const value: unknown = await response.json();
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${input} did not return a JSON object.`,
  );
  return value as Record<string, unknown>;
}

function requiredUrl(optionName: string, envName: string): URL {
  const optionIndex = process.argv.indexOf(optionName);
  const value =
    optionIndex >= 0 ? process.argv[optionIndex + 1] : process.env[envName];
  if (value === undefined || value === "") {
    throw new Error(`Provide ${optionName} or ${envName}.`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${envName} must use HTTPS.`);
  }
  return url;
}

function isPublicEd25519Jwk(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kty === "OKP" &&
    (value as Record<string, unknown>).crv === "Ed25519" &&
    typeof (value as Record<string, unknown>).x === "string" &&
    !("d" in value)
  );
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("base64url");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
