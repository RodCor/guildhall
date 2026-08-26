import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configs = [
  "apps/guildhall/wrangler.jsonc",
  "apps/demo-agent/wrangler.scout.jsonc",
  "apps/demo-agent/wrangler.scribe.jsonc",
  "apps/demo-agent/wrangler.warden.jsonc",
] as const;

await verifyConfiguration();
await run(["build"]);
for (const config of configs) {
  await run(["exec", "wrangler", "deploy", "--dry-run", "--config", config]);
}
const migrations = await run(
  [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "list",
    "guildhall",
    "--remote",
    "--config",
    "apps/guildhall/wrangler.jsonc",
  ],
  true,
);
if (!migrations.includes("No migrations to apply")) {
  throw new Error("Production D1 still has unapplied migrations.");
}
process.stdout.write("Deployment preflight passed for all four Workers.\n");

async function verifyConfiguration(): Promise<void> {
  const guildhall = await readFile(resolve(root, configs[0]), "utf8");
  if (guildhall.includes("00000000-0000-0000-0000-000000000001")) {
    throw new Error("Guildhall still has the placeholder D1 database ID.");
  }
  requireText(guildhall, '"observability"', configs[0]);
  requireText(guildhall, '"GITHUB_CLIENT_SECRET"', configs[0]);
  requireText(guildhall, '"AUTH_COOKIE_SECRET"', configs[0]);
  requireText(guildhall, '"GUILD_ISSUER_PRIVATE_JWK"', configs[0]);

  for (const config of configs.slice(1)) {
    const source = await readFile(resolve(root, config), "utf8");
    requireText(source, '"observability"', config);
    requireText(source, '"HOSTED_AGENT_PRIVATE_JWK"', config);
    requireText(source, '"HOSTED_AGENT_PUBLIC_KEY_X"', config);
    requireText(source, '"HOSTED_AGENT_KEY_ID"', config);
    requireText(source, '"GUILD_BROKER_URL"', config);
    requireText(source, '"GUILD_AGENT_CREDENTIAL"', config);
  }
}

function requireText(source: string, expected: string, file: string): void {
  if (!source.includes(expected)) {
    throw new Error(`${file} is missing ${expected}.`);
  }
}

function run(args: readonly string[], capture = false): Promise<string> {
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
      const text = chunk.toString("utf8");
      output += text;
      if (!capture) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        if (capture) process.stdout.write(output);
        resolvePromise(output);
      } else {
        reject(new Error(`pnpm ${args.join(" ")} exited with ${code}.`));
      }
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
