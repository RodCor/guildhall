import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface GuildNodeConfig {
  readonly version: 1;
  readonly baseUrl: string;
  readonly agentId: string;
  readonly keyId: string;
  readonly credential: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
  readonly publicJwk: JsonWebKey;
  readonly privateJwk: JsonWebKey;
  readonly inboxCursor: string | null;
  readonly pairedAt: string;
}

export function defaultConfigPath(environment = process.env): string {
  if (environment.GUILDHALL_NODE_CONFIG) {
    return resolve(environment.GUILDHALL_NODE_CONFIG);
  }
  const root =
    environment.XDG_CONFIG_HOME ??
    environment.APPDATA ??
    join(homedir(), ".config");
  return join(root, "guildhall", "guild-node.json");
}

export async function readNodeConfig(
  path = defaultConfigPath(),
): Promise<GuildNodeConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isGuildNodeConfig(parsed) ? parsed : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error("Guild Node configuration could not be read", {
      cause: error,
    });
  }
}

export async function writeNodeConfig(
  config: GuildNodeConfig,
  path = defaultConfigPath(),
): Promise<void> {
  if (!isGuildNodeConfig(config)) {
    throw new TypeError("Refusing to persist an invalid Guild Node config");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function updateInboxCursor(
  cursor: string | null,
  path = defaultConfigPath(),
): Promise<void> {
  const config = await readNodeConfig(path);
  if (config === null) throw new Error("Guild Node is not paired");
  await writeNodeConfig({ ...config, inboxCursor: cursor }, path);
}

function isGuildNodeConfig(value: unknown): value is GuildNodeConfig {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    isSafeBaseUrl(value.baseUrl) &&
    isUuid(value.agentId) &&
    isUuid(value.keyId) &&
    typeof value.credential === "string" &&
    /^[A-Za-z0-9_-]{43,128}$/u.test(value.credential) &&
    isUuid(value.credentialId) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string") &&
    isRecord(value.publicJwk) &&
    isRecord(value.privateJwk) &&
    (value.inboxCursor === null || typeof value.inboxCursor === "string") &&
    typeof value.pairedAt === "string" &&
    Number.isFinite(Date.parse(value.pairedAt))
  );
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Guild base URL must use HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      "Guild base URL cannot contain credentials or query data",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function isSafeBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeBaseUrl(value) === value.replace(/\/$/u, "");
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
