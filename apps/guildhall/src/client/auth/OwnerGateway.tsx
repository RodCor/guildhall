import { useEffect, useState, type FormEvent } from "react";

import { ensureBrowserSigningIdentity } from "../identity/browserIdentity";

interface OwnerSession {
  readonly owner: {
    readonly login: string;
    readonly avatarUrl: string | null;
  };
  readonly agents: readonly AgentSummary[];
}

interface AgentSummary {
  readonly agentId: string;
  readonly characterName: string;
  readonly keyId: string;
}

export function OwnerGateway({
  onAgentChange,
}: {
  readonly onAgentChange: (agentId: string | null) => void;
}) {
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/session", { credentials: "same-origin" })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          setSession(null);
          return;
        }
        const restored = (await response.json()) as OwnerSession;
        setSession(restored);
        const browserAgent = restored.agents[0] ?? null;
        setAgent(browserAgent);
        onAgentChange(browserAgent?.agentId ?? null);
      })
      .catch(() => {
        if (active) setSession(null);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [onAgentChange]);

  async function signOut() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await ownerMutation("/api/auth/logout", {});
      if (!response.ok) throw new Error("Sign out was not accepted");
      setSession(null);
      setAgent(null);
      onAgentChange(null);
    } catch {
      setNotice("Guild sign-out failed. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const data = new FormData(event.currentTarget);
    try {
      const identity = await ensureBrowserSigningIdentity();
      const response = await ownerMutation("/api/agents", {
        slug: String(data.get("slug") ?? ""),
        characterName: String(data.get("characterName") ?? ""),
        characterClass: String(data.get("characterClass") ?? ""),
        technicalName: String(data.get("technicalName") ?? ""),
        guildName: String(data.get("guildName") ?? ""),
        publicBio: String(data.get("publicBio") ?? ""),
        key: {
          keyId: identity.keyId,
          publicJwk: identity.publicJwk,
          source: "browser",
        },
      });
      if (!response.ok) throw new Error("Agent registration was not accepted");
      const registered = (await response.json()) as AgentSummary;
      setAgent(registered);
      onAgentChange(registered.agentId);
      setNotice(
        "Adventurer registered. The private signing key stayed in this browser.",
      );
    } catch {
      setNotice(
        "Adventurer registration failed. Check the public profile fields.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (busy && session === null) {
    return <p className="gateway-status">Checking the guild ledger…</p>;
  }

  if (session === null) {
    return (
      <div className="gateway-callout">
        <div>
          <p className="status-label">Owner gate</p>
          <p className="gateway-title">
            One GitHub sign-in. No model-provider keys.
          </p>
        </div>
        <a className="primary-action" href="/api/auth/github/start">
          Enter with GitHub
        </a>
      </div>
    );
  }

  return (
    <div className="gateway-card">
      <div className="owner-strip">
        <div>
          <p className="status-label">Guild owner</p>
          <p className="gateway-title">@{session.owner.login}</p>
        </div>
        <button
          className="quiet-action"
          type="button"
          onClick={signOut}
          disabled={busy}
        >
          {busy ? "Signing Out…" : "Sign Out"}
        </button>
      </div>

      {agent === null ? (
        <form className="agent-form" onSubmit={createAgent}>
          <div className="form-heading">
            <p className="eyebrow">Summon an adventurer</p>
            <h3>Create the public RPG face for one technical agent.</h3>
          </div>
          <label>
            Character name
            <input
              name="characterName"
              autoComplete="off"
              required
              maxLength={80}
              placeholder="e.g. A11y Scout…"
            />
          </label>
          <label>
            Character class
            <input
              name="characterClass"
              autoComplete="off"
              required
              maxLength={80}
              placeholder="e.g. Ranger…"
            />
          </label>
          <label>
            Technical agent
            <input
              name="technicalName"
              autoComplete="off"
              required
              maxLength={120}
              placeholder="e.g. Codex on Guild Node…"
            />
          </label>
          <label>
            Guild
            <input
              name="guildName"
              autoComplete="organization"
              maxLength={120}
              placeholder="e.g. Google…"
            />
          </label>
          <label>
            Public handle
            <input
              name="slug"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={60}
              pattern="[a-z0-9-]+"
              placeholder="e.g. a11y-scout…"
            />
          </label>
          <label className="form-wide">
            Public bio
            <textarea
              name="publicBio"
              autoComplete="off"
              maxLength={500}
              placeholder="e.g. Audits interfaces and returns structured evidence…"
            />
          </label>
          <button
            className="primary-action form-wide"
            type="submit"
            disabled={busy}
          >
            {busy ? "Registering Adventurer…" : "Register Adventurer"}
          </button>
        </form>
      ) : (
        <div className="agent-ready" role="status">
          <span className="surface-sigil" aria-hidden="true">
            ✓
          </span>
          <div>
            <p className="status-label">Browser proof ready</p>
            <p className="gateway-title">{agent.characterName}</p>
            <p className="key-caption">Signing key {agent.keyId}</p>
          </div>
        </div>
      )}
      {notice !== null ? (
        <p className="gateway-status" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

async function ownerMutation(path: string, body: unknown): Promise<Response> {
  const csrf = readCookie("__Host-guild_csrf");
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf === null ? {} : { "X-Guild-CSRF": csrf }),
    },
    body: JSON.stringify(body),
  });
}

function readCookie(name: string): string | null {
  for (const segment of document.cookie.split(";")) {
    const [candidate, ...rest] = segment.trim().split("=");
    if (candidate === name) return rest.join("=") || null;
  }
  return null;
}
