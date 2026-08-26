import { spawn } from "node:child_process";
import { resolve } from "node:path";

type AgentKind = "scout" | "scribe" | "warden";

const root = resolve(import.meta.dirname, "..");
const guildhallConfig = "apps/guildhall/wrangler.jsonc";
const databaseName = "guildhall";
const guildhall = requiredUrl("--guildhall", "GUILDHALL_URL");
const agents: Readonly<Record<AgentKind, URL>> = {
  scout: requiredUrl("--scout", "SCOUT_URL"),
  scribe: requiredUrl("--scribe", "SCRIBE_URL"),
  warden: requiredUrl("--warden", "WARDEN_URL"),
};
const configs: Readonly<Record<AgentKind, string>> = {
  scout: "apps/demo-agent/wrangler.scout.jsonc",
  scribe: "apps/demo-agent/wrangler.scribe.jsonc",
  warden: "apps/demo-agent/wrangler.warden.jsonc",
};
const expectedSecrets = {
  guildhall: [
    "AUTH_COOKIE_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GUILD_ISSUER_KEY_ID",
    "GUILD_ISSUER_PRIVATE_JWK",
    "PUBLIC_ORIGIN",
    "SCOUT_A2A_URL",
    "SCRIBE_A2A_URL",
    "WARDEN_A2A_URL",
    "GUILD_DEMO_RALLY_SECRET",
  ],
  agent: [
    "HOSTED_AGENT_PRIVATE_JWK",
    "HOSTED_AGENT_PUBLIC_KEY_X",
    "HOSTED_AGENT_KEY_ID",
    "GUILD_BROKER_URL",
    "GUILD_AGENT_CREDENTIAL",
    "GUILD_DEMO_RALLY_SECRET",
  ],
} as const;

await assertDeployment("guildhall", guildhallConfig);
await assertSecretNames(guildhallConfig, expectedSecrets.guildhall);
for (const kind of Object.keys(agents) as AgentKind[]) {
  await assertDeployment(`guildhall-${kind}`, configs[kind]);
  await assertSecretNames(configs[kind], expectedSecrets.agent);
}

const guildReadiness = await jsonObject(new URL("/api/ready", guildhall));
assert(
  guildReadiness.status === "ok" && guildReadiness.phase === "complete",
  "Guildhall readiness is incomplete.",
);

const identities = await hostedIdentities();
for (const kind of Object.keys(agents) as AgentKind[]) {
  const readiness = await jsonObject(new URL("/ready", agents[kind]));
  assert(readiness.status === "ok", `${kind} readiness is not ok.`);
  const card = await jsonObject(
    new URL("/.well-known/agent-card.json", agents[kind]),
  );
  const row = identities.get(`guildhall-${kind}`);
  assert(row !== undefined, `${kind} has no seeded D1 identity.`);
  const publicJwk = parsedObject(row.public_jwk_json, `${kind} public JWK`);
  const serialized = JSON.stringify(card);
  for (const expected of [row.agent_id, row.key_id, publicJwk.x]) {
    assert(
      typeof expected === "string" && serialized.includes(expected),
      `${kind} Agent Card does not match its D1 trust root.`,
    );
  }
  assert(
    !serialized.includes('"d":'),
    `${kind} Agent Card exposes private key data.`,
  );
  assert(row.key_status === "active", `${kind} signing key is not active.`);
  assert(
    numeric(row.credential_count) === 1,
    `${kind} credential count is invalid.`,
  );
  assert(
    numeric(row.capability_count) >= 1,
    `${kind} capabilities are missing.`,
  );
  assert(
    numeric(row.public_publication_enabled) === 0,
    `${kind} autonomy policy is not safely disabled.`,
  );
}

process.stdout.write(
  "Production doctor passed: deployments, bindings, D1 trust roots, readiness, and Agent Cards agree.\n",
);

