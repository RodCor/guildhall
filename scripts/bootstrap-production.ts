import { spawn } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";

type AgentKind = "scout" | "scribe" | "warden";

interface AgentMaterial {
  readonly kind: AgentKind;
  readonly agentId: string;
  readonly keyId: string;
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: JsonWebKey;
  readonly publicKeyX: string;
  readonly credential: string;
  readonly credentialHash: string;
  readonly credentialId: string;
}

const root = resolve(import.meta.dirname, "..");
const guildhallConfig = "apps/guildhall/wrangler.jsonc";
const databaseName = "guildhall";
const agentIds: Readonly<Record<AgentKind, string>> = {
  scout: "11111111-1111-4111-8111-111111111111",
  scribe: "22222222-2222-4222-8222-222222222222",
  warden: "33333333-3333-4333-8333-333333333333",
};
const agentConfigs: Readonly<Record<AgentKind, string>> = {
  scout: "apps/demo-agent/wrangler.scout.jsonc",
  scribe: "apps/demo-agent/wrangler.scribe.jsonc",
  warden: "apps/demo-agent/wrangler.warden.jsonc",
};

const cliArgs = process.argv.slice(2).filter((argument) => argument !== "--");
const phase = cliArgs[0];
if (phase !== "guildhall" && phase !== "agents") {
  throw new Error(
    "Use `pnpm bootstrap:production -- guildhall --confirm-new` first, then `pnpm bootstrap:production -- agents` after GitHub sign-in.",
  );
}
const deploymentEnv = await loadDeploymentEnv();
if (phase === "guildhall") {
  await deployGuildhall(deploymentEnv);
} else {
  await deployHostedAgents(deploymentEnv);
}

async function deployGuildhall(
  deploymentEnv: Readonly<Record<string, string>>,
): Promise<void> {
  if (!cliArgs.includes("--confirm-new")) {
    throw new Error(
      "The first phase creates a public Worker and fresh signing/session keys. Re-run with --confirm-new.",
    );
  }
  if (await workerDeploymentExists("guildhall")) {
    throw new Error(
      "Guildhall already has a deployment. Refusing to replace its issuer or session keys; use an additive rotation procedure.",
    );
  }
  const clientId = required(deploymentEnv, "GITHUB_CLIENT_ID");
  const clientSecret = required(deploymentEnv, "GITHUB_CLIENT_SECRET");
  if (deploymentEnv.GITHUB_SECRET_ROTATED !== "yes") {
    throw new Error(
      "Set GITHUB_SECRET_ROTATED=yes only after rotating the previously exposed OAuth secret.",
    );
  }
  if (!/^[A-Za-z0-9]{12,128}$/u.test(clientId) || clientSecret.length < 20) {
    throw new Error("GitHub OAuth deployment values are invalid.");
  }

  await applyMigrations();
  const issuer = await generateKeyPair();
  const issuerKeyId = randomUUID();
  await runPnpm(["--filter", "@guildhall/web", "build"]);
  const output = await withTemporaryFile(
    "guildhall-secrets.json",
    JSON.stringify({
      AUTH_COOKIE_SECRET: randomToken(),
      GITHUB_CLIENT_ID: clientId,
      GITHUB_CLIENT_SECRET: clientSecret,
      GUILD_ISSUER_KEY_ID: issuerKeyId,
      GUILD_ISSUER_PRIVATE_JWK: JSON.stringify(issuer.privateJwk),
    }),
    (secretPath) =>
      runPnpm(
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          guildhallConfig,
          "--secrets-file",
          secretPath,
          "--message",
          "Guildhall production bootstrap",
        ],
        { capture: true },
      ),
  );
  const guildhallUrl = deployedUrl(output, "guildhall");
  await bulkSecrets(guildhallConfig, {
    PUBLIC_ORIGIN: guildhallUrl,
  });

  process.stdout.write(
    [
      "Guildhall production phase deployed.",
      `Public URL: ${guildhallUrl}`,
      `Exact GitHub callback: ${new URL("/api/auth/github/callback", guildhallUrl)}`,
      "Next: set that exact callback in the GitHub OAuth app, add GUILDHALL_URL to .env.production.local, and sign in once before running the agents phase.",
      "",
    ].join("\n"),
  );
}

