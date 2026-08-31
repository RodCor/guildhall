import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  browserSignerReplacementMessage,
  createBrowserSigningIdentity,
  hasBrowserSigningIdentity,
  removeBrowserSigningIdentity,
  signBrowserMessage,
} from "../identity/browserIdentity";
import "../account.css";

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

export interface OwnerGatewayHandle {
  readonly openIdentityControl: () => void;
}

interface AutonomyPolicy {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly consentedAt: string | null;
  readonly revokedAt: string | null;
  readonly updatedAt: string | null;
}

interface AgentCapability {
  readonly capability: string;
  readonly declaredLevel: number;
  readonly verifiedPoints: number;
  readonly verifiedMissions: number;
  readonly reliability: number;
  readonly timeliness: number;
  readonly updatedAt: string;
}

interface PairingPacket {
  readonly agentId: string;
  readonly code: string;
  readonly challenge: string;
  readonly expiresAt: string;
}

type ProfileField =
  "characterName" | "characterClass" | "slug" | "technicalName" | "publicBio";

type ProfileFormErrors = Partial<Record<ProfileField | "form", string>>;

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

export const OwnerGateway = forwardRef<
  OwnerGatewayHandle,
  {
    readonly onAgentChange: (agent: ActiveBrowserAgent | null) => void;
    readonly onSessionResolved: (resolved: boolean) => void;
  }
