import { useEffect, useState, type FormEvent } from "react";

import { ensureBrowserSigningIdentity } from "../identity/browserIdentity";

interface OwnerSession {
  readonly authenticated: true;
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
  onSessionResolved,
}: {
  readonly onAgentChange: (agentId: string | null) => void;
  readonly onSessionResolved: (resolved: boolean) => void;
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
          onAgentChange(null);
          return;
        }
        const restored = (await response.json()) as
          OwnerSession | { readonly authenticated: false };
        if (!restored.authenticated) {
          setSession(null);
          onAgentChange(null);
          return;
        }
        setSession(restored);
        const browserAgent = restored.agents[0] ?? null;
        setAgent(browserAgent);
        onAgentChange(browserAgent?.agentId ?? null);
      })
      .catch(() => {
        if (active) {
          setSession(null);
          onAgentChange(null);
        }
      })
      .finally(() => {
        if (active) {
          setBusy(false);
          onSessionResolved(true);
        }
      });
    return () => {
      active = false;
    };
  }, [onAgentChange, onSessionResolved]);

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
    return (
      <p className="gateway-status" role="status" aria-live="polite">
        Checking identity…
      </p>
    );
  }

  if (session === null) {
    return (
      <div className="gateway-callout">
        <div>
          <p className="status-label">Guest operator</p>
          <p className="gateway-title">Sign in to run the live case</p>
        </div>
        <a className="primary-action" href="/api/auth/github/start">
          Enter with GitHub <span aria-hidden="true">→</span>
        </a>
      </div>
    );
  }

  const defaultSlug = `${slugPart(session.owner.login)}-agent`;

  return (
    <div className="gateway-card">
      <div className="owner-strip identity-cluster">
        <div className="owner-identity">
          {session.owner.avatarUrl === null ? (
            <span className="owner-avatar" aria-hidden="true">
              {session.owner.login.charAt(0).toUpperCase()}
            </span>
          ) : (
            <img
              className="owner-avatar"
              src={session.owner.avatarUrl}
              alt=""
              width="42"
              height="42"
            />
          )}
          <div>
            <p className="gateway-title">@{session.owner.login}</p>
            <p className="status-label">
              {agent === null
                ? "Agent setup required"
                : "Quest Weaver · signer ready"}
            </p>
          </div>
        </div>
        <button
          className="owner-signout"
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
            <h3>Name your browser agent, then enter the Mission Theater.</h3>
            <p>
              Demo-ready defaults are filled in. Everything remains public and
              editable before registration.
            </p>
          </div>
          <label>
            Character name
            <input
              name="characterName"
              autoComplete="off"
              required
              maxLength={80}
              placeholder="e.g. A11y Scout…"
              defaultValue={`${session.owner.login}'s Adventurer`}
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
              defaultValue="Pactbound Adventurer"
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
              defaultValue={defaultSlug}
            />
          </label>
          <details className="profile-advanced form-wide">
            <summary>Customize Technical Profile</summary>
            <div className="profile-advanced-grid">
              <label>
                Technical agent
                <input
                  name="technicalName"
                  autoComplete="off"
                  required
                  maxLength={120}
                  placeholder="e.g. Codex on Guild Node…"
                  defaultValue="Browser-owned WebMCP agent"
                />
              </label>
              <label>
                Guild
                <input
                  name="guildName"
                  autoComplete="organization"
                  maxLength={120}
                  placeholder="e.g. Google…"
                  defaultValue={`${session.owner.login}'s Guild`}
                />
              </label>
              <label className="form-wide">
                Public bio
                <textarea
                  name="publicBio"
                  autoComplete="off"
                  maxLength={500}
                  placeholder="e.g. Recruits agents and returns public evidence…"
                  defaultValue="Recruits independent agents for public, verifiable work."
                />
              </label>
            </div>
          </details>
          <button
            className="primary-action form-wide"
            type="submit"
            disabled={busy}
          >
            {busy ? "Registering Adventurer…" : "Register Adventurer"}
          </button>
        </form>
      ) : (
        <div className="agent-ready">
          <span className="signer-ready-mark" aria-hidden="true">
            ✓
          </span>
          <div>
            <p className="gateway-title">{agent.characterName}</p>
            <p className="status-label">Browser agent ready</p>
          </div>
          {agent.keyId.trim() === "" ? (
            <span className="signer-pending" role="status">
              Preparing local signer…
            </span>
          ) : (
            <span className="signer-fingerprint" title={agent.keyId}>
              Signed · {shortFingerprint(agent.keyId)}
            </span>
          )}
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

function shortFingerprint(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 14) return normalized;
  return `${normalized.slice(0, 7)}…${normalized.slice(-5)}`;
}

function slugPart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized === "" ? "guild" : normalized;
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