async function deployHostedAgents(
  deploymentEnv: Readonly<Record<string, string>>,
): Promise<void> {
  const guildhallUrl = exactHttpsOrigin(
    required(deploymentEnv, "GUILDHALL_URL"),
  );
  const health = await fetch(new URL("/api/health", guildhallUrl), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!health.ok) {
    throw new Error(`Guildhall health returned ${health.status}.`);
  }

  const ownerId = await productionOwnerId();
  await assertHostedIdentitiesAreUnused();
  const materials = await Promise.all(
    (["scout", "scribe", "warden"] as const).map(generateAgentMaterial),
  );
  const rallySecret = randomToken();
  const deployed = new Map<AgentKind, string>();
  for (const material of materials) {
    const output = await withTemporaryFile(
      `${material.kind}-secrets.json`,
      JSON.stringify({
        HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(material.privateJwk),
        HOSTED_AGENT_PUBLIC_KEY_X: material.publicKeyX,
        HOSTED_AGENT_KEY_ID: material.keyId,
        GUILD_BROKER_URL: new URL("/a2a/guild/v1", guildhallUrl).toString(),
        GUILD_AGENT_CREDENTIAL: material.credential,
        GUILD_DEMO_RALLY_SECRET: rallySecret,
      }),
      (secretPath) =>
        runPnpm(
          [
            "exec",
            "wrangler",
            "deploy",
            "--config",
            agentConfigs[material.kind],
            "--secrets-file",
            secretPath,
            "--message",
            `Guildhall ${material.kind} production bootstrap`,
          ],
          { capture: true },
        ),
    );
    const workerUrl = deployedUrl(output, `guildhall-${material.kind}`);
    await verifyAgentCard(workerUrl, material);
    deployed.set(material.kind, workerUrl);
  }

  await bulkSecrets(guildhallConfig, {
    SCOUT_A2A_URL: new URL(
      "/a2a/v1",
      requiredMap(deployed, "scout"),
    ).toString(),
    SCRIBE_A2A_URL: new URL(
      "/a2a/v1",
      requiredMap(deployed, "scribe"),
    ).toString(),
    WARDEN_A2A_URL: new URL(
      "/a2a/v1",
      requiredMap(deployed, "warden"),
    ).toString(),
    GUILD_DEMO_RALLY_SECRET: rallySecret,
  });
  await seedHostedAgentRows(ownerId, materials);
  await verifySeededRows(ownerId, materials);

  process.stdout.write(
    [
      "Hosted-agent production phase deployed and seeded.",
      ...[...deployed].map(([kind, url]) => `${kind}: ${url}`),
      "Run demo:smoke with these four public origins, then perform the browser-owned OAuth and WebMCP rehearsal.",
      "",
    ].join("\n"),
  );
}

async function verifySeededRows(
  ownerId: string,
  materials: readonly AgentMaterial[],
): Promise<void> {
  const ids = materials.map((item) => sqlString(item.agentId)).join(", ");
  const response = await queryD1(
    `SELECT agents.agent_id, agents.owner_id, agents.slug, agent_keys.key_id, agent_keys.public_jwk_json, agent_keys.status, agent_credentials.credential_hash, agent_credentials.scope_json, agent_credentials.expires_at, autonomy_policies.public_publication_enabled, autonomy_policies.policy_version, COUNT(agent_capabilities.capability) AS capability_count FROM agents INNER JOIN agent_keys ON agent_keys.agent_id = agents.agent_id INNER JOIN agent_credentials ON agent_credentials.agent_id = agents.agent_id AND agent_credentials.key_id = agent_keys.key_id INNER JOIN autonomy_policies ON autonomy_policies.agent_id = agents.agent_id LEFT JOIN agent_capabilities ON agent_capabilities.agent_id = agents.agent_id WHERE agents.agent_id IN (${ids}) GROUP BY agents.agent_id, agents.owner_id, agents.slug, agent_keys.key_id, agent_keys.public_jwk_json, agent_keys.status, agent_credentials.credential_hash, agent_credentials.scope_json, agent_credentials.expires_at, autonomy_policies.public_publication_enabled, autonomy_policies.policy_version ORDER BY agents.agent_id;`,
  );
  const rows = resultRows(response);
  if (rows.length !== materials.length) {
    throw new Error("Hosted-agent D1 postflight returned the wrong row count.");
  }
  for (const material of materials) {
    const row = rows.find(
      (candidate) => candidate.agent_id === material.agentId,
    );
    const expectedCapabilityCount = material.kind === "warden" ? 3 : 1;
    if (
      row === undefined ||
      row.owner_id !== ownerId ||
      row.key_id !== material.keyId ||
      row.public_jwk_json !== JSON.stringify(material.publicJwk) ||
      row.status !== "active" ||
      row.credential_hash !== material.credentialHash ||
      row.scope_json !== '["missions:write"]' ||
      typeof row.expires_at !== "string" ||
      Date.parse(row.expires_at) <= Date.now() ||
      row.public_publication_enabled !== 0 ||
      row.policy_version !== 1 ||
      row.capability_count !== expectedCapabilityCount
    ) {
      throw new Error(`${material.kind} D1 identity postflight failed.`);
    }
  }
}

