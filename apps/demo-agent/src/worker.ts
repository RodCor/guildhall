import {
  A2A_CONTENT_TYPE,
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  A2APublicInputRejectedError,
  A2A_VERSION_HEADER,
  InMemoryA2ATaskStore,
  createA2AWorker,
} from "@guildhall/a2a-worker";
import { scanPublicPayload } from "@guildhall/trust-engine";

import { buildAgentCard, type HostedAgentKind } from "./agent-card";
import {
  DurableObjectA2ATaskStore,
  type HostedAgentTaskStoreRpc,
} from "./durable-task-store-proxy";
import { createSignedHostedExecutor } from "./executors";
import {
  findingsArtifactContent,
  parseApprovedFixture,
  remediationArtifactContent,
} from "./fixtures";
import { artifactIdForContent, parseHostedPrivateJwk } from "./identity";
import { autonomouslyJoinGuildMission } from "./guild-client";
import type { AutonomousRecruitmentResult } from "./guild-client";

export interface HostedAgentEnv {
  /** A per-Worker Ed25519 private JWK installed with `wrangler secret put`. */
  readonly HOSTED_AGENT_PRIVATE_JWK?: string;
  /** Public Ed25519 JWK x coordinate paired with the production signing key. */
  readonly HOSTED_AGENT_PUBLIC_KEY_X?: string;
  /** Environment-specific UUID identifying the production signing key. */
  readonly HOSTED_AGENT_KEY_ID?: string;
  /** Public Guildhall origin plus the canonical A2A broker path. */
  readonly GUILD_BROKER_URL?: string;
  /** A scoped GuildNode credential installed as a Worker secret. */
  readonly GUILD_AGENT_CREDENTIAL?: string;
  /** Shared only with Guildhall; authorizes a bounded on-demand demo pulse. */
  readonly GUILD_DEMO_RALLY_SECRET?: string;
  /** Same-account HTTP transport for the hosted demo; public agents use the URL. */
  readonly GUILDHALL_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  /** Durable task/idempotency atom. Bound in every deployed hosted agent. */
  readonly HOSTED_AGENT_TASKS?: {
    getByName(name: string): HostedAgentTaskStoreRpc;
  };
}

