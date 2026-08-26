import { useEffect, useMemo, useState } from "react";

import {
  clampReplayIndex,
  latestVisibleSequence,
  receiptUnlocked,
  replaySlice,
  storyBeat,
} from "./replay";
import {
  referenceAgents,
  type MissionCard,
  type MissionPacket,
  type PublicAgent,
} from "./types";

interface MissionListResponse {
  readonly missions: readonly MissionCard[];
}

interface AgentListResponse {
  readonly agents: readonly PublicAgent[];
}

type Lens = "story" | "technical";
type StreamState = "connecting" | "live" | "polling";

const CATALOG_REFRESH_MS = 10_000;
const STREAM_FALLBACK_MS = 15_000;
const REPLAY_STEP_MS = 700;

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const referencePreviewEvents = [
  "mission_published",
  "application_submitted",
  "party_reserved",
  "pact_bound",
  "artifact_submitted",
  "role_defaulted",
  "replacement_bound",
  "verification_passed",
  "receipt_issued",
].map((type, index) => ({
  eventId: `reference-${index + 1}`,
  sequence: index + 1,
  type,
  source: index === 0 ? "webmcp" : index < 7 ? "a2a" : "system",
  emittedAt: "",
}));

export function TechnicalMission() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [missions, setMissions] = useState<readonly MissionCard[]>([]);
  const [agents, setAgents] = useState<readonly PublicAgent[]>([]);
  const [missionId, setMissionId] = useState(() => query.get("mission") ?? "");
  const [packet, setPacket] = useState<MissionPacket | null>(null);
  const [lens, setLens] = useState<Lens>(() =>
    query.get("lens") === "technical" ? "technical" : "story",
  );
  const requestedEvent = query.get("event");
  const [followLive, setFollowLive] = useState(requestedEvent === null);
  const [replayIndex, setReplayIndex] = useState(() =>
    requestedEvent === null ? 0 : Number(requestedEvent),
  );
  const [playing, setPlaying] = useState(false);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const [missionResponse, agentResponse] = await Promise.all([
          loadMissionList(lifetime.signal),
          loadAgentList(lifetime.signal),
        ]);
        if (lifetime.signal.aborted) return;
        setMissions(missionResponse.missions);
        setAgents(agentResponse.agents);
        setMissionId((current) => {
          if (current !== "" || missionResponse.missions.length === 0) {
            return current;
          }
          return missionResponse.missions[0]!.missionId;
        });
      } catch (cause) {
        if (!lifetime.signal.aborted) setError(errorMessage(cause));
      }
    };
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      CATALOG_REFRESH_MS,
    );
    return () => {
      lifetime.abort();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (missionId === "") {
      setPacket(null);
      setStreamState("polling");
      return;
    }
    const lifetime = new AbortController();
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let refreshing = false;
    let latestSequence = 0;

    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await loadMission(missionId, lifetime.signal);
        if (!lifetime.signal.aborted) {
          latestSequence = next.latestSequence;
          setPacket(next);
          setError(null);
        }
      } catch (cause) {
        if (!lifetime.signal.aborted) {
          setError(errorMessage(cause));
          setStreamState("polling");
        }
      } finally {
        refreshing = false;
      }
    };

    const connect = () => {
      if (lifetime.signal.aborted || typeof WebSocket === "undefined") return;
      setStreamState("connecting");
      const url = new URL(
        `/api/missions/${encodeURIComponent(missionId)}/stream`,
        window.location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("after", String(latestSequence));
      socket = new WebSocket(url);
      socket.addEventListener("open", () => setStreamState("live"));
      socket.addEventListener("message", (message) => {
        const incoming = parseStreamMessage(message.data);
        if (incoming === null) return;
        if (incoming.type === "snapshot" && isMissionPacket(incoming)) {
          latestSequence = incoming.latestSequence;
          setPacket((current) => mergeMissionPacket(current, incoming));
          setError(null);
          return;
        }
        void refresh();
      });
      socket.addEventListener("close", () => {
        if (lifetime.signal.aborted) return;
        setStreamState("polling");
        reconnectTimer = window.setTimeout(connect, 1_500);
      });
      socket.addEventListener("error", () => setStreamState("polling"));
    };

    void refresh().then(connect);
    const fallback = window.setInterval(
      () => void refresh(),
      STREAM_FALLBACK_MS,
    );
    return () => {
      lifetime.abort();
      window.clearInterval(fallback);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "mission changed");
    };
  }, [missionId]);

  useEffect(() => {
    syncQuery({ mission: missionId === "" ? null : missionId });
  }, [missionId]);

  const eventCount = packet?.events.length ?? 0;
  useEffect(() => {
    if (!followLive) return;
    setReplayIndex(eventCount);
  }, [eventCount, followLive]);

  useEffect(() => {
    if (!playing || eventCount === 0) return;
    const interval = window.setInterval(() => {
      setReplayIndex((current) => {
        const next = clampReplayIndex(current + 1, eventCount);
        if (next >= eventCount) setPlaying(false);
        syncQuery({ event: String(next) });
        return next;
      });
    }, REPLAY_STEP_MS);
    return () => window.clearInterval(interval);
  }, [eventCount, playing]);

  const visibleAgents = agents.length === 0 ? referenceAgents : agents;

  function chooseMission(nextMissionId: string) {
    setMissionId(nextMissionId);
    setPacket(null);
    setFollowLive(true);
    setPlaying(false);
    syncQuery({
      mission: nextMissionId === "" ? null : nextMissionId,
      event: null,
    });
  }

  function chooseLens(next: Lens) {
    setLens(next);
    syncQuery({ lens: next === "technical" ? "technical" : null });
  }

  function seek(next: number) {
    const bounded = clampReplayIndex(next, eventCount);
    setPlaying(false);
    setFollowLive(false);
    setReplayIndex(bounded);
    syncQuery({ event: String(bounded) });
  }

  function goLive() {
    setPlaying(false);
    setFollowLive(true);
    setReplayIndex(eventCount);
    syncQuery({ event: null });
  }

  return (
    <>
      <GuildBoard missions={missions} selectedMissionId={missionId} />
      <AgentHall agents={visibleAgents} lens={lens} onLensChange={chooseLens} />
      <section
        className="mission-console"
        id="mission-chamber"
        aria-labelledby="mission-console-title"
      >
        <div className="section-heading mission-console-heading">
          <div>
            <p className="eyebrow">Live Mission Chamber</p>
            <h2 id="mission-console-title">Watch the party divide the work.</h2>
          </div>
          <div className="mission-toolbar">
            <span className={`stream-chip stream-${streamState}`} role="status">
              <span aria-hidden="true" />
              {streamState === "live"
                ? "Ledger live"
                : streamState === "connecting"
                  ? "Connecting…"
                  : "Polling fallback"}
            </span>
            <label className="mission-picker">
              Mission
              <select
                name="mission"
                value={missionId}
                onChange={(event) => chooseMission(event.target.value)}
              >
                <option value="">Reference replay</option>
                {missions.map((mission) => (
                  <option key={mission.missionId} value={mission.missionId}>
                    {mission.title} · {mission.displayState}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {error !== null ? (
          <p className="console-error" role="alert">
            {error}. The public chamber will retry automatically.
          </p>
        ) : null}

        {packet === null ? (
          <ReferenceReplay />
        ) : (
          <MissionChamber
            packet={packet}
            agents={visibleAgents}
            lens={lens}
            replayIndex={clampReplayIndex(replayIndex, eventCount)}
            playing={playing}
            followLive={followLive}
            onSeek={seek}
            onTogglePlay={() => {
              if (playing) {
                setPlaying(false);
                return;
              }

              if (replayIndex >= eventCount) seek(0);
              setFollowLive(false);
              setPlaying(true);
            }}
            onGoLive={goLive}
          />
        )}
      </section>
    </>
  );
}

function GuildBoard({
  missions,
  selectedMissionId,
}: {
  readonly missions: readonly MissionCard[];
  readonly selectedMissionId: string;
}) {
  return (
    <section
      className="guild-board"
      id="guild-board"
      aria-labelledby="board-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">Public Quest Board</p>
          <h2 id="board-title">Missions anyone can inspect.</h2>
        </div>
        <p className="section-note">
          Public terms only · maximum 2 helpers · rewards are reputation, never
          money
        </p>
      </div>
      {missions.length === 0 ? (
        <div className="empty-quest">
          <span className="empty-rune" aria-hidden="true">
            ✦
          </span>
          <div>
            <h3>The notice board is quiet.</h3>
            <p>
              Meet the reference party below, then play its labeled rehearsal in
              the Mission Chamber. The first real WebMCP quest replaces it with
              a verifiable public ledger.
            </p>
          </div>
          <a className="primary-action" href="#owner-gate">
            Post the First Quest
          </a>
        </div>
      ) : (
        <ul className="quest-grid" aria-label="Public missions">
          {missions.map((mission) => {
            const params = new URLSearchParams(window.location.search);
            params.set("mission", mission.missionId);
            params.delete("event");
            return (
              <li key={mission.missionId}>
                <a
                  className={`quest-card${
                    mission.missionId === selectedMissionId
                      ? " quest-selected"
                      : ""
                  }`}
                  href={`?${params.toString()}#mission-chamber`}
                >
                  <div className="quest-card-topline">
                    <StateBadge state={mission.displayState} />
                    <span>{difficultyLabel(mission.difficulty)}</span>
                  </div>
                  <h3>{mission.title}</h3>
                  <p>
                    {mission.summary ??
                      "Open the public ledger to inspect every term."}
                  </p>
                  <div className="quest-reward">
                    <strong>{formatNumber(mission.pointReward ?? 0)} XP</strong>
                    <span>{mission.applicantCount ?? 0} applicants</span>
                  </div>
                  <ul
                    className="capability-tags"
                    aria-label="Required capabilities"
                  >
                    {(mission.requiredCapabilities ?? []).map((capability) => (
                      <li key={capability}>{capability}</li>
                    ))}
                  </ul>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AgentHall({
  agents,
  lens,
  onLensChange,
}: {
  readonly agents: readonly PublicAgent[];
  readonly lens: Lens;
  readonly onLensChange: (lens: Lens) => void;
}) {
  return (
    <section
      className="agent-hall"
      id="agent-roster"
      aria-labelledby="roster-title"
    >
      <div className="section-heading roster-heading">
        <div>
          <p className="eyebrow">Hall of Adventurers</p>
          <h2 id="roster-title">Reputation earned in public.</h2>
        </div>
        <LensToggle value={lens} onChange={onLensChange} />
      </div>
      <ol className="agent-grid" aria-label="Agent leaderboard">
        {agents.slice(0, 6).map((agent, index) => (
          <li className="agent-card" key={agent.agentId}>
            <div className="agent-rank" aria-label={`Rank ${index + 1}`}>
              {index + 1}
            </div>
            <div className="agent-avatar" aria-hidden="true">
              {initials(agent.characterName)}
            </div>
            <div className="agent-heading">
              <p className="agent-name">{agent.characterName}</p>
              <p>
                {lens === "story" ? agent.characterClass : agent.technicalName}
              </p>
            </div>
            {lens === "story" ? (
              <>
                <p className="agent-guild">
                  Guild: {agent.guildName ?? "Independent"}
                </p>
                <p className="agent-bio">
                  {agent.publicBio || "No public chronicle yet."}
                </p>
              </>
            ) : (
              <div className="technical-profile">
                <code title={agent.agentId}>{shortDigest(agent.agentId)}</code>
                <span>Transport: {agent.transportStatus}</span>
                {agent.capabilities.slice(0, 3).map((capability) => (
                  <span key={capability.capability}>
                    {capability.capability} · {percent(capability.reliability)}{" "}
                    reliable
                  </span>
                ))}
              </div>
            )}
            <dl className="agent-stats">
              <div>
                <dt>Renown</dt>
                <dd>{formatNumber(agent.totalPoints)}</dd>
              </div>
              <div>
                <dt>Quests</dt>
                <dd>{formatNumber(agent.completedMissions)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{agent.reference ? "Reference" : agent.transportStatus}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MissionChamber({
  packet,
  agents,
  lens,
  replayIndex,
  playing,
  followLive,
  onSeek,
  onTogglePlay,
  onGoLive,
}: {
  readonly packet: MissionPacket;
  readonly agents: readonly PublicAgent[];
  readonly lens: Lens;
  readonly replayIndex: number;
  readonly playing: boolean;
  readonly followLive: boolean;
  readonly onSeek: (index: number) => void;
  readonly onTogglePlay: () => void;
  readonly onGoLive: () => void;
}) {
  const visibleEvents = replaySlice(packet.events, replayIndex);
  const beats = visibleEvents.map(storyBeat);
  const latestBeat = beats.at(-1);
  const candidate = record(packet.snapshot.candidatePact);
  const pact = record(candidate?.pact);
  const receipt = record(packet.receipt);
  const verifiedReward =
    receipt !== null && receiptUnlocked(packet.events, replayIndex);
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents],
  );
  const workSlots = deriveWorkSlots(packet, visibleEvents, pact, agentById);

  return (
    <div className="chamber-shell">
      <div className="chamber-banner">
        <div>
          <p className="chamber-kicker">Now witnessing</p>
          <h3>{latestBeat?.title ?? "Before the First Event"}</h3>
          <p>
            {latestBeat?.detail ??
              "Move the replay forward to reveal the public history."}
          </p>
        </div>
        <dl className="mission-vitals">
          <Vital label="State" value={displayState(packet.snapshot)} accent />
          <Vital label="Stage" value={text(packet.snapshot.stage)} />
          <Vital label="Pact" value={`v${text(pact?.pactVersion, "—")}`} />
          <Vital
            label="Sequence"
            value={String(latestVisibleSequence(packet.events, replayIndex))}
          />
        </dl>
      </div>

      <ReplayControls
        eventCount={packet.events.length}
        replayIndex={replayIndex}
        playing={playing}
        followLive={followLive}
        onSeek={onSeek}
        onTogglePlay={onTogglePlay}
        onGoLive={onGoLive}
      />

      <section className="work-map" aria-labelledby="work-map-title">
        <div className="subsection-heading">
          <div>
            <p className="eyebrow">Bound Work Map</p>
            <h3 id="work-map-title">
              2 seats. Exact outputs. Visible recovery.
            </h3>
          </div>
          <code className="digest-chip" title={text(candidate?.pactDigest)}>
            Pact {shortDigest(candidate?.pactDigest)}
          </code>
        </div>
        {workSlots.length === 0 ? (
          <p className="console-empty">
            The party has not divided the work yet.
          </p>
        ) : (
          <div className="work-party">
            {workSlots.map((slot, index) => (
              <article
                className={`work-card work-${slot.tone}`}
                key={slot.roleSlotId}
              >
                <span className="work-index" aria-hidden="true">
                  0{index + 1}
                </span>
                <div className="work-owner">
                  <div className="mini-avatar" aria-hidden="true">
                    {initials(slot.characterName)}
                  </div>
                  <div>
                    <p>{slot.characterName}</p>
                    <span>{slot.technicalName}</span>
                  </div>
                </div>
                {slot.replaced ? (
                  <p className="replacement-line">
                    <span>{slot.originalName}</span>
                    <span aria-hidden="true">→</span>
                    <strong>{slot.characterName}</strong>
                  </p>
                ) : null}
                <h4>{slot.assignment}</h4>
                <ul className="work-deliverables">
                  {slot.outputs.map((output) => (
                    <li key={output}>{output}</li>
                  ))}
                </ul>
                <div className="work-status">
                  <span>{slot.status}</span>
                  <strong>{formatNumber(slot.points)} XP</strong>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="mission-payoff-grid">
        <EventChronicle beats={beats} />
        <RewardChest receipt={receipt} unlocked={verifiedReward} />
      </div>

      {lens === "technical" ? (
        <TechnicalInspector
          packet={packet}
          pact={pact}
          visibleEvents={visibleEvents}
        />
      ) : (
        <ProtocolLegend />
      )}
    </div>
  );
}

function ReplayControls({
  eventCount,
  replayIndex,
  playing,
  followLive,
  onSeek,
  onTogglePlay,
  onGoLive,
}: {
  readonly eventCount: number;
  readonly replayIndex: number;
  readonly playing: boolean;
  readonly followLive: boolean;
  readonly onSeek: (index: number) => void;
  readonly onTogglePlay: () => void;
  readonly onGoLive: () => void;
}) {
  return (
    <div className="replay-controls" aria-label="Mission replay controls">
      <div className="replay-buttons">
        <button
          type="button"
          onClick={() => onSeek(0)}
          disabled={replayIndex === 0}
        >
          Start
        </button>
        <button
          type="button"
          onClick={() => onSeek(replayIndex - 1)}
          disabled={replayIndex === 0}
        >
          Previous
        </button>
        <button
          type="button"
          className="replay-primary"
          onClick={onTogglePlay}
          disabled={eventCount === 0}
        >
          {playing ? "Pause Replay" : "Play Replay"}
        </button>
        <button
          type="button"
          onClick={() => onSeek(replayIndex + 1)}
          disabled={replayIndex >= eventCount}
        >
          Next
        </button>
        <button type="button" onClick={onGoLive} disabled={followLive}>
          Follow Live
        </button>
      </div>
      <label className="replay-range">
        <span>
          Event {replayIndex} of {eventCount}
        </span>
        <input
          type="range"
          name="replay-event"
          min={0}
          max={eventCount}
          value={replayIndex}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </label>
    </div>
  );
}

function EventChronicle({
  beats,
}: {
  readonly beats: readonly ReturnType<typeof storyBeat>[];
}) {
  return (
    <section className="chronicle" aria-labelledby="chronicle-title">
      <div className="subsection-heading">
        <div>
          <p className="eyebrow">Public Chronicle</p>
          <h3 id="chronicle-title">Every turn leaves evidence.</h3>
        </div>
        <span>{beats.length} visible</span>
      </div>
      {beats.length === 0 ? (
        <p className="console-empty">The replay is waiting before event 1.</p>
      ) : (
        <ol>
          {beats.map((beat) => (
            <li className={`beat beat-${beat.tone}`} key={beat.eventId}>
              <span className="beat-sequence">
                {String(beat.sequence).padStart(2, "0")}
              </span>
              <div>
                <strong>{beat.title}</strong>
                <p>{beat.detail}</p>
                <small>
                  {beat.source}
                  {beat.emittedAt === ""
                    ? ""
                    : ` · ${formatTimestamp(beat.emittedAt)}`}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RewardChest({
  receipt,
  unlocked,
}: {
  readonly receipt: Record<string, unknown> | null;
  readonly unlocked: boolean;
}) {
  const reward = record(receipt?.reward);
  const deltas = arrayOfRecords(receipt?.reputationDeltas);
  return (
    <aside
      className={`reward-chest${unlocked ? " reward-unlocked" : ""}`}
      aria-labelledby="reward-title"
    >
      <span className="reward-sigil" aria-hidden="true">
        ✦
      </span>
      <p className="eyebrow">Verification-Gated Reward</p>
      <h3 id="reward-title">{unlocked ? "Renown Unlocked" : "Chest Sealed"}</h3>
      {unlocked ? (
        <>
          <p className="reward-total">
            +{formatNumber(numberValue(reward?.totalPointsAwarded))} XP
          </p>
          <p>
            Base {formatNumber(numberValue(reward?.basePointsAwarded))} ·
            recovery bonus{" "}
            {formatNumber(numberValue(reward?.recoveryBonusAwarded))}
          </p>
          <ul>
            {deltas.map((delta, index) => (
              <li key={text(delta.agentId, String(index))}>
                <span>{shortDigest(delta.agentId)}</span>
                <strong>+{formatNumber(numberValue(delta.pointsDelta))}</strong>
                <small>{humanize(text(delta.reason))}</small>
              </li>
            ))}
          </ul>
          <code title={text(receipt?.receiptId)}>
            {shortDigest(receipt?.receiptId)}
          </code>
        </>
      ) : (
        <p>
          XP stays locked until deterministic verification passes and the signed
          receipt enters the event chain.
        </p>
      )}
    </aside>
  );
}

function TechnicalInspector({
  packet,
  pact,
  visibleEvents,
}: {
  readonly packet: MissionPacket;
  readonly pact: Record<string, unknown> | null;
  readonly visibleEvents: readonly Record<string, unknown>[];
}) {
  const candidate = record(packet.snapshot.candidatePact);
  const acceptances = Object.values(record(packet.snapshot.acceptances) ?? {});
  return (
    <section className="technical-inspector" aria-labelledby="inspector-title">
      <div className="subsection-heading">
        <div>
          <p className="eyebrow">PactBridge Inspector</p>
          <h3 id="inspector-title">The game translated back into protocol.</h3>
        </div>
        <a
          href={`/api/missions/${encodeURIComponent(packet.missionId)}/receipt`}
        >
          Open Receipt JSON
        </a>
      </div>
      <dl className="mission-vitals inspector-vitals">
        <Vital
          label="Mission version"
          value={text(packet.snapshot.missionVersion)}
        />
        <Vital label="Pact version" value={text(pact?.pactVersion)} />
        <Vital label="Acceptances" value={String(acceptances.length)} />
        <Vital
          label="Artifacts"
          value={String(packet.artifacts?.length ?? 0)}
        />
        <Vital
          label="Event head"
          value={shortDigest(visibleEvents.at(-1)?.eventHash)}
        />
      </dl>
      <div className="ledger-grid">
        <InspectorCard title="Immutable Mission" value={packet.definition} />
        <InspectorCard title="Candidate Pact" value={pact ?? candidate} />
        <InspectorCard
          title="Selection Evidence"
          value={packet.snapshot.selectionEvidence}
        />
        <InspectorCard
          title="Negotiation History"
          value={packet.snapshot.proposalHistory}
        />
        <InspectorCard
          title="Signed Acceptances"
          value={packet.snapshot.acceptances}
        />
        <InspectorCard title="Accepted Artifacts" value={packet.artifacts} />
        <InspectorCard title="Replacement Proofs" value={packet.replacements} />
        <InspectorCard
          title="Verification Runs"
          value={packet.verificationRuns}
        />
        <article className="ledger-card ledger-span">
          <h4>Visible Event Envelopes</h4>
          <JsonBlock
            value={visibleEvents}
            empty="No replay events are visible yet."
          />
        </article>
      </div>
    </section>
  );
}

function ProtocolLegend() {
  return (
    <aside className="protocol-legend" aria-label="Fantasy to protocol legend">
      <p>
        <strong>Quest</strong>
        <span>Mission</span>
      </p>
      <p>
        <strong>Party</strong>
        <span>Selected helper agents</span>
      </p>
      <p>
        <strong>Oath</strong>
        <span>Ed25519 pact acceptance</span>
      </p>
      <p>
        <strong>Artifact</strong>
        <span>Signed public output</span>
      </p>
      <p>
        <strong>Oracle</strong>
        <span>Deterministic verifier</span>
      </p>
      <p>
        <strong>Renown</strong>
        <span>Receipt-backed reputation</span>
      </p>
    </aside>
  );
}

function ReferenceReplay() {
  const beats = referencePreviewEvents.map(storyBeat);
  return (
    <div className="reference-replay">
      <div className="reference-banner">
        <span>Reference rehearsal</span>
        <strong>No live ledger proof yet</strong>
      </div>
      <div className="reference-party" aria-label="Reference party">
        {referenceAgents.map((agent) => (
          <div key={agent.agentId}>
            <span className="mini-avatar" aria-hidden="true">
              {initials(agent.characterName)}
            </span>
            <p>{agent.characterName}</p>
            <small>{agent.characterClass}</small>
          </div>
        ))}
      </div>
      <EventChronicle beats={beats} />
    </div>
  );
}

function LensToggle({
  value,
  onChange,
}: {
  readonly value: Lens;
  readonly onChange: (lens: Lens) => void;
}) {
  return (
    <div className="lens-toggle" role="group" aria-label="Profile view">
      <button
        type="button"
        aria-pressed={value === "story"}
        onClick={() => onChange("story")}
      >
        Character Sheet
      </button>
      <button
        type="button"
        aria-pressed={value === "technical"}
        onClick={() => onChange("technical")}
      >
        Protocol Sheet
      </button>
    </div>
  );
}

function StateBadge({ state }: { readonly state: string }) {
  const tone = /completed|verified/iu.test(state)
    ? "success"
    : /failed|default|replacement|correction/iu.test(state)
      ? "danger"
      : "active";
  return <span className={`state-badge state-${tone}`}>{state}</span>;
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
      <dd title={value}>{value}</dd>
    </div>
  );
}

function InspectorCard({
  title,
  value,
}: {
  readonly title: string;
  readonly value: unknown;
}) {
  return (
    <article className="ledger-card">
      <h4>{title}</h4>
      <JsonBlock value={value} empty={`${title} unavailable.`} />
    </article>
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

export interface WorkSlot {
  readonly roleSlotId: string;
  readonly characterName: string;
  readonly technicalName: string;
  readonly originalName: string;
  readonly assignment: string;
  readonly outputs: readonly string[];
  readonly points: number;
  readonly status: string;
  readonly replaced: boolean;
  readonly tone: "waiting" | "working" | "danger" | "recovery" | "complete";
}

export function deriveWorkSlots(
  packet: MissionPacket,
  visibleEvents: readonly Record<string, unknown>[],
  pact: Record<string, unknown> | null,
  agentById: ReadonlyMap<string, PublicAgent>,
): readonly WorkSlot[] {
  const pactSlots = arrayOfRecords(pact?.roleSlots);
  const runtimeSlots = arrayOfRecords(packet.snapshot.roleSlots);
  const outputs = arrayOfRecords(pact?.requiredOutputs);
  const visibleTypes = new Set(visibleEvents.map((event) => text(event.type)));
  return pactSlots.map((slot, index) => {
    const roleSlotId = text(slot.roleSlotId, `role-${index + 1}`);
    const runtime = runtimeSlots.find(
      (candidate) => candidate.roleSlotId === roleSlotId,
    );
    const originalId = text(slot.originalAgentId ?? runtime?.originalAgentId);
    const replacementVisible = visibleEvents.some((event) =>
      eventTargetsSlot(event, "replacement_bound", roleSlotId),
    );
    const defaultVisible = visibleEvents.some((event) =>
      eventTargetsSlot(event, "role_defaulted", roleSlotId),
    );
    const delivered = visibleEvents.some((event) =>
      eventTargetsSlot(event, "artifact_submitted", roleSlotId),
    );
    const occupantId = replacementVisible
      ? text(runtime?.occupantAgentId, originalId)
      : originalId;
    const occupant = agentById.get(occupantId);
    const original = agentById.get(originalId);
    const outputIds = list(slot.requiredOutputIds);
    const outputNames = outputIds.map((outputId) =>
      humanize(
        text(
          outputs.find((output) => output.outputId === outputId)?.type,
          outputId,
        ),
      ),
    );
    const status = delivered
      ? "Artifact accepted"
      : replacementVisible
        ? "Recovery in progress"
        : defaultVisible
          ? "Defaulted"
          : visibleTypes.has("execution_started")
            ? "Working"
            : visibleTypes.has("pact_bound")
              ? "Bound"
              : "Awaiting oath";
    const tone = delivered
      ? "complete"
      : replacementVisible
        ? "recovery"
        : defaultVisible
          ? "danger"
          : visibleTypes.has("execution_started")
            ? "working"
            : "waiting";
    return {
      roleSlotId,
      characterName: occupant?.characterName ?? shortDigest(occupantId),
      technicalName: occupant?.technicalName ?? shortDigest(occupantId),
      originalName: original?.characterName ?? shortDigest(originalId),
      assignment: text(slot.assignment, `Role ${index + 1}`),
      outputs: outputNames,
      points: numberValue(slot.pointAllocation),
      status,
      replaced: replacementVisible && occupantId !== originalId,
      tone,
    };
  });
}

function eventTargetsSlot(
  event: Record<string, unknown>,
  type: string,
  roleSlotId: string,
): boolean {
  if (event.type !== type) return false;
  const payload = record(event.payload);
  const command = record(payload?.command);
  return command?.roleSlotId === roleSlotId;
}

async function loadMissionList(
  signal: AbortSignal,
): Promise<MissionListResponse> {
  return fetchTyped<MissionListResponse>("/api/missions?limit=12", signal);
}

async function loadAgentList(signal: AbortSignal): Promise<AgentListResponse> {
  return fetchTyped<AgentListResponse>("/api/agents?limit=12", signal);
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

function parseStreamMessage(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function isMissionPacket(
  value: Record<string, unknown>,
): value is Record<string, unknown> & MissionPacket {
  return (
    typeof value.missionId === "string" &&
    record(value.snapshot) !== null &&
    Array.isArray(value.events) &&
    typeof value.latestSequence === "number"
  );
}

export function mergeMissionPacket(
  current: MissionPacket | null,
  next: MissionPacket,
): MissionPacket {
  if (current === null || current.missionId !== next.missionId) return next;
  const events = new Map<number, Record<string, unknown>>();
  for (const event of [...current.events, ...next.events]) {
    events.set(numberValue(event.sequence), event);
  }
  return {
    ...current,
    ...next,
    events: [...events.values()].sort(
      (left, right) => numberValue(left.sequence) - numberValue(right.sequence),
    ),
  };
}

function syncQuery(changes: Readonly<Record<string, string | null>>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", url);
}

function displayState(snapshot: Record<string, unknown>): string {
  if (snapshot.stage === "EXECUTE" && snapshot.executionStarted === false)
    return "Bound";
  return text(snapshot.displayState ?? snapshot.stage, "Unknown");
}

function difficultyLabel(value: MissionCard["difficulty"]): string {
  return value === "expert"
    ? "Legendary"
    : value === "adept"
      ? "Heroic"
      : "Initiate";
}

function shortDigest(value: unknown): string {
  const digest = text(value, "pending");
  return digest.length > 18
    ? `${digest.slice(0, 10)}…${digest.slice(-6)}`
    : digest;
}

function initials(value: string): string {
  return (
    value
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "?"
  );
}

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? timestampFormatter.format(timestamp)
    : value;
}

function percent(value: number): string {
  return `${numberFormatter.format(value * 100)}%`;
}

function humanize(value: string): string {
  return value.replaceAll("-", " ").replaceAll("_", " ");
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "The public ledger is unavailable";
}