async function applyMigrations(): Promise<void> {
  await runPnpm([
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    databaseName,
    "--remote",
    "--config",
    guildhallConfig,
  ]);
}

async function productionOwnerId(): Promise<string> {
  const explicit = option("--owner-id");
  const rows = await queryD1(
    "SELECT owner_id, github_login FROM owners ORDER BY created_at;",
  );
  const owners = resultRows(rows);
  if (explicit !== undefined) {
    if (!owners.some((row) => row.owner_id === explicit)) {
      throw new Error(
        "--owner-id is not a GitHub-authenticated production owner.",
      );
    }
    return explicit;
  }
  if (owners.length !== 1 || typeof owners[0]?.owner_id !== "string") {
    throw new Error(
      "Sign in once, or pass --owner-id when more than one real GitHub owner exists.",
    );
  }
  return owners[0].owner_id;
}

async function assertHostedIdentitiesAreUnused(): Promise<void> {
  const ids = Object.values(agentIds).map(sqlString).join(", ");
  const slugs = ["guildhall-scout", "guildhall-scribe", "guildhall-warden"]
    .map(sqlString)
    .join(", ");
  const response = await queryD1(
    `SELECT agent_id, slug FROM agents WHERE agent_id IN (${ids}) OR slug IN (${slugs});`,
  );
  if (resultRows(response).length > 0) {
    throw new Error(
      "Hosted production identities already exist. Refusing destructive key or credential rotation.",
    );
  }
}

async function seedHostedAgentRows(
  ownerId: string,
  materials: readonly AgentMaterial[],
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString();
  const materialByKind = new Map(materials.map((item) => [item.kind, item]));
  const profiles = [
    {
      kind: "scout" as const,
      slug: "guildhall-scout",
      characterName: "Scout",
      characterClass: "Ranger",
      technicalName: "Independent deterministic A2A audit Worker",
      bio: "Maps bounded public fixtures into signed accessibility findings.",
      capabilities: ["accessibility-audit"],
    },
    {
      kind: "scribe" as const,
      slug: "guildhall-scribe",
      characterName: "Scribe",
      characterClass: "Wizard",
      technicalName: "Independent deterministic A2A remediation Worker",
      bio: "Maps signed public findings into a structured remediation plan.",
      capabilities: ["remediation-planning"],
    },
    {
      kind: "warden" as const,
      slug: "guildhall-warden",
      characterName: "Warden",
      characterClass: "Paladin",
      technicalName: "Independent deterministic A2A recovery Worker",
      bio: "Recovers an exact failed role slot without changing the bound pact.",
      capabilities: [
        "accessibility-audit",
        "remediation-planning",
        "deterministic-verification",
      ],
    },
  ];
  const statements: string[] = ["PRAGMA foreign_keys = ON;"];
  for (const profile of profiles) {
    const material = requiredMap(materialByKind, profile.kind);
    statements.push(
      `INSERT INTO agents (agent_id, owner_id, slug, character_name, character_class, technical_name, guild_name, public_bio, transport_status, total_points, completed_missions, created_at, updated_at) VALUES (${sqlString(material.agentId)}, ${sqlString(ownerId)}, ${sqlString(profile.slug)}, ${sqlString(profile.characterName)}, ${sqlString(profile.characterClass)}, ${sqlString(profile.technicalName)}, 'Guildhall Reference Party', ${sqlString(profile.bio)}, 'online', 0, 0, ${sqlString(now)}, ${sqlString(now)});`,
      `INSERT INTO autonomy_policies (agent_id, public_publication_enabled, policy_version, consented_at, revoked_at, updated_at) VALUES (${sqlString(material.agentId)}, 0, 1, NULL, NULL, ${sqlString(now)});`,
      `INSERT INTO autonomy_policy_history (agent_id, policy_version, public_publication_enabled, consented_at, revoked_at, recorded_at) VALUES (${sqlString(material.agentId)}, 1, 0, NULL, NULL, ${sqlString(now)});`,
      `INSERT INTO agent_keys (key_id, agent_id, public_jwk_json, source, status, created_at, retired_at, revoked_at) VALUES (${sqlString(material.keyId)}, ${sqlString(material.agentId)}, ${sqlString(JSON.stringify(material.publicJwk))}, 'a2a', 'active', ${sqlString(now)}, NULL, NULL);`,
      `INSERT INTO agent_credentials (credential_id, agent_id, key_id, credential_hash, scope_json, expires_at, revoked_at, created_at, last_used_at) VALUES (${sqlString(material.credentialId)}, ${sqlString(material.agentId)}, ${sqlString(material.keyId)}, ${sqlString(material.credentialHash)}, '["missions:write"]', ${sqlString(expiresAt)}, NULL, ${sqlString(now)}, NULL);`,
    );
    for (const capability of profile.capabilities) {
      statements.push(
        `INSERT INTO agent_capabilities (agent_id, capability, declared_level, verified_points, verified_missions, reliability, timeliness, updated_at) VALUES (${sqlString(material.agentId)}, ${sqlString(capability)}, 90, 0, 0, 0, 0, ${sqlString(now)});`,
      );
    }
  }
  await withTemporaryFile(
    "hosted-agent-seed.sql",
    statements.join("\n"),
    (path) =>
      runPnpm([
        "exec",
        "wrangler",
        "d1",
        "execute",
        databaseName,
        "--remote",
        "--yes",
        "--config",
        guildhallConfig,
        "--file",
        path,
      ]),
  );
}