export interface HostedAgentWorkerOptions {
  readonly now?: () => Date;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HostedAgentWorker {
  fetch(request: Request, env: HostedAgentEnv): Promise<Response>;
  scheduled(
    controller: ScheduledController,
    env: HostedAgentEnv,
    ctx: ExecutionContext,
  ): void;
}

export function createAgentWorker(
  kind: HostedAgentKind,
  options: HostedAgentWorkerOptions = {},
): HostedAgentWorker {
  // The fallback exists only for direct local/unit factory construction. Every
  // Wrangler deployment binds HOSTED_AGENT_TASKS and addresses one atom by kind.
  const localTaskStore = new InMemoryA2ATaskStore();
  const handler = {
    async fetch(request, env): Promise<Response> {
      try {
        const url = new URL(request.url);
        const origin = url.origin;
        const agentCard = buildAgentCard(
          kind,
          origin,
          env.HOSTED_AGENT_PUBLIC_KEY_X,
          env.HOSTED_AGENT_KEY_ID,
        );
        if (request.method === "GET" && url.pathname === "/ready") {
          return readinessResponse(kind, env);
        }
        if (
          request.method === "POST" &&
          url.pathname === "/internal/guildhall/rally"
        ) {
          return await handleGuildhallRally(request, kind, env, options);
        }
        const taskStore =
          env.HOSTED_AGENT_TASKS === undefined
            ? localTaskStore
            : new DurableObjectA2ATaskStore(
                env.HOSTED_AGENT_TASKS.getByName(kind),
              );
        if (request.method === "GET" && url.pathname === A2A_AGENT_CARD_PATH) {
          const discoveryWorker = createA2AWorker({
            agentCard,
            basePath: "/a2a/v1",
            taskStore,
            executor: {
              async execute(): Promise<never> {
                throw new TypeError(
                  "Discovery does not execute an assignment.",
                );
              },
            },
          });
          return await discoveryWorker.fetch(request);
        }
        const publicArtifact = await readPublicArtifact(url.pathname);
        if (publicArtifact !== null) return publicArtifact;
        const privateJwk = parseHostedPrivateJwk(
          kind,
          requireSigningSecret(env),
          env.HOSTED_AGENT_PUBLIC_KEY_X,
          env.HOSTED_AGENT_KEY_ID,
        );
        const worker = createA2AWorker({
          agentCard,
          basePath: "/a2a/v1",
          executor: createSignedHostedExecutor(kind, {
            privateJwk,
            ...(env.HOSTED_AGENT_PUBLIC_KEY_X === undefined
              ? {}
              : { publicKeyX: env.HOSTED_AGENT_PUBLIC_KEY_X }),
            ...(env.HOSTED_AGENT_KEY_ID === undefined
              ? {}
              : { keyId: env.HOSTED_AGENT_KEY_ID }),
            origin,
            ...(options.now === undefined ? {} : { now: options.now }),
          }),
          taskStore,
          validatePublicInput(message) {
            if (!scanPublicPayload(message).safe) {
              throw new A2APublicInputRejectedError();
            }
          },
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        return await worker.fetch(request);
      } catch (error) {
        console.error(
          JSON.stringify({
            agent: kind,
            errorName: error instanceof Error ? error.name : "UnknownError",
            message: "hosted A2A agent initialization failed",
          }),
        );
        return Response.json(
          {
            error: {
              code: 500,
              details: [],
              message: "Hosted agent is unavailable.",
              status: "INTERNAL",
            },
          },
          {
            status: 500,
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": A2A_CONTENT_TYPE,
              [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
            },
          },
        );
      }
    },
    scheduled(_controller, env, ctx): void {
      ctx.waitUntil(runAutonomousRecruitment(kind, env, options));
    },
  } satisfies ExportedHandler<HostedAgentEnv>;
  return handler;
}

async function runAutonomousRecruitment(
  kind: HostedAgentKind,
  env: HostedAgentEnv,
  options: HostedAgentWorkerOptions,
  targetMissionId?: string,
): Promise<AutonomousRecruitmentResult | null> {
  if (
    env.GUILD_BROKER_URL === undefined ||
    env.GUILD_AGENT_CREDENTIAL === undefined ||
    env.HOSTED_AGENT_PRIVATE_JWK === undefined
  ) {
    console.info(
      JSON.stringify({
        agent: kind,
        message: "autonomous Guild recruitment is not configured",
      }),
    );
    return null;
  }
  try {
    const result = await autonomouslyJoinGuildMission(kind, {
      brokerBaseUrl: env.GUILD_BROKER_URL,
      credential: env.GUILD_AGENT_CREDENTIAL,
      privateJwk: env.HOSTED_AGENT_PRIVATE_JWK,
      ...(env.HOSTED_AGENT_PUBLIC_KEY_X === undefined
        ? {}
        : { publicKeyX: env.HOSTED_AGENT_PUBLIC_KEY_X }),
      ...(env.HOSTED_AGENT_KEY_ID === undefined
        ? {}
        : { keyId: env.HOSTED_AGENT_KEY_ID }),
      fetch: resolveGuildFetch(env, options.fetch),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(targetMissionId === undefined ? {} : { targetMissionId }),
    });
    console.info(
      JSON.stringify({
        agent: kind,
        joined: result.joined,
        missionId: result.missionId,
        action: result.action,
        reason: result.reason,
        message: "autonomous Guild recruitment completed",
      }),
    );
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        agent: kind,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode: safeRecruitmentErrorCode(error),
        errorDetail: safeRecruitmentErrorDetail(error),
        message: "autonomous Guild recruitment failed",
      }),
    );
    return null;
  }
}

function safeRecruitmentErrorDetail(error: unknown): string | undefined {
  if (
    error === null ||
    typeof error !== "object" ||
    (error as { readonly recruitmentErrorCode?: unknown })
      .recruitmentErrorCode !== "A2A_TRANSPORT"
  ) {
    return undefined;
  }
  const cause = (error as { readonly cause?: unknown }).cause;
  if (!(cause instanceof Error))
    return cause === undefined ? undefined : "non-error";
  return cause.message
    .replace(/https?:\/\/[^\s)]+/giu, "[url]")
    .replace(/[A-Za-z0-9+/_=-]{20,}/gu, "[redacted]")
    .replace(/[^\x20-\x7E]/gu, " ")
    .slice(0, 240);
}

function resolveGuildFetch(
  env: HostedAgentEnv,
  override: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  if (override !== undefined) return override;
  if (env.GUILDHALL_SERVICE !== undefined) {
    return (input, init) => {
      // AbortSignals are invocation-local I/O objects and cannot cross a
      // service-binding boundary. The public HTTP transport retains them.
      const { signal: _signal, ...serviceInit } = init ?? {};
      return env.GUILDHALL_SERVICE!.fetch(input, serviceInit);
    };
  }
  return globalThis.fetch;
}

function safeRecruitmentErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const stage = (error as { readonly recruitmentErrorCode?: unknown })
      .recruitmentErrorCode;
    if (typeof stage === "string") return stage;
    const httpStatus = (error as { readonly httpStatus?: unknown }).httpStatus;
    if (typeof httpStatus === "number" && Number.isInteger(httpStatus)) {
      return `A2A_HTTP_${String(httpStatus)}`;
    }
  }
  if (error instanceof Error) {
    const discovery = /Guild discovery failed with ([1-5][0-9]{2})/u.exec(
      error.message,
    );
    if (discovery !== null) return `DISCOVERY_HTTP_${discovery[1]}`;
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "TIMEOUT";
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      return "VALIDATION";
    }
  }
  return "UNCLASSIFIED";
}

async function handleGuildhallRally(
  request: Request,
  kind: HostedAgentKind,
  env: HostedAgentEnv,
  options: HostedAgentWorkerOptions,
): Promise<Response> {
  const configuredSecret = env.GUILD_DEMO_RALLY_SECRET;
  if (
    configuredSecret === undefined ||
    configuredSecret.length < 32 ||
    !(await constantTimeTextEqual(
      request.headers.get("Authorization") ?? "",
      `GuildhallRally ${configuredSecret}`,
    ))
  ) {
    return noStoreJson(
      { error: "RALLY_NOT_AUTHORIZED", message: "Rally authorization failed." },
      401,
    );
  }
  let value: unknown;
  try {
    const text = await request.text();
    if (text.length > 4_096) throw new TypeError("request too large");
    value = JSON.parse(text) as unknown;
  } catch {
    return noStoreJson(
      { error: "INVALID_RALLY", message: "Rally request is invalid." },
      400,
    );
  }
  const missionIdValue =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).missionId
      : undefined;
  const missionId = typeof missionIdValue === "string" ? missionIdValue : "";
  if (!UUID_PATTERN.test(missionId)) {
    return noStoreJson(
      { error: "INVALID_RALLY", message: "Mission identifier is invalid." },
      400,
    );
  }
  if (!autonomousRecruitmentConfigured(env)) {
    return noStoreJson(
      {
        error: "RALLY_NOT_READY",
        message: "Autonomous recruitment is unavailable.",
      },
      503,
    );
  }
  const result = await runAutonomousRecruitment(kind, env, options, missionId);
  return noStoreJson(
    { agent: kind, missionId, result },
    result === null ? 502 : 200,
  );
}

function readinessResponse(
  kind: HostedAgentKind,
  env: HostedAgentEnv,
): Response {
  try {
    if (!autonomousRecruitmentConfigured(env))
      throw new TypeError("missing configuration");
    if ((env.GUILD_DEMO_RALLY_SECRET?.length ?? 0) < 32) {
      throw new TypeError("missing rally secret");
    }
    const broker = new URL(env.GUILD_BROKER_URL!);
    if (broker.protocol !== "https:" || broker.pathname !== "/a2a/guild/v1") {
      throw new TypeError("invalid broker URL");
    }
    parseHostedPrivateJwk(
      kind,
      env.HOSTED_AGENT_PRIVATE_JWK!,
      env.HOSTED_AGENT_PUBLIC_KEY_X,
      env.HOSTED_AGENT_KEY_ID,
    );
    return noStoreJson({
      service: `guildhall-${kind}`,
      status: "ok",
      protocolCore: "commitment/v1",
      autonomousRecruitmentConfigured: true,
      brokerTransport:
        env.GUILDHALL_SERVICE === undefined
          ? "public-http"
          : "service-binding-http",
    });
  } catch {
    return noStoreJson(
      { service: `guildhall-${kind}`, status: "not-ready" },
      503,
    );
  }
}

function autonomousRecruitmentConfigured(env: HostedAgentEnv): boolean {
  return (
    env.GUILD_BROKER_URL !== undefined &&
    env.GUILD_AGENT_CREDENTIAL !== undefined &&
    env.HOSTED_AGENT_PRIVATE_JWK !== undefined &&
    env.HOSTED_AGENT_PUBLIC_KEY_X !== undefined &&
    env.HOSTED_AGENT_KEY_ID !== undefined
  );
}

async function constantTimeTextEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireSigningSecret(env: HostedAgentEnv): string {
  if (env.HOSTED_AGENT_PRIVATE_JWK === undefined) {
    throw new TypeError("HOSTED_AGENT_PRIVATE_JWK is required for execution.");
  }
  return env.HOSTED_AGENT_PRIVATE_JWK;
}

async function readPublicArtifact(pathname: string): Promise<Response | null> {
  const match = /^\/artifacts\/([0-9a-f-]+)$/u.exec(pathname);
  if (match === null) return null;
  const findings = parseApprovedFixture("accessibility-dungeon-v1");
  const candidates = [
    findingsArtifactContent(findings),
    remediationArtifactContent(findings),
  ];
  for (const content of candidates) {
    if ((await artifactIdForContent(content)) === match[1]) {
      return Response.json(content, {
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }
  }
  return Response.json(
    { error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found." } },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}
