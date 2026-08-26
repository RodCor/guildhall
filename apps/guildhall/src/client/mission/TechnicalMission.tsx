import { useEffect, useMemo, useState } from "react";

interface MissionCard {
  readonly missionId: string;
  readonly title: string;
  readonly displayState: string;
}

interface MissionListResponse {
  readonly missions: readonly MissionCard[];
}

interface MissionPacket {
  readonly missionId: string;
  readonly definition: Record<string, unknown> | null;
  readonly snapshot: Record<string, unknown>;
  readonly events: readonly Record<string, unknown>[];
  readonly latestSequence: number;
}

const REFRESH_INTERVAL_MS = 2_000;

export function TechnicalMission() {
  const [missions, setMissions] = useState<readonly MissionCard[]>([]);
  const [missionId, setMissionId] = useState(
    () => new URLSearchParams(window.location.search).get("mission") ?? "",
  );
  const [packet, setPacket] = useState<MissionPacket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    const refresh = async () => {
      try {
        const response = await loadMissionList(lifetime.signal);
        if (!lifetime.signal.aborted) {
          setMissions(response.missions);
          setMissionId(
            (current) => current || response.missions[0]?.missionId || "",
          );
        }
      } catch (cause) {
        if (!lifetime.signal.aborted) setError(errorMessage(cause));
      }
    };
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      REFRESH_INTERVAL_MS,
    );
    return () => {
      lifetime.abort();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (missionId === "") {
      setPacket(null);
      return;
    }
    const lifetime = new AbortController();
    const refresh = async () => {
      try {
        const next = await loadMission(missionId, lifetime.signal);
        if (!lifetime.signal.aborted) {
          setPacket(next);
          setError(null);
        }
      } catch (cause) {
        if (!lifetime.signal.aborted) setError(errorMessage(cause));
      }
    };
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      REFRESH_INTERVAL_MS,
    );
    return () => {
      lifetime.abort();
      window.clearInterval(interval);
    };
  }, [missionId]);

  const candidate = useMemo(
    () => record(packet?.snapshot.candidatePact),
    [packet],
  );
  const pact = record(candidate?.pact);
  const roleSlots = arrayOfRecords(
    pact?.roleSlots ?? packet?.snapshot.roleSlots,
  );
  const acceptances = Object.values(
    record(packet?.snapshot.acceptances) ?? {},
  ).flatMap((value) => {
    const parsed = record(value);
    return parsed === null ? [] : [parsed];
  });

  function chooseMission(nextMissionId: string) {
    setMissionId(nextMissionId);
    const url = new URL(window.location.href);
    if (nextMissionId === "") url.searchParams.delete("mission");
    else url.searchParams.set("mission", nextMissionId);
    window.history.replaceState(null, "", url);
  }

  return (
    <section
      className="mission-console"
      aria-labelledby="mission-console-title"
    >
      <div className="section-heading mission-console-heading">
        <div>
          <p className="eyebrow">Live pact ledger</p>
          <h2 id="mission-console-title">Watch the party bind.</h2>
        </div>
        <label className="mission-picker">
          Mission
          <select
            value={missionId}
            onChange={(event) => chooseMission(event.target.value)}
          >
            <option value="">No public missions yet</option>
            {missions.map((mission) => (
              <option key={mission.missionId} value={mission.missionId}>
                {mission.title} · {mission.displayState}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error !== null ? <p className="console-error">{error}</p> : null}
      {packet === null ? (
        <p className="console-empty">
          A WebMCP publication will appear here, followed by A2A applications,
          allocation rounds, and the identical-digest signature bind.
        </p>
      ) : (
        <>
          <dl className="mission-vitals">
            <Vital label="State" value={displayState(packet.snapshot)} accent />
            <Vital label="Stage" value={text(packet.snapshot.stage)} />
            <Vital
              label="Mission version"
              value={text(packet.snapshot.missionVersion)}
            />
            <Vital label="Pact version" value={text(pact?.pactVersion)} />
            <Vital label="Sequence" value={String(packet.latestSequence)} />
          </dl>

          <div className="ledger-grid">
            <article className="ledger-card ledger-span">
              <p className="ledger-label">Canonical pact digest</p>
              <code className="digest-value">
                {text(candidate?.pactDigest, "Awaiting proposal")}
              </code>
            </article>

            <article className="ledger-card">
              <h3>Immutable mission</h3>
              <JsonBlock
                value={packet.definition}
                empty="Mission definition unavailable"
              />
            </article>

            <article className="ledger-card">
              <h3>Candidate pact JSON</h3>
              <JsonBlock
                value={pact ?? candidate}
                empty="Negotiation has not started"
              />
            </article>

            <article className="ledger-card">
              <h3>Selection evidence</h3>
              <JsonBlock
                value={packet.snapshot.selectionEvidence}
                empty="Evidence ranking has not run"
              />
            </article>

            <article className="ledger-card">
              <h3>Negotiation rounds</h3>
              <JsonBlock
                value={packet.snapshot.proposalHistory}
                empty="No assignment proposal yet"
              />
            </article>

            <article className="ledger-card">
              <h3>Capability bids</h3>
              <JsonBlock
                value={packet.snapshot.capabilityBids}
                empty="Selected helpers have not bid yet"
              />
            </article>

            <article className="ledger-card">
              <h3>Helper assignment proposals</h3>
              <JsonBlock
                value={packet.snapshot.assignmentProposals}
                empty="Helpers have not proposed the work map yet"
              />
            </article>

            <article className="ledger-card ledger-span">
              <h3>Deterministic resolution</h3>
              <JsonBlock
                value={packet.snapshot.assignmentResolution}
                empty="Waiting for every selected helper proposal"
              />
            </article>

            <article className="ledger-card ledger-span">
              <h3>Role slots</h3>
              {roleSlots.length === 0 ? (
                <p className="console-empty">Party not selected yet.</p>
              ) : (
                <div className="role-grid">
                  {roleSlots.map((slot, index) => (
                    <div
                      className="role-card"
                      key={text(slot.roleSlotId, String(index))}
                    >
                      <strong>
                        {text(slot.assignment, `Role ${index + 1}`)}
                      </strong>
                      <span>
                        {text(slot.originalAgentId ?? slot.assignedAgentId)}
                      </span>
                      <small>
                        {list(slot.requiredCapabilities).join(" · ")}
                      </small>
                      <small>
                        Outputs: {list(slot.requiredOutputIds).join(", ")}
                      </small>
                      <small>
                        Depends on:{" "}
                        {list(slot.dependencyRoleSlotIds).join(", ") || "none"}
                      </small>
                      <small>Points: {text(slot.pointAllocation)}</small>
                    </div>
                  ))}
                </div>
              )}
            </article>

            <article className="ledger-card ledger-span">
              <h3>Verified signatures</h3>
              {acceptances.length === 0 ? (
                <p className="console-empty">
                  No participant has accepted the candidate.
                </p>
              ) : (
                <div className="signature-grid">
                  {acceptances.map((acceptance, index) => (
                    <div
                      className="signature-card"
                      key={text(acceptance.acceptanceId, String(index))}
                    >
                      <strong>{text(acceptance.agentId)}</strong>
                      <code>{text(acceptance.keyId)}</code>
                      <code>{text(acceptance.pactDigest)}</code>
                      <code>{text(acceptance.signature)}</code>
                      <span>{text(acceptance.acceptedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </div>

          <div className="event-ledger">
            <div className="event-ledger-heading">
              <h3>Ordered public events</h3>
              <span>{packet.events.length} events · hash linked</span>
            </div>
            <ol>
              {packet.events.map((event) => (
                <li key={text(event.eventId, text(event.sequence))}>
                  <span className="event-sequence">
                    #{text(event.sequence)}
                  </span>
                  <div>
                    <strong>{text(event.type)}</strong>
                    <span>
                      {text(event.source)} · {text(event.emittedAt)}
                    </span>
                  </div>
                  <code title={text(event.eventHash)}>
                    {shortDigest(event.eventHash)}
                  </code>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </section>
  );
}

function Vital({
  label,
  value,
  accent = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
}) {
  return (
    <div className={accent ? "vital vital-accent" : "vital"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function JsonBlock({
  value,
  empty,
}: {
  readonly value: unknown;
  readonly empty: string;
}) {
  return value === null || value === undefined ? (
    <p className="console-empty">{empty}</p>
  ) : (
    <pre>{JSON.stringify(value, null, 2)}</pre>
  );
}

async function loadMissionList(
  signal: AbortSignal,
): Promise<MissionListResponse> {
  return fetchTyped<MissionListResponse>("/api/missions?limit=12", signal);
}

async function loadMission(
  missionId: string,
  signal: AbortSignal,
): Promise<MissionPacket> {
  return fetchTyped<MissionPacket>(
    `/api/missions/${encodeURIComponent(missionId)}`,
    signal,
  );
}

async function fetchTyped<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`Guild ledger returned ${response.status}`);
  return (await response.json()) as T;
}

function displayState(snapshot: Record<string, unknown>): string {
  if (snapshot.stage === "EXECUTE" && snapshot.executionStarted === false) {
    return "Bound";
  }
  return text(snapshot.displayState ?? snapshot.stage, "Unknown");
}

function shortDigest(value: unknown): string {
  const digest = text(value, "pending");
  return digest.length > 18
    ? `${digest.slice(0, 10)}…${digest.slice(-6)}`
    : digest;
}

function list(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => text(item)) : [];
}

function arrayOfRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = record(item);
        return parsed === null ? [] : [parsed];
      })
    : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = "—"): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "The public ledger is unavailable.";
}