async function verifyAgentCard(
  workerUrl: string,
  material: AgentMaterial,
): Promise<void> {
  const expectedOrigin = exactHttpsOrigin(workerUrl);
  const expectedCardValues = [
    material.agentId,
    material.keyId,
    material.publicKeyX,
    new URL("/a2a/v1", expectedOrigin).toString(),
    "commitment/v1",
  ];
  let cardMatched = false;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const response = await fetchAfterPropagation(
      new URL("/.well-known/agent-card.json", expectedOrigin),
      `${material.kind} Agent Card`,
    );
    const body = await response.text();
    if (body.length > 128_000) throw new Error("Agent Card exceeded 128 KB.");
    const card = JSON.parse(body) as Record<string, unknown>;
    const serialized = JSON.stringify(card);
    if (expectedCardValues.every((expected) => serialized.includes(expected))) {
      cardMatched = true;
      break;
    }
    if (attempt < 15) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  if (!cardMatched) {
    throw new Error(
      `${material.kind} Agent Card did not reach the new deployment identity.`,
    );
  }
  const readiness = await fetchAfterPropagation(
    new URL("/ready", expectedOrigin),
    `${material.kind} readiness`,
  );
  const readinessValue: unknown = await readiness.json();
  if (
    readinessValue === null ||
    typeof readinessValue !== "object" ||
    Array.isArray(readinessValue) ||
    (readinessValue as Record<string, unknown>).status !== "ok" ||
    (readinessValue as Record<string, unknown>)
      .autonomousRecruitmentConfigured !== true
  ) {
    throw new Error(`${material.kind} readiness verification failed.`);
  }
}

async function fetchAfterPropagation(
  url: URL,
  label: string,
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return response;
    lastStatus = response.status;
    await response.body?.cancel();
    if (attempt < 10) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  throw new Error(`${label} returned ${lastStatus} after propagation retries.`);
}

async function generateAgentMaterial(kind: AgentKind): Promise<AgentMaterial> {
  const pair = await generateKeyPair();
  const publicKeyX = pair.publicJwk.x;
  if (typeof publicKeyX !== "string") {
    throw new Error("Generated Ed25519 key has no public x coordinate.");
  }
  const credential = randomToken();
  return {
    kind,
    agentId: agentIds[kind],
    keyId: randomUUID(),
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    publicKeyX,
    credential,
    credentialHash: await sha256Base64Url(credential),
    credentialId: randomUUID(),
  };
}

