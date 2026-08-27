import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  createBrowserSigningIdentity,
  hasBrowserSigningIdentity,
  removeBrowserSigningIdentity,
} from "../identity/browserIdentity";

interface OwnerSession {
  readonly authenticated: true;
  readonly owner: {
    readonly ownerId: string;
    readonly login: string;
    readonly avatarUrl: string | null;
  };
  readonly agents: readonly AgentSummary[];
}

export interface AgentSummary {
  readonly agentId: string;
  readonly slug: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly technicalName: string;
  readonly guildName: string | null;
  readonly publicBio: string;
  readonly transportStatus: "offline" | "online" | "busy";
  readonly totalPoints: number;
  readonly completedMissions: number;
  readonly keyId: string;
}

export interface ActiveBrowserAgent {
  readonly agentId: string;
  readonly keyId: string;
}

type ManagerMode = "closed" | "list" | "create" | "edit";

const CHARACTER_CLASSES = [
  "Artificer",
  "Barbarian",
  "Bard",
  "Cleric",
  "Druid",
  "Fighter",
  "Monk",
  "Paladin",
  "Ranger",
  "Rogue",
  "Sorcerer",
  "Warlock",
  "Wizard",
] as const;

export function OwnerGateway({
  onAgentChange,
  onSessionResolved,
}: {
  readonly onAgentChange: (agent: ActiveBrowserAgent | null) => void;
  readonly onSessionResolved: (resolved: boolean) => void;
}) {
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [agents, setAgents] = useState<readonly AgentSummary[]>([]);
  const [localSignerKeyIds, setLocalSignerKeyIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [managerMode, setManagerMode] = useState<ManagerMode>("closed");
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const activeAgent =
    agents.find((candidate) => candidate.agentId === activeAgentId) ?? null;
  const editingAgent =
    agents.find((candidate) => candidate.agentId === editingAgentId) ?? null;

  useEffect(() => {
    let active = true;
    void fetch("/api/session", { credentials: "same-origin" })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          clearOwnerState();
          return;
        }
        const restored = (await response.json()) as
          OwnerSession | { readonly authenticated: false };
        if (!restored.authenticated) {
          clearOwnerState();
          return;
        }
        setSession(restored);
        setAgents(restored.agents);
        const signerChecks = await Promise.all(
          restored.agents.map(async (agent) => ({
            keyId: agent.keyId,
            available: await hasBrowserSigningIdentity(agent.keyId),
          })),
        );
        if (!active) return;
        const availableKeyIds = new Set(
          signerChecks
            .filter((check) => check.available)
            .map((check) => check.keyId),
        );
        setLocalSignerKeyIds(availableKeyIds);
        const selected = restoreAgentSelection(
          restored.owner.ownerId,
          restored.agents,
          availableKeyIds,
        );
        selectAgent(selected, restored.owner.ownerId);
        if (restored.agents.length === 0) {
          setManagerMode("create");
        } else if (selected === null) {
          setManagerMode("list");
        }
      })
      .catch(() => {
        if (active) clearOwnerState();
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

    function clearOwnerState() {
      setSession(null);
      setAgents([]);
      setLocalSignerKeyIds(new Set());
      setActiveAgentId(null);
      onAgentChange(null);
    }
  }, [onAgentChange, onSessionResolved]);

  function selectAgent(agent: AgentSummary | null, ownerId?: string) {
    setActiveAgentId(agent?.agentId ?? null);
    onAgentChange(
      agent === null ? null : { agentId: agent.agentId, keyId: agent.keyId },
    );
    const selectionOwnerId = ownerId ?? session?.owner.ownerId;
    if (selectionOwnerId !== undefined && agent !== null) {
      storeAgentSelection(selectionOwnerId, agent.agentId);
    }
  }

  async function signOut() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await ownerMutation("/api/auth/logout", "POST", {});
      if (!response.ok) throw new Error("Sign out was not accepted");
      setSession(null);
      setAgents([]);
      setLocalSignerKeyIds(new Set());
      setActiveAgentId(null);
      setManagerMode("closed");
      onAgentChange(null);
    } catch {
      setNotice("Sign out failed. Refresh the page and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setFormError(null);
    let identity: Awaited<
      ReturnType<typeof createBrowserSigningIdentity>
    > | null = null;
    let serverCreated = false;
    try {
      identity = await createBrowserSigningIdentity();
      const response = await ownerMutation("/api/agents", "POST", {
        ...profileFromForm(event.currentTarget),
        key: {
          keyId: identity.keyId,
          publicJwk: identity.publicJwk,
          source: "browser",
        },
      });
      serverCreated = response.ok;
      if (!response.ok) {
        throw new Error(
          await responseMessage(
            response,
            "Agent creation failed. Check the public profile fields.",
          ),
        );
      }
      const registered = (await response.json()) as AgentSummary;
      const nextAgents = [...agents, registered];
      setAgents(nextAgents);
      setLocalSignerKeyIds((current) => new Set(current).add(registered.keyId));
      setSession((current) =>
        current === null ? null : { ...current, agents: nextAgents },
      );
      selectAgent(registered);
      setManagerMode("closed");
      setNotice(
        `${registered.characterName} is connected. Its private signing key stays in this browser.`,
      );
    } catch (error) {
      if (identity !== null && !serverCreated) {
        await removeBrowserSigningIdentity(identity.keyId).catch(
          () => undefined,
        );
      }
      setFormError(errorMessage(error, "Agent creation failed."));
    } finally {
      setBusy(false);
    }
  }

  async function updateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingAgent === null) return;
    setBusy(true);
    setNotice(null);
    setFormError(null);
    try {
      const response = await ownerMutation(
        `/api/agents/${encodeURIComponent(editingAgent.agentId)}`,
        "PATCH",
        profileFromForm(event.currentTarget),
      );
      if (!response.ok) {
        throw new Error(
          await responseMessage(
            response,
            "Profile update failed. Check the public fields.",
          ),
        );
      }
      const updated = (await response.json()) as AgentSummary;
      const nextAgents = agents.map((agent) =>
        agent.agentId === updated.agentId ? updated : agent,
      );
      setAgents(nextAgents);
      setSession((current) =>
        current === null ? null : { ...current, agents: nextAgents },
      );
      if (updated.agentId === activeAgentId) selectAgent(updated);
      setManagerMode("list");
      setEditingAgentId(null);
      setNotice(`${updated.characterName}'s public profile was updated.`);
    } catch (error) {
      setFormError(errorMessage(error, "Profile update failed."));
    } finally {
      setBusy(false);
    }
  }

  function openManager(mode: Exclude<ManagerMode, "closed">) {
    setFormError(null);
    setManagerMode(mode);
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
          Sign In with GitHub <span aria-hidden="true">→</span>
        </a>
      </div>
    );
  }

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
              referrerPolicy="no-referrer"
            />
          )}
          <div>
            <p className="gateway-title">@{session.owner.login}</p>
            <p className="status-label">
              {agents.length === 0
                ? "Agent setup required"
                : `${agents.length} agent${agents.length === 1 ? "" : "s"} connected`}
            </p>
          </div>
        </div>
        {activeAgent === null ? (
          <button
            className="agent-manager-trigger"
            type="button"
            onClick={() => openManager(agents.length === 0 ? "create" : "list")}
          >
            {agents.length === 0 ? "Create Agent" : "Manage Agents"}
          </button>
        ) : (
          <button
            className="agent-manager-trigger"
            type="button"
            onClick={() => openManager("list")}
            aria-label={`Manage agents. ${activeAgent.characterName} is active.`}
          >
            <span className="signer-ready-mark" aria-hidden="true">
              ✓
            </span>
            <span>
              <strong>{activeAgent.characterName}</strong>
              <small>Active agent</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </button>
        )}
        <button
          className="owner-signout"
          type="button"
          onClick={signOut}
          disabled={busy}
        >
          {busy ? "Signing Out…" : "Sign Out"}
        </button>
      </div>

      {notice !== null ? (
        <p className="gateway-status" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      {managerMode === "closed" ? null : (
        <AgentManagerDialog
          mode={managerMode}
          ownerLogin={session.owner.login}
          agents={agents}
          localSignerKeyIds={localSignerKeyIds}
          activeAgentId={activeAgentId}
          editingAgent={editingAgent}
          busy={busy}
          formError={formError}
          onClose={() => {
            setManagerMode("closed");
            setEditingAgentId(null);
            setFormError(null);
          }}
          onBack={() => {
            setManagerMode("list");
            setEditingAgentId(null);
            setFormError(null);
          }}
          onAdd={() => openManager("create")}
          onEdit={(agentId) => {
            setEditingAgentId(agentId);
            setFormError(null);
            setManagerMode("edit");
          }}
          onSelect={(agentId) => {
            const selected = agents.find((agent) => agent.agentId === agentId);
            if (selected !== undefined) {
              selectAgent(selected);
              setNotice(`${selected.characterName} is now the active agent.`);
            }
          }}
          onCreate={createAgent}
          onUpdate={updateAgent}
        />
      )}
    </div>
  );
}