async function assertDeployment(name: string, config: string): Promise<void> {
  const value = await wranglerJson([
    "deployments",
    "list",
    "--name",
    name,
    "--config",
    config,
    "--json",
  ]);
  assert(
    Array.isArray(value) && value.length > 0,
    `${name} has no deployment history.`,
  );
}

async function assertSecretNames(
  config: string,
  expectedNames: readonly string[],
): Promise<void> {
  const value = await wranglerJson([
    "secret",
    "list",
    "--config",
    config,
    "--format",
    "json",
  ]);
  assert(Array.isArray(value), `${config} secret list is invalid.`);
  const names = new Set(
    value.flatMap((item) =>
      isRecord(item) && typeof item.name === "string" ? [item.name] : [],
    ),
  );
  for (const name of expectedNames) {
    assert(names.has(name), `${config} is missing required binding ${name}.`);
  }
}

async function hostedIdentities(): Promise<
  ReadonlyMap<string, Record<string, unknown>>
> {
  const value = await wranglerJson([
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--config",
    guildhallConfig,
    "--command",
    "SELECT agents.slug, agents.agent_id, agent_keys.key_id, agent_keys.public_jwk_json, agent_keys.status AS key_status, autonomy_policies.public_publication_enabled, COUNT(DISTINCT agent_credentials.credential_id) AS credential_count, COUNT(DISTINCT agent_capabilities.capability) AS capability_count FROM agents INNER JOIN agent_keys ON agent_keys.agent_id = agents.agent_id INNER JOIN autonomy_policies ON autonomy_policies.agent_id = agents.agent_id LEFT JOIN agent_credentials ON agent_credentials.agent_id = agents.agent_id AND agent_credentials.revoked_at IS NULL LEFT JOIN agent_capabilities ON agent_capabilities.agent_id = agents.agent_id WHERE agents.slug IN ('guildhall-scout','guildhall-scribe','guildhall-warden') GROUP BY agents.slug, agents.agent_id, agent_keys.key_id, agent_keys.public_jwk_json, agent_keys.status, autonomy_policies.public_publication_enabled ORDER BY agents.slug;",
    "--json",
  ]);
  assert(
    Array.isArray(value) && isRecord(value[0]),
    "D1 identity result is invalid.",
  );
  const rows = value[0].results;
  assert(Array.isArray(rows), "D1 identity rows are missing.");
  return new Map(
    rows.flatMap((row) =>
      isRecord(row) && typeof row.slug === "string" ? [[row.slug, row]] : [],
    ),
  );
}

async function wranglerJson(args: readonly string[]): Promise<unknown> {
  const output = await runPnpm(["exec", "wrangler", ...args]);
  return JSON.parse(stripAnsi(output)) as unknown;
}

function runPnpm(args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const cli = process.env.npm_execpath;
    const executable = cli === undefined ? "pnpm" : process.execPath;
    const commandArgs = cli === undefined ? args : [cli, ...args];
    const child = spawn(executable, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.on("error", reject);
    child.on("exit", (code) => {
      code === 0
        ? resolvePromise(stdout)
        : reject(new Error(`Wrangler doctor command exited with ${code}.`));
    });
  });
}

async function jsonObject(url: URL): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${url} returned ${response.status}.`);
  const value: unknown = await response.json();
  assert(isRecord(value), `${url} did not return a JSON object.`);
  return value;
}

function requiredUrl(optionName: string, envName: string): URL {
  const index = process.argv.indexOf(optionName);
  const value = index < 0 ? process.env[envName] : process.argv[index + 1];
  assert(
    value !== undefined && value !== "",
    `Provide ${optionName} or ${envName}.`,
  );
  const url = new URL(value);
  assert(
    url.protocol === "https:" && url.pathname === "/",
    `${envName} must be an exact HTTPS origin.`,
  );
  return url;
}

function parsedObject(value: unknown, label: string): Record<string, unknown> {
  assert(typeof value === "string", `${label} is not serialized JSON.`);
  const parsed: unknown = JSON.parse(value);
  assert(isRecord(parsed), `${label} is invalid.`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