async function generateKeyPair(): Promise<{
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: JsonWebKey;
}> {
  const pair = (await webcrypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateExport = await webcrypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  );
  const publicExport = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  if (
    privateExport.crv !== "Ed25519" ||
    privateExport.kty !== "OKP" ||
    typeof privateExport.d !== "string" ||
    typeof privateExport.x !== "string" ||
    publicExport.x !== privateExport.x
  ) {
    throw new Error("Generated Ed25519 JWK is malformed.");
  }
  return {
    privateJwk: {
      crv: "Ed25519",
      d: privateExport.d,
      kty: "OKP",
      x: privateExport.x,
    },
    publicJwk: { crv: "Ed25519", kty: "OKP", x: privateExport.x },
  };
}

async function bulkSecrets(
  config: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  await runPnpm(["exec", "wrangler", "secret", "bulk", "--config", config], {
    input: JSON.stringify(values),
  });
}

async function queryD1(command: string): Promise<unknown> {
  const output = await runPnpm(
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--json",
      "--config",
      guildhallConfig,
      "--command",
      command,
    ],
    { capture: true, quiet: true },
  );
  return JSON.parse(stripAnsi(output));
}

function resultRows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Unexpected D1 query response.");
  }
  const first = value[0];
  if (first === null || typeof first !== "object") {
    throw new Error("Unexpected D1 query result.");
  }
  const results = (first as Record<string, unknown>).results;
  if (!Array.isArray(results)) throw new Error("D1 result rows are missing.");
  return results.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === "object" && !Array.isArray(row),
  );
}

async function loadDeploymentEnv(): Promise<Record<string, string>> {
  const path = resolve(root, ".env.production.local");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(
      "Copy .env.production.example to .env.production.local and fill the current deployment values.",
    );
  }
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Invalid production environment line.");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function withTemporaryFile<T>(
  name: string,
  content: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "guildhall-bootstrap-"));
  const resolvedTemp = resolve(tmpdir()) + sep;
  if (
    !resolve(directory).startsWith(resolvedTemp) ||
    !basename(directory).startsWith("guildhall-bootstrap-")
  ) {
    throw new Error("Refusing an unsafe temporary path.");
  }
  const path = join(directory, name);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  try {
    return await action(path);
  } finally {
    await unlink(path).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  }
}

function runPnpm(
  args: readonly string[],
  options: {
    readonly capture?: boolean;
    readonly input?: string;
    readonly quiet?: boolean;
  } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const invocation = pnpmInvocation(args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: root,
      env: process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (!options.quiet) process.stdout.write(text);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (!options.quiet) process.stderr.write(text);
    });
    if (options.input !== undefined) {
      child.stdin!.end(options.input);
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      code === 0
        ? resolvePromise(output)
        : reject(new Error(`pnpm ${args.join(" ")} exited with ${code}.`));
    });
  });
}

async function workerDeploymentExists(workerName: string): Promise<boolean> {
  const result = await runPnpmStatus([
    "exec",
    "wrangler",
    "deployments",
    "list",
    "--name",
    workerName,
    "--json",
  ]);
  if (result.code === 0) {
    const parsed: unknown = JSON.parse(stripAnsi(result.output));
    return Array.isArray(parsed) && parsed.length > 0;
  }
  if (result.output.includes("code: 10007")) return false;
  throw new Error("Could not verify whether Guildhall is already deployed.");
}

function runPnpmStatus(
  args: readonly string[],
): Promise<{ readonly code: number; readonly output: string }> {
  return new Promise((resolvePromise, reject) => {
    const invocation = pnpmInvocation(args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ code: code ?? -1, output });
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

function deployedUrl(output: string, workerName: string): string {
  const matches = stripAnsi(output).match(
    /https:\/\/[a-z0-9.-]+\.workers\.dev\/?/giu,
  );
  const url = matches?.find((candidate) =>
    new URL(candidate).hostname.startsWith(`${workerName}.`),
  );
  if (url === undefined) {
    throw new Error(
      `Wrangler did not report the ${workerName} workers.dev URL.`,
    );
  }
  return exactHttpsOrigin(url);
}

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("Production origins must use credential-free HTTPS URLs.");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Production URL must be an exact origin.");
  }
  return url.origin;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("base64url");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function required(
  values: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = values[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required in .env.production.local.`);
  }
  return value;
}

function option(name: string): string | undefined {
  const index = cliArgs.indexOf(name);
  return index < 0 ? undefined : cliArgs[index + 1];
}

function requiredMap<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined)
    throw new Error("Required deployment value is missing.");
  return value;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}
