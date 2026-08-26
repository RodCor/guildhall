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

export interface HostedAgentEnv {
  /** A per-Worker Ed25519 private JWK installed with `wrangler secret put`. */
  readonly HOSTED_AGENT_PRIVATE_JWK?: string;
  /** Durable task/idempotency atom. Bound in every deployed hosted agent. */
  readonly HOSTED_AGENT_TASKS?: {
    getByName(name: string): HostedAgentTaskStoreRpc;
  };
}

export interface HostedAgentWorkerOptions {
  readonly now?: () => Date;
}

export interface HostedAgentWorker {
  fetch(request: Request, env: HostedAgentEnv): Promise<Response>;
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
        const agentCard = buildAgentCard(kind, origin);
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
        );
        const worker = createA2AWorker({
          agentCard,
          basePath: "/a2a/v1",
          executor: createSignedHostedExecutor(kind, {
            privateJwk,
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
  } satisfies ExportedHandler<HostedAgentEnv>;
  return handler;
}

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