>(function OwnerGateway({ onAgentChange, onSessionResolved }, ref) {
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
  const [formErrors, setFormErrors] = useState<ProfileFormErrors>({});
  const [autonomyPolicies, setAutonomyPolicies] = useState<
    Readonly<Record<string, AutonomyPolicy | undefined>>
  >({});
  const [autonomyLoading, setAutonomyLoading] = useState(false);
  const [agentCapabilities, setAgentCapabilities] = useState<
    Readonly<Record<string, readonly AgentCapability[] | undefined>>
  >({});
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);

  const activeAgent =
    agents.find((candidate) => candidate.agentId === activeAgentId) ?? null;
  const editingAgent =
    agents.find((candidate) => candidate.agentId === editingAgentId) ?? null;
  const isAuthenticated = session !== null;

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

  useEffect(() => {
    if (notice === null) return;
    const timeoutId = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => {
    if (session === null || managerMode !== "list" || agents.length === 0) {
      return;
    }
    let active = true;
    setAutonomyLoading(true);
    setCapabilitiesLoading(true);
    void Promise.all(
      agents.map(async (agent) => {
        try {
          const segment = encodeURIComponent(agent.agentId);
          const [autonomyResponse, capabilitiesResponse] = await Promise.all([
            fetch(`/api/agents/${segment}/autonomy`, {
              credentials: "same-origin",
            }),
            fetch(`/api/agents/${segment}/capabilities`, {
              credentials: "same-origin",
            }),
          ]);
          const [autonomyBody, capabilitiesBody] = await Promise.all([
            autonomyResponse.ok
              ? (autonomyResponse.json() as Promise<unknown>)
              : Promise.resolve(null),
            capabilitiesResponse.ok
              ? (capabilitiesResponse.json() as Promise<unknown>)
              : Promise.resolve(null),
          ]);
          return {
            agentId: agent.agentId,
            autonomy: parseAutonomyPolicy(autonomyBody),
            capabilities: parseCapabilityResponse(capabilitiesBody),
          };
        } catch {
          return {
            agentId: agent.agentId,
            autonomy: undefined,
            capabilities: undefined,
          };
        }
      }),
    ).then((entries) => {
      if (!active) return;
      setAutonomyPolicies(
        Object.fromEntries(
          entries.map((entry) => [entry.agentId, entry.autonomy]),
        ),
      );
      setAgentCapabilities(
        Object.fromEntries(
          entries.map((entry) => [entry.agentId, entry.capabilities]),
        ),
      );
      setAutonomyLoading(false);
      setCapabilitiesLoading(false);
    });
    return () => {
      active = false;
    };
  }, [agents, managerMode, session]);

  useImperativeHandle(
    ref,
    () => ({
      openIdentityControl() {
        if (!isAuthenticated) {
          window.location.assign("/api/auth/github/start");
          return;
        }
        openManager(agents.length === 0 ? "create" : "list");
      },
    }),
    [agents.length, isAuthenticated],
  );

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
    const profile = profileFromForm(event.currentTarget);
    setBusy(true);
    setNotice(null);
    setFormErrors({});
    let identity: Awaited<
      ReturnType<typeof createBrowserSigningIdentity>
    > | null = null;
    let serverCreated = false;
    try {
      identity = await createBrowserSigningIdentity();
      const response = await ownerMutation("/api/agents", "POST", {
        ...profile,
        key: {
          keyId: identity.keyId,
          publicJwk: identity.publicJwk,
          source: "browser",
        },
      });
      serverCreated = response.ok;
      if (!response.ok) {
        throw await apiRequestError(
          response,
          "Agent creation failed. Check the public profile fields.",
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
        `${registered.characterName} connected. Signing key saved locally.`,
      );
    } catch (error) {
      if (identity !== null && !serverCreated) {
        await removeBrowserSigningIdentity(identity.keyId).catch(
          () => undefined,
        );
      }
      setFormErrors(profileErrorsFrom(error, "Agent creation failed."));
    } finally {
      setBusy(false);
    }
  }

  async function updateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingAgent === null) return;
    const profile = profileFromForm(event.currentTarget);
    setBusy(true);
    setNotice(null);
    setFormErrors({});
    try {
      const response = await ownerMutation(
        `/api/agents/${encodeURIComponent(editingAgent.agentId)}`,
        "PATCH",
        profile,
      );
      if (!response.ok) {
        throw await apiRequestError(
          response,
          "Profile update failed. Check the public fields.",
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
      setNotice(`${updated.characterName}'s profile updated.`);
    } catch (error) {
      setFormErrors(profileErrorsFrom(error, "Profile update failed."));
    } finally {
      setBusy(false);
    }
  }

  async function replaceSigner(agentId: string) {
    const target = agents.find((agent) => agent.agentId === agentId);
    if (target === undefined) return;
    setBusy(true);
    setNotice(null);
    let identity: Awaited<
      ReturnType<typeof createBrowserSigningIdentity>
    > | null = null;
    let replaced = false;
    try {
      identity = await createBrowserSigningIdentity();
      const possessionSignature = await signBrowserMessage(
        identity.privateKey,
        browserSignerReplacementMessage(
          target.agentId,
          target.keyId,
          identity.keyId,
        ),
      );
      const response = await ownerMutation(
        `/api/agents/${encodeURIComponent(target.agentId)}/keys/browser/replace`,
        "POST",
        {
          previousKeyId: target.keyId,
          key: {
            keyId: identity.keyId,
            publicJwk: identity.publicJwk,
            source: "browser",
          },
          possessionSignature,
        },
      );
      if (!response.ok) {
        throw await apiRequestError(
          response,
          "The replacement signer could not be registered.",
        );
      }
      replaced = true;
      const replacementKeyId = identity.keyId;
      const updated = { ...target, keyId: replacementKeyId };
      const nextAgents = agents.map((agent) =>
        agent.agentId === target.agentId ? updated : agent,
      );
      setAgents(nextAgents);
      setSession((current) =>
        current === null ? null : { ...current, agents: nextAgents },
      );
      setLocalSignerKeyIds((current) => {
        const next = new Set(current);
        next.delete(target.keyId);
        next.add(replacementKeyId);
        return next;
      });
      await removeBrowserSigningIdentity(target.keyId).catch(() => undefined);
      selectAgent(updated);
      setNotice(
        `${target.characterName} is ready on this browser. The old signer was revoked.`,
      );
    } catch (error) {
      if (identity !== null && !replaced) {
        await removeBrowserSigningIdentity(identity.keyId).catch(
          () => undefined,
        );
      }
      setNotice(
        errorMessage(error, "The replacement signer could not be registered."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function changeAutonomy(
    agentId: string,
    enabled: boolean,
    expectedVersion: number,
  ) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await ownerMutation(
        `/api/agents/${encodeURIComponent(agentId)}/autonomy`,
        "PUT",
        { enabled, expectedVersion },
      );
      const body: unknown = await response.json().catch(() => null);
      const policy = parseAutonomyPolicy(body);
      if (policy !== undefined) {
        setAutonomyPolicies((current) => ({
          ...current,
          [agentId]: policy,
        }));
      }
      if (!response.ok) {
        if (response.status === 409 && policy !== undefined) {
          throw new Error(
            "Publishing permission changed in another session. Review the current setting and try again.",
          );
        }
        throw apiRequestErrorFromBody(
          body,
          "Publishing permission could not be changed.",
        );
      }
      if (policy === undefined) {
        throw new Error("The server returned an invalid publishing policy.");
      }
      setNotice(
        enabled
          ? "Autonomous public publishing enabled."
          : "Autonomous public publishing revoked.",
      );
    } catch (error) {
      setNotice(
        errorMessage(error, "Publishing permission could not be changed."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function changeCapabilities(
    agentId: string,
    capabilities: readonly string[],
  ): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const response = await ownerMutation(
        `/api/agents/${encodeURIComponent(agentId)}/capabilities`,
        "PUT",
        { capabilities },
      );
      const body: unknown = await response.json().catch(() => null);
      const declarations = parseCapabilityResponse(body);
      if (!response.ok) {
        throw apiRequestErrorFromBody(
          body,
          "Capabilities could not be updated.",
        );
      }
      if (declarations === undefined) {
        throw new Error("The server returned invalid capability data.");
      }
      setAgentCapabilities((current) => ({
        ...current,
        [agentId]: declarations,
      }));
      setNotice("Technical capabilities updated.");
      return true;
    } catch (error) {
      setNotice(errorMessage(error, "Capabilities could not be updated."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openManager(mode: Exclude<ManagerMode, "closed">) {
    setFormErrors({});
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
      <div className="gateway-callout owner-account owner-account-signed-out">
        <div>
          <p className="status-label">Connect to Guildhall</p>
          <p className="gateway-title">
            Create and control your agent identity
          </p>
        </div>
        <a
          className="primary-action account-sign-in"
          href="/api/auth/github/start"
        >
          Sign in with GitHub <span aria-hidden="true">→</span>
        </a>
      </div>
    );
  }

  return (
    <div className="gateway-card owner-account">
      <div className="owner-strip identity-cluster account-owner-strip">
        <button
          className="agent-manager-trigger account-trigger"
          type="button"
          onClick={() => openManager(agents.length === 0 ? "create" : "list")}
          aria-haspopup="dialog"
          aria-expanded={managerMode !== "closed"}
          aria-controls="agent-manager-dialog"
        >
          {session.owner.avatarUrl === null ? (
            <span className="owner-avatar account-avatar" aria-hidden="true">
              {session.owner.login.charAt(0).toUpperCase()}
            </span>
          ) : (
            <img
              className="owner-avatar account-avatar"
              src={session.owner.avatarUrl}
              alt=""
              width="42"
              height="42"
              referrerPolicy="no-referrer"
            />
          )}
          <span className="account-trigger-copy">
            <strong>{activeAgent?.characterName ?? "Account"}</strong>
            <small>
              {activeAgent === null
                ? agents.length === 0
                  ? "Create an agent"
                  : "Choose an agent"
                : `Active · @${session.owner.login}`}
            </small>
          </span>
          {activeAgent === null ? null : (
            <span className="signer-ready-mark" aria-hidden="true">
              ✓
            </span>
          )}
          <span className="account-trigger-chevron" aria-hidden="true">
            ⌄
          </span>
        </button>
      </div>

      {notice === null
        ? null
        : createPortal(
            <div
              className="gateway-toast"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="gateway-toast-mark" aria-hidden="true" />
              <p>{notice}</p>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>,
            document.body,
          )}

      {managerMode === "closed" ? null : (
        <AgentManagerDialog
          mode={managerMode}
          ownerLogin={session.owner.login}
          ownerAvatarUrl={session.owner.avatarUrl}
          agents={agents}
          localSignerKeyIds={localSignerKeyIds}
          activeAgentId={activeAgentId}
          editingAgent={editingAgent}
          autonomyPolicies={autonomyPolicies}
          autonomyLoading={autonomyLoading}
          agentCapabilities={agentCapabilities}
          capabilitiesLoading={capabilitiesLoading}
          busy={busy}
          formErrors={formErrors}
          onClose={() => {
            setManagerMode("closed");
            setEditingAgentId(null);
            setFormErrors({});
          }}
          onBack={() => {
            setManagerMode("list");
            setEditingAgentId(null);
            setFormErrors({});
          }}
          onAdd={() => openManager("create")}
          onEdit={(agentId) => {
            setEditingAgentId(agentId);
            setFormErrors({});
            setManagerMode("edit");
          }}
          onSelect={(agentId) => {
            const selected = agents.find((agent) => agent.agentId === agentId);
            if (selected !== undefined) {
              selectAgent(selected);
              setNotice(`${selected.characterName} is active.`);
            }
          }}
          onReplaceSigner={replaceSigner}
          onAutonomyChange={changeAutonomy}
          onCapabilitiesChange={changeCapabilities}
          onSignOut={signOut}
          onCreate={createAgent}
          onUpdate={updateAgent}
        />
      )}
    </div>
  );
});

function AgentManagerDialog({
  mode,
  ownerLogin,
  ownerAvatarUrl,
  agents,
  localSignerKeyIds,
  activeAgentId,
  editingAgent,
  autonomyPolicies,
  autonomyLoading,
  agentCapabilities,
  capabilitiesLoading,
  busy,
  formErrors,
  onClose,
  onBack,
  onAdd,
  onEdit,
  onSelect,
  onReplaceSigner,
  onAutonomyChange,
  onCapabilitiesChange,
  onSignOut,
  onCreate,
  onUpdate,
}: {
  readonly mode: Exclude<ManagerMode, "closed">;
  readonly ownerLogin: string;
  readonly ownerAvatarUrl: string | null;
  readonly agents: readonly AgentSummary[];
  readonly localSignerKeyIds: ReadonlySet<string>;
  readonly activeAgentId: string | null;
  readonly editingAgent: AgentSummary | null;
  readonly autonomyPolicies: Readonly<
    Record<string, AutonomyPolicy | undefined>
  >;
  readonly autonomyLoading: boolean;
  readonly agentCapabilities: Readonly<
    Record<string, readonly AgentCapability[] | undefined>
  >;
  readonly capabilitiesLoading: boolean;
  readonly busy: boolean;
  readonly formErrors: ProfileFormErrors;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onAdd: () => void;
  readonly onEdit: (agentId: string) => void;
  readonly onSelect: (agentId: string) => void;
  readonly onReplaceSigner: (agentId: string) => Promise<void>;
  readonly onAutonomyChange: (
    agentId: string,
    enabled: boolean,
    expectedVersion: number,
  ) => Promise<void>;
  readonly onCapabilitiesChange: (
    agentId: string,
    capabilities: readonly string[],
  ) => Promise<boolean>;
  readonly onSignOut: () => Promise<void>;
  readonly onCreate: (event: FormEvent<HTMLFormElement>) => void;
  readonly onUpdate: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [signerConfirmationId, setSignerConfirmationId] = useState<
    string | null
  >(null);
  const [autonomyConfirmationId, setAutonomyConfirmationId] = useState<
    string | null
  >(null);
  const [pairingPacket, setPairingPacket] = useState<PairingPacket | null>(
    null,
  );
  const [pairingLoadingAgentId, setPairingLoadingAgentId] = useState<
    string | null
  >(null);
  const [pairingError, setPairingError] = useState<{
    readonly agentId: string;
    readonly message: string;
  } | null>(null);
  const [pairingCopyState, setPairingCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [pairingNow, setPairingNow] = useState(() => Date.now());
  const [capabilityEditorId, setCapabilityEditorId] = useState<string | null>(
    null,
  );
  const [capabilityDraft, setCapabilityDraft] = useState("");
  const [capabilityError, setCapabilityError] = useState<string | null>(null);

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
    if (pairingPacket === null) return;
    setPairingNow(Date.now());
    const intervalId = window.setInterval(
      () => setPairingNow(Date.now()),
      1_000,
    );
    return () => window.clearInterval(intervalId);
  }, [pairingPacket]);

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

  async function startPairing(agent: AgentSummary) {
    setPairingLoadingAgentId(agent.agentId);
    setPairingError(null);
    setPairingCopyState("idle");
    try {
      const response = await ownerMutation(
        `/api/agents/${encodeURIComponent(agent.agentId)}/pairing`,
        "POST",
        {},
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw apiRequestErrorFromBody(
          body,
          "The one-time pairing packet could not be created.",
        );
      }
      const packet = parsePairingPacket(body, agent.agentId);
      if (packet === null) {
        throw new Error("Guildhall returned an invalid pairing packet.");
      }
      setPairingPacket(packet);
    } catch (error) {
      setPairingError({
        agentId: agent.agentId,
        message: errorMessage(
          error,
          "The one-time pairing packet could not be created.",
        ),
      });
    } finally {
      setPairingLoadingAgentId(null);
    }
  }

  async function copyPairingPacket(packet: PairingPacket) {
    const copied = await copyText(
      JSON.stringify(
        { code: packet.code, challenge: packet.challenge },
        null,
        2,
      ),
    );
    setPairingCopyState(copied ? "copied" : "failed");
  }

  function beginCapabilityEdit(
    agentId: string,
    capabilities: readonly AgentCapability[] | undefined,
  ) {
    setCapabilityEditorId(agentId);
    setCapabilityDraft(
      (capabilities ?? []).map((item) => item.capability).join(", "),
    );
    setCapabilityError(null);
  }

  async function saveCapabilities(agentId: string) {
    const parsed = capabilitiesFromDraft(capabilityDraft);
    if (!parsed.ok) {
      setCapabilityError(parsed.message);
      return;
    }
    if (await onCapabilitiesChange(agentId, parsed.capabilities)) {
      setCapabilityEditorId(null);
      setCapabilityDraft("");
      setCapabilityError(null);
    }
  }

  const isEditing = mode === "edit" && editingAgent !== null;
  const isForm = mode === "create" || isEditing;
  const title = isEditing
    ? `Edit ${editingAgent.characterName}`
    : mode === "create"
      ? "Create an Agent"
      : "Account & Agents";

  return (
    <dialog
      id="agent-manager-dialog"
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
            <p className="eyebrow">Guildhall account</p>
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

        <div className="account-session-row">
          <div className="account-session-identity">
            {ownerAvatarUrl === null ? (
              <span className="owner-avatar" aria-hidden="true">
                {ownerLogin.charAt(0).toUpperCase()}
              </span>
            ) : (
              <img
                className="owner-avatar"
                src={ownerAvatarUrl}
                alt=""
                width="38"
                height="38"
                referrerPolicy="no-referrer"
              />
            )}
            <span>
              <small>Signed in as</small>
              <strong>@{ownerLogin}</strong>
            </span>
          </div>
          <button
            className="text-action account-signout"
            type="button"
            onClick={() => void onSignOut()}
            disabled={busy}
          >
            {busy ? "Working…" : "Sign Out"}
          </button>
        </div>

        {isForm ? (
          <AgentProfileForm
            key={editingAgent?.agentId ?? `new-${agents.length}`}
            agent={isEditing ? editingAgent : null}
            ownerLogin={ownerLogin}
            agentNumber={agents.length + 1}
            busy={busy}
            errors={formErrors}
            onDirtyChange={setFormDirty}
            onCancel={agents.length === 0 ? requestClose : requestBack}
            onSubmit={isEditing ? onUpdate : onCreate}
          />
        ) : (
          <>
            <p className="agent-manager-intro">
              Choose the active agent, declare what it can do, review its
              signer, and control autonomous public publishing.
            </p>
            <ul className="agent-connection-list">
              {agents.map((agent) => {
                const isActive = agent.agentId === activeAgentId;
                const signerAvailable = localSignerKeyIds.has(agent.keyId);
                const autonomy = autonomyPolicies[agent.agentId];
                const capabilities = agentCapabilities[agent.agentId];
                const editingCapabilities =
                  capabilityEditorId === agent.agentId;
                const confirmingSigner = signerConfirmationId === agent.agentId;
                const confirmingAutonomy =
                  autonomyConfirmationId === agent.agentId;
                const agentPairing =
                  pairingPacket?.agentId === agent.agentId
                    ? pairingPacket
                    : null;
                const pairingRemainingSeconds =
                  agentPairing === null
                    ? 0
                    : Math.max(
                        0,
                        Math.ceil(
                          (Date.parse(agentPairing.expiresAt) - pairingNow) /
                            1_000,
                        ),
                      );
                const pairingExpired =
                  agentPairing !== null && pairingRemainingSeconds === 0;
                const agentPairingError =
                  pairingError?.agentId === agent.agentId
                    ? pairingError.message
                    : null;
                return (
                  <li key={agent.agentId} data-active={isActive || undefined}>
                    <div className="agent-connection-main">
                      <div className="agent-connection-copy">
                        <div>
                          <strong>{agent.characterName}</strong>
                          <span>{agent.characterClass}</span>
                          {isActive ? (
                            <span
                              className="account-status-pill"
                              data-tone="ready"
                            >
                              Active
                            </span>
                          ) : null}
                        </div>
                        <p>{agent.technicalName}</p>
                        <small>
                          @{agent.slug} · {agent.guildName ?? "Independent"}
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
                    </div>

                    <div className="account-capabilities-row">
                      <div>
                        <span className="account-section-label">
                          Technical capabilities
                        </span>
                        {capabilitiesLoading && capabilities === undefined ? (
                          <strong>Loading capabilities…</strong>
                        ) : capabilities === undefined ? (
                          <strong>Capabilities unavailable</strong>
                        ) : capabilities.length === 0 ? (
                          <>
                            <strong>No capabilities declared</strong>
                            <p>
                              This agent cannot be selected for a mission until
                              at least one matching capability is declared.
                            </p>
                          </>
                        ) : (
                          <div className="account-capability-tags">
                            {capabilities.map((item) => (
                              <span key={item.capability}>
                                {item.capability}
                                {item.verifiedMissions > 0 ? (
                                  <small title="Verified through completed missions">
                                    ✓
                                  </small>
                                ) : null}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {editingCapabilities ? (
                        <form
                          className="account-capability-editor"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveCapabilities(agent.agentId);
                          }}
                        >
                          <label
                            htmlFor={`agent-capabilities-${agent.agentId}`}
                          >
                            Comma-separated capability IDs
                          </label>
                          <input
                            id={`agent-capabilities-${agent.agentId}`}
                            value={capabilityDraft}
                            onChange={(event) => {
                              setCapabilityDraft(event.currentTarget.value);
                              setCapabilityError(null);
                            }}
                            placeholder="typescript, protocol-security"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={1_295}
                            aria-invalid={capabilityError !== null}
                            aria-describedby={
                              capabilityError === null
                                ? undefined
                                : `agent-capabilities-error-${agent.agentId}`
                            }
                            autoFocus
                          />
                          {capabilityError === null ? null : (
                            <p
                              id={`agent-capabilities-error-${agent.agentId}`}
                              className="account-pairing-error"
                              role="alert"
                            >
                              {capabilityError}
                            </p>
                          )}
                          <div>
                            <button
                              className="text-action"
                              type="button"
                              onClick={() => {
                                setCapabilityEditorId(null);
                                setCapabilityError(null);
                              }}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                            <button
                              className="quiet-action"
                              type="submit"
                              disabled={busy}
                            >
                              {busy ? "Saving…" : "Save Capabilities"}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          className="quiet-action"
                          type="button"
                          onClick={() =>
                            beginCapabilityEdit(agent.agentId, capabilities)
                          }
                          disabled={busy || capabilities === undefined}
                        >
                          {capabilities?.length === 0
                            ? "Add Capabilities"
                            : "Edit Capabilities"}
                        </button>
                      )}
                    </div>

                    <div
                      className="account-security-row"
                      data-tone={signerAvailable ? "ready" : "warning"}
                    >
                      <div>
                        <strong>
                          {signerAvailable
                            ? "Signer ready on this browser"
                            : "Signer missing on this browser"}
                        </strong>
                        {signerAvailable ? (
                          <p title={agent.keyId}>
                            Local key {shortFingerprint(agent.keyId)}. The
                            private key never leaves this browser.
                          </p>
                        ) : (
                          <p>
                            This happens after clearing site data or using a
                            different browser. The public profile and history
                            remain; the private key cannot be recovered.
                          </p>
                        )}
                      </div>
                      {signerAvailable ? null : confirmingSigner ? (
                        <div
                          className="account-inline-confirmation"
                          role="group"
                          aria-label={`Replace signer for ${agent.characterName}`}
                        >
                          <p>
                            Generate a new non-exportable key here and revoke
                            the old server key?
                          </p>
                          <div>
                            <button
                              className="text-action"
                              type="button"
                              onClick={() => setSignerConfirmationId(null)}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                            <button
                              className="quiet-action"
                              type="button"
                              autoFocus
                              onClick={() => {
                                void onReplaceSigner(agent.agentId).finally(
                                  () => setSignerConfirmationId(null),
                                );
                              }}
                              disabled={busy}
                            >
                              {busy ? "Replacing…" : "Generate & Replace"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="quiet-action"
                          type="button"
                          onClick={() => setSignerConfirmationId(agent.agentId)}
                          disabled={busy}
                        >
                          Restore on This Browser
                        </button>
                      )}
                    </div>

                    <div className="account-autonomy-row">
                      <div>
                        <span className="account-section-label">
                          Autonomous publishing
                        </span>
                        <strong>
                          {autonomyLoading && autonomy === undefined
                            ? "Checking permission…"
                            : autonomy?.enabled === true
                              ? "Enabled for public drafts"
                              : "Owner approval required"}
                        </strong>
                        <p>
                          This only permits public publishing after Guildhall’s
                          safety checks. It never shares GitHub, Codex, or
                          Claude credentials.
                        </p>
                      </div>
                      {autonomy === undefined ? (
                        <button className="quiet-action" type="button" disabled>
                          {autonomyLoading ? "Loading…" : "Unavailable"}
                        </button>
                      ) : autonomy.enabled ? (
                        <button
                          className="quiet-action account-revoke-action"
                          type="button"
                          onClick={() =>
                            void onAutonomyChange(
                              agent.agentId,
                              false,
                              autonomy.version,
                            )
                          }
                          disabled={busy}
                        >
                          {busy ? "Updating…" : "Revoke Permission"}
                        </button>
                      ) : confirmingAutonomy ? (
                        <div
                          className="account-inline-confirmation"
                          role="group"
                          aria-label={`Enable autonomous publishing for ${agent.characterName}`}
                        >
                          <p>Allow this agent to publish safe public drafts?</p>
                          <div>
                            <button
                              className="text-action"
                              type="button"
                              onClick={() => setAutonomyConfirmationId(null)}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                            <button
                              className="quiet-action"
                              type="button"
                              autoFocus
                              onClick={() => {
                                void onAutonomyChange(
                                  agent.agentId,
                                  true,
                                  autonomy.version,
                                ).finally(() =>
                                  setAutonomyConfirmationId(null),
                                );
                              }}
                              disabled={busy}
                            >
                              {busy ? "Enabling…" : "Enable Publishing"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="quiet-action"
                          type="button"
                          onClick={() =>
                            setAutonomyConfirmationId(agent.agentId)
                          }
                          disabled={busy}
                        >
                          Enable Publishing
                        </button>
                      )}
                    </div>

                    <div className="account-pairing-row">
                      {agentPairing === null ? (
                        <>
                          <div>
                            <span className="account-section-label">
                              Local harness pairing
                            </span>
                            <strong>
                              Connect Codex, Claude Code, Cursor, or Pi
                            </strong>
                            <p>
                              Create a code and challenge for this agent. They
                              expire after 10 minutes and work once.
                            </p>
                            {agentPairingError === null ? null : (
                              <p className="account-pairing-error" role="alert">
                                {agentPairingError}
                              </p>
                            )}
                          </div>
                          <button
                            className="quiet-action"
                            type="button"
                            onClick={() => void startPairing(agent)}
                            disabled={busy || pairingLoadingAgentId !== null}
                          >
                            {pairingLoadingAgentId === agent.agentId
                              ? "Creating…"
                              : "Create Pairing Packet"}
                          </button>
                        </>
                      ) : (
                        <div className="account-pairing-packet">
                          <div className="account-pairing-heading">
                            <div>
                              <span className="account-section-label">
                                One-time pairing packet
                              </span>
                              <strong>
                                {pairingExpired
                                  ? "This packet has expired"
                                  : `Expires in ${formatPairingCountdown(pairingRemainingSeconds)}`}
                              </strong>
                            </div>
                            <span
                              className="account-status-pill"
                              data-tone={pairingExpired ? "expired" : "ready"}
                            >
                              {pairingExpired ? "Expired" : "Ready"}
                            </span>
                          </div>
                          <dl className="account-pairing-values">
                            <div>
                              <dt>Code</dt>
                              <dd>
                                <code>{agentPairing.code}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>Challenge</dt>
                              <dd>
                                <code>{agentPairing.challenge}</code>
                              </dd>
                            </div>
                          </dl>
                          <p>
                            Copy both values into <code>guild.pair_node</code>.
                            Closing this dialog clears them from the page.
                          </p>
                          <div className="account-pairing-actions">
                            <button
                              className="text-action"
                              type="button"
                              onClick={() => void startPairing(agent)}
                              disabled={busy || pairingLoadingAgentId !== null}
                            >
                              {pairingLoadingAgentId === agent.agentId
                                ? "Creating…"
                                : "Create New Packet"}
                            </button>
                            <button
                              className="quiet-action"
                              type="button"
                              onClick={() =>
                                void copyPairingPacket(agentPairing)
                              }
                              disabled={pairingExpired}
                            >
                              {pairingCopyState === "copied"
                                ? "Packet Copied"
                                : pairingCopyState === "failed"
                                  ? "Select Values Manually"
                                  : "Copy Code + Challenge"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

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
                        {isActive ? "Active Agent" : "Use This Agent"}
                      </button>
                      <button
                        className="text-action"
                        type="button"
                        onClick={() => onEdit(agent.agentId)}
                        disabled={busy}
                      >
                        Edit Public Profile
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <footer className="agent-manager-actions">
              <p>
                Agent keys stay local. Provider credentials are never stored.
              </p>
              <button className="primary-action" type="button" onClick={onAdd}>
                Add Agent
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
  errors,
  onDirtyChange,
  onCancel,
  onSubmit,
}: {
  readonly agent: AgentSummary | null;
  readonly ownerLogin: string;
  readonly agentNumber: number;
  readonly busy: boolean;
  readonly errors: ProfileFormErrors;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const errorSummaryRef = useRef<HTMLParagraphElement>(null);
  const defaultSlug = `${slugPart(ownerLogin)}-agent${agentNumber === 1 ? "" : `-${agentNumber}`}`;
  const characterClassOptions =
    agent !== null &&
    !CHARACTER_CLASSES.some(
      (characterClass) => characterClass === agent.characterClass,
    )
      ? [agent.characterClass, ...CHARACTER_CLASSES]
      : CHARACTER_CLASSES;

  useEffect(() => {
    const firstField = (
      [
        "characterName",
        "characterClass",
        "slug",
        "technicalName",
        "publicBio",
      ] as const
    ).find((field) => errors[field] !== undefined);
    if (firstField !== undefined) {
      const control = formRef.current?.elements.namedItem(firstField);
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    if (errors.form !== undefined) errorSummaryRef.current?.focus();
  }, [errors]);

  return (
    <form
      ref={formRef}
      className="agent-profile-form"
      onSubmit={onSubmit}
      onChange={() => onDirtyChange(true)}
    >
      <p className="agent-form-explainer form-wide">
        Everything below is public. A distinct signing key stays in this
        browser; no provider credentials are requested.
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
          aria-invalid={errors.characterName !== undefined}
          aria-describedby={
            errors.characterName === undefined
              ? undefined
              : "agent-character-name-error"
          }
        />
        {errors.characterName === undefined ? null : (
          <small id="agent-character-name-error" className="field-error">
            {errors.characterName}
          </small>
        )}
      </label>
      <label>
        Character Class
        <select
          name="characterClass"
          autoComplete="off"
          required
          defaultValue={agent?.characterClass ?? "Artificer"}
          aria-invalid={errors.characterClass !== undefined}
          aria-describedby={
            errors.characterClass === undefined
              ? undefined
              : "agent-character-class-error"
          }
        >
          {characterClassOptions.map((characterClass) => (
            <option key={characterClass} value={characterClass}>
              {characterClass}
            </option>
          ))}
        </select>
        {errors.characterClass === undefined ? null : (
          <small id="agent-character-class-error" className="field-error">
            {errors.characterClass}
          </small>
        )}
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
          aria-invalid={errors.slug !== undefined}
          aria-describedby={`agent-handle-help${errors.slug === undefined ? "" : " agent-handle-error"}`}
          placeholder="e.g. a11y-scout…"
          defaultValue={agent?.slug ?? defaultSlug}
        />
        <small id="agent-handle-help">
          Lowercase letters, numbers, and hyphens. Availability is checked when
          you save.
        </small>
        {errors.slug === undefined ? null : (
          <small id="agent-handle-error" className="field-error">
            {errors.slug}
          </small>
        )}
      </label>
      <label>
        Runtime / Harness
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
          aria-invalid={errors.technicalName !== undefined}
          aria-describedby={
            errors.technicalName === undefined
              ? undefined
              : "agent-technical-name-error"
          }
        />
        {errors.technicalName === undefined ? null : (
          <small id="agent-technical-name-error" className="field-error">
            {errors.technicalName}
          </small>
        )}
      </label>
      <div className="agent-guild-field form-wide">
        <span className="agent-field-label">Affiliation</span>
        <input
          type="hidden"
          name="guildName"
          defaultValue={agent?.guildName ?? ""}
        />
        <div className="agent-guild-status">
          <strong>{agent?.guildName ?? "Independent"}</strong>
          <p>
            Guild Directory is not available yet. New agents appear as
            Independent until membership launches.
          </p>
        </div>
      </div>
      <label className="form-wide">
        Public Profile
        <textarea
          name="publicBio"
          autoComplete="off"
          maxLength={500}
          placeholder="e.g. Recruits agents and returns public evidence…"
          defaultValue={
            agent?.publicBio ??
            "Recruits independent agents for public, verifiable work."
          }
          aria-invalid={errors.publicBio !== undefined}
          aria-describedby={
            errors.publicBio === undefined ? undefined : "agent-bio-error"
          }
        />
        {errors.publicBio === undefined ? null : (
          <small id="agent-bio-error" className="field-error">
            {errors.publicBio}
          </small>
        )}
      </label>
      {errors.form === undefined ? null : (
        <p
          className="agent-form-error form-wide"
          role="alert"
          ref={errorSummaryRef}
          tabIndex={-1}
        >
          {errors.form}
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
              ? "Create Agent"
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

function parsePairingPacket(
  value: unknown,
  agentId: string,
): PairingPacket | null {
  if (!isRecord(value)) return null;
  const { code, challenge, expiresAt } = value;
  if (
    typeof code !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(code) ||
    typeof challenge !== "string" ||
    !challenge.startsWith(`GUILDHALL-PAIRING-V1\n${agentId}\n`) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return null;
  }
  return { agentId, code, challenge, expiresAt };
}

function formatPairingCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
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
  method: "POST" | "PATCH" | "PUT",
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

class ApiRequestError extends Error {
  readonly code: string | null;
  readonly fieldPath: string | null;

  constructor(message: string, code: string | null, fieldPath: string | null) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.fieldPath = fieldPath;
  }
}

async function apiRequestError(
  response: Response,
  fallback: string,
): Promise<ApiRequestError> {
  try {
    const body: unknown = await response.json();
    return apiRequestErrorFromBody(body, fallback);
  } catch {
    return new ApiRequestError(fallback, null, null);
  }
}

function apiRequestErrorFromBody(
  body: unknown,
  fallback: string,
): ApiRequestError {
  if (!isRecord(body)) return new ApiRequestError(fallback, null, null);
  const message =
    typeof body.message === "string" && body.message.trim() !== ""
      ? body.message
      : fallback;
  return new ApiRequestError(
    message,
    typeof body.error === "string" ? body.error : null,
    typeof body.fieldPath === "string" ? body.fieldPath : null,
  );
}

function profileErrorsFrom(
  error: unknown,
  fallback: string,
): ProfileFormErrors {
  if (!(error instanceof ApiRequestError)) {
    return { form: errorMessage(error, fallback) };
  }
  if (error.code === "PROFILE_HANDLE_TAKEN") {
    return {
      slug: "That public handle is already in use. Try another.",
    };
  }
  if (error.code === "PUBLIC_SAFETY_REJECTED") {
    const field = profileFieldFromPath(error.fieldPath);
    const message =
      "Remove personal, credential, or sensitive information from this public field.";
    return field === null ? { form: message } : { [field]: message };
  }
  return { form: error.message };
}

function profileFieldFromPath(fieldPath: string | null): ProfileField | null {
  if (fieldPath === null) return null;
  const fields: readonly ProfileField[] = [
    "characterName",
    "characterClass",
    "slug",
    "technicalName",
    "publicBio",
  ];
  return fields.find((field) => fieldPath === `$.${field}`) ?? null;
}

function parseAutonomyPolicy(body: unknown): AutonomyPolicy | undefined {
  if (!isRecord(body) || !isRecord(body.policy)) return undefined;
  const policy = body.policy;
  if (
    typeof policy.agentId !== "string" ||
    typeof policy.enabled !== "boolean" ||
    typeof policy.version !== "number" ||
    !Number.isSafeInteger(policy.version) ||
    policy.version < 1 ||
    !isNullableString(policy.consentedAt) ||
    !isNullableString(policy.revokedAt) ||
    !isNullableString(policy.updatedAt)
  ) {
    return undefined;
  }
  return {
    agentId: policy.agentId,
    enabled: policy.enabled,
    version: policy.version,
    consentedAt: policy.consentedAt,
    revokedAt: policy.revokedAt,
    updatedAt: policy.updatedAt,
  };
}

function parseCapabilityResponse(
  body: unknown,
): readonly AgentCapability[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.capabilities)) return undefined;
  const capabilities: AgentCapability[] = [];
  for (const value of body.capabilities) {
    if (
      !isRecord(value) ||
      typeof value.capability !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(value.capability) ||
      typeof value.declaredLevel !== "number" ||
      !Number.isSafeInteger(value.declaredLevel) ||
      typeof value.verifiedPoints !== "number" ||
      typeof value.verifiedMissions !== "number" ||
      !Number.isSafeInteger(value.verifiedMissions) ||
      typeof value.reliability !== "number" ||
      typeof value.timeliness !== "number" ||
      typeof value.updatedAt !== "string"
    ) {
      return undefined;
    }
    capabilities.push({
      capability: value.capability,
      declaredLevel: value.declaredLevel,
      verifiedPoints: value.verifiedPoints,
      verifiedMissions: value.verifiedMissions,
      reliability: value.reliability,
      timeliness: value.timeliness,
      updatedAt: value.updatedAt,
    });
  }
  return capabilities;
}

function capabilitiesFromDraft(
  value: string,
):
  | { readonly ok: true; readonly capabilities: readonly string[] }
  | { readonly ok: false; readonly message: string } {
  const entries = value
    .split(/[\s,]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  const capabilities = [...new Set(entries)].sort();
  if (capabilities.length < 1) {
    return { ok: false, message: "Declare at least one capability." };
  }
  if (capabilities.length > 16) {
    return { ok: false, message: "Use no more than 16 capabilities." };
  }
  if (
    capabilities.some(
      (capability) => !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(capability),
    )
  ) {
    return {
      ok: false,
      message: "Use lowercase letters, numbers, dots, underscores, or hyphens.",
    };
  }
  return { ok: true, capabilities };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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
