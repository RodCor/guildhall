import {
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_PATH,
} from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";

import { buildAgentCard, type HostedAgentKind } from "./agent-card";

const JSON_HEADERS = {
  "Cache-Control": "public, max-age=60",
  "Content-Type": "application/json; charset=utf-8",
} as const;

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return Response.json(payload, {
    ...init,
    headers,
  });
}

export function createAgentWorker(kind: HostedAgentKind): ExportedHandler {
  return {
    async fetch(request): Promise<Response> {
      try {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === AGENT_CARD_PATH) {
          return jsonResponse(buildAgentCard(kind, url.origin));
        }

        if (request.method === "GET" && url.pathname === "/spike/sdk") {
          // Constructing the official v1 client proves its Fetch-based path is in
          // the Worker bundle. Network calls remain the responsibility of item 7.
          const clientFactory = new ClientFactory();

          return jsonResponse({
            agent: kind,
            clientFactoryAvailable:
              typeof clientFactory.createFromAgentCard === "function",
            protocolVersion: A2A_PROTOCOL_VERSION,
            wireContentType: A2A_CONTENT_TYPE,
          });
        }

        if (request.method === "POST" && url.pathname === "/a2a") {
          return jsonResponse(
            {
              error: {
                code: "A2A_NOT_IMPLEMENTED",
                message:
                  "The Fetch-native A2A server adapter is implemented in checklist item 7.",
              },
            },
            {
              status: 501,
              headers: {
                "Cache-Control": "no-store",
                "Content-Type": A2A_CONTENT_TYPE,
                [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
              },
            },
          );
        }

        return jsonResponse(
          { error: { code: "NOT_FOUND", message: "Route not found." } },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          JSON.stringify({
            agent: kind,
            error: message,
            message: "demo agent request failed",
          }),
        );
        return jsonResponse(
          { error: { code: "INTERNAL_ERROR", message: "Internal error." } },
          { status: 500, headers: { "Cache-Control": "no-store" } },
        );
      }
    },
  } satisfies ExportedHandler;
}