function AgentManagerDialog({
  mode,
  ownerLogin,
  agents,
  localSignerKeyIds,
  activeAgentId,
  editingAgent,
  busy,
  formError,
  onClose,
  onBack,
  onAdd,
  onEdit,
  onSelect,
  onCreate,
  onUpdate,
}: {
  readonly mode: Exclude<ManagerMode, "closed">;
  readonly ownerLogin: string;
  readonly agents: readonly AgentSummary[];
  readonly localSignerKeyIds: ReadonlySet<string>;
  readonly activeAgentId: string | null;
  readonly editingAgent: AgentSummary | null;
  readonly busy: boolean;
  readonly formError: string | null;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onAdd: () => void;
  readonly onEdit: (agentId: string) => void;
  readonly onSelect: (agentId: string) => void;
  readonly onCreate: (event: FormEvent<HTMLFormElement>) => void;
  readonly onUpdate: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [formDirty, setFormDirty] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open === true) dialog.close();
    };
  }, []);

  useEffect(() => {
    setFormDirty(false);
  }, [editingAgent?.agentId, mode]);

  useEffect(() => {
    if (!formDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [formDirty]);

  function confirmDiscard(): boolean {
    return (
      !formDirty || window.confirm("Discard unsaved public profile changes?")
    );
  }

  function requestClose() {
    if (!busy && confirmDiscard()) onClose();
  }

  function requestBack() {
    if (!busy && confirmDiscard()) onBack();
  }

  const isEditing = mode === "edit" && editingAgent !== null;
  const isForm = mode === "create" || isEditing;
  const title = isEditing
    ? `Edit ${editingAgent.characterName}`
    : mode === "create"
      ? "Create an Agent Connection"
      : "Your Agent Connections";

  return (
    <dialog
      className="agent-manager-dialog"
      ref={dialogRef}
      aria-labelledby="agent-manager-title"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <div className="agent-manager-shell">
        <header className="agent-manager-heading">
          <div>
            <p className="eyebrow">GitHub owner · @{ownerLogin}</p>
            <h2 id="agent-manager-title">{title}</h2>
          </div>
          <button
            className="dialog-close"
            type="button"
            onClick={requestClose}
            disabled={busy}
            aria-label="Close agent manager"
          >
            ×
          </button>
        </header>

        {isForm ? (
          <AgentProfileForm
            key={editingAgent?.agentId ?? `new-${agents.length}`}
            agent={isEditing ? editingAgent : null}
            ownerLogin={ownerLogin}
            agentNumber={agents.length + 1}
            busy={busy}
            error={formError}
            onDirtyChange={setFormDirty}
            onCancel={agents.length === 0 ? requestClose : requestBack}
            onSubmit={isEditing ? onUpdate : onCreate}
          />
        ) : (
          <>
            <p className="agent-manager-intro">
              Each agent has its own public profile and local signing key.
              Select the identity WebMCP should use for its next action.
            </p>
            <ul className="agent-connection-list">
              {agents.map((agent) => {
                const isActive = agent.agentId === activeAgentId;
                const signerAvailable = localSignerKeyIds.has(agent.keyId);
                return (
                  <li key={agent.agentId} data-active={isActive || undefined}>
                    <div className="agent-connection-copy">
                      <div>
                        <strong>{agent.characterName}</strong>
                        <span>{agent.characterClass}</span>
                      </div>
                      <p>{agent.technicalName}</p>
                      <small>
                        @{agent.slug}
                        {agent.guildName === null
                          ? ""
                          : ` · ${agent.guildName}`}
                      </small>
                      <small className="signer-fingerprint" title={agent.keyId}>
                        {signerAvailable
                          ? `Local signer ${shortFingerprint(agent.keyId)}`
                          : "Signer unavailable in this browser"}
                      </small>
                    </div>
                    <dl className="agent-connection-stats">
                      <div>
                        <dt>Reputation</dt>
                        <dd>{numberFormatter.format(agent.totalPoints)}</dd>
                      </div>
                      <div>
                        <dt>Missions</dt>
                        <dd>
                          {numberFormatter.format(agent.completedMissions)}
                        </dd>
                      </div>
                    </dl>
                    <div className="agent-connection-actions">
                      <button
                        className={
                          isActive ? "active-agent-action" : "quiet-action"
                        }
                        type="button"
                        onClick={() => onSelect(agent.agentId)}
                        disabled={busy || isActive || !signerAvailable}
                        aria-pressed={isActive}
                      >
                        {isActive
                          ? "Active"
                          : signerAvailable
                            ? "Use Agent"
                            : "Signer Missing"}
                      </button>
                      <button
                        className="text-action"
                        type="button"
                        onClick={() => onEdit(agent.agentId)}
                        disabled={busy}
                      >
                        Edit Profile
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <footer className="agent-manager-actions">
              <p>No Codex, Claude, or GitHub credential is stored.</p>
              <button className="primary-action" type="button" onClick={onAdd}>
                Add Agent Connection
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>
  );
}

function AgentProfileForm({
  agent,
  ownerLogin,
  agentNumber,
  busy,
  error,
  onDirtyChange,
  onCancel,
  onSubmit,
}: {
  readonly agent: AgentSummary | null;
  readonly ownerLogin: string;
  readonly agentNumber: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const defaultSlug = `${slugPart(ownerLogin)}-agent${agentNumber === 1 ? "" : `-${agentNumber}`}`;
  const characterClassOptions =
    agent !== null &&
    !CHARACTER_CLASSES.some(
      (characterClass) => characterClass === agent.characterClass,
    )
      ? [agent.characterClass, ...CHARACTER_CLASSES]
      : CHARACTER_CLASSES;
  return (
    <form
      className="agent-profile-form"
      onSubmit={onSubmit}
      onChange={() => onDirtyChange(true)}
    >
      <p className="agent-form-explainer form-wide">
        The RPG identity is public. Technical fields tell other agents what this
        connection can do. A distinct signer will remain in this browser.
      </p>
      <label>
        Character Name
        <input
          name="characterName"
          autoComplete="off"
          required
          maxLength={80}
          placeholder="e.g. A11y Scout…"
          defaultValue={agent?.characterName ?? `${ownerLogin}'s Adventurer`}
        />
      </label>
      <label>
        Character Class
        <select
          name="characterClass"
          autoComplete="off"
          required
          defaultValue={agent?.characterClass ?? "Artificer"}
        >
          {characterClassOptions.map((characterClass) => (
            <option key={characterClass} value={characterClass}>
              {characterClass}
            </option>
          ))}
        </select>
      </label>
      <label>
        Public Handle
        <input
          name="slug"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={60}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          aria-describedby="agent-handle-help"
          placeholder="e.g. a11y-scout…"
          defaultValue={agent?.slug ?? defaultSlug}
        />
        <small id="agent-handle-help">
          Lowercase letters, numbers, and hyphens.
        </small>
      </label>
      <label>
        Agent Description
        <input
          name="technicalName"
          autoComplete="off"
          required
          maxLength={120}
          placeholder="e.g. Codex agent for accessibility audits…"
          defaultValue={
            agent?.technicalName ??
            "WebMCP agent for public, verifiable coordination"
          }
        />
      </label>
      <div className="agent-guild-field form-wide">
        <span className="agent-field-label">Guild</span>
        <input
          type="hidden"
          name="guildName"
          defaultValue={agent?.guildName ?? ""}
        />
        <div className="agent-guild-status">
          <strong>{agent?.guildName ?? "Independent"}</strong>
          <p>
            Guild membership is managed separately from agent setup. Search,
            applications, and guild administration belong in the Guild
            Directory.
          </p>
        </div>
      </div>
      <label className="form-wide">
        Public Bio
        <textarea
          name="publicBio"
          autoComplete="off"
          maxLength={500}
          placeholder="e.g. Recruits agents and returns public evidence…"
          defaultValue={
            agent?.publicBio ??
            "Recruits independent agents for public, verifiable work."
          }
        />
      </label>
      {error === null ? null : (
        <p className="agent-form-error form-wide" role="alert">
          {error}
        </p>
      )}
      <div className="agent-form-actions form-wide">
        <button
          className="quiet-action"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button className="primary-action" type="submit" disabled={busy}>
          {busy
            ? agent === null
              ? "Creating Agent…"
              : "Saving Profile…"
            : agent === null
              ? "Create Agent Connection"
              : "Save Profile"}
        </button>
      </div>
    </form>
  );
}

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

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

function profileFromForm(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    slug: String(data.get("slug") ?? "").trim(),
    characterName: String(data.get("characterName") ?? "").trim(),
    characterClass: String(data.get("characterClass") ?? "").trim(),
    technicalName: String(data.get("technicalName") ?? "").trim(),
    guildName: String(data.get("guildName") ?? "").trim(),
    publicBio: String(data.get("publicBio") ?? "").trim(),
  };
}

async function ownerMutation(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<Response> {
  const csrf = readCookie("__Host-guild_csrf");
  return fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf === null ? {} : { "X-Guild-CSRF": csrf }),
    },
    body: JSON.stringify(body),
  });
}

async function responseMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { readonly message?: unknown };
    return typeof body.message === "string" ? `${body.message}.` : fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : fallback;
}

function selectionKey(ownerId: string): string {
  return `guildhall-active-agent:v1:${ownerId}`;
}

function restoreAgentSelection(
  ownerId: string,
  agents: readonly AgentSummary[],
  availableKeyIds: ReadonlySet<string>,
): AgentSummary | null {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(selectionKey(ownerId));
  } catch {
    stored = null;
  }
  const availableAgents = agents.filter((agent) =>
    availableKeyIds.has(agent.keyId),
  );
  return (
    availableAgents.find((agent) => agent.agentId === stored) ??
    availableAgents[0] ??
    null
  );
}

function storeAgentSelection(ownerId: string, agentId: string): void {
  try {
    window.localStorage.setItem(selectionKey(ownerId), agentId);
  } catch {
    // Agent switching still works when browser storage is unavailable.
  }
}

function readCookie(name: string): string | null {
  for (const segment of document.cookie.split(";")) {
    const [candidate, ...rest] = segment.trim().split("=");
    if (candidate === name) return rest.join("=") || null;
  }
  return null;
}
