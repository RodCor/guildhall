import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  clampReplayIndex,
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
import { runReferenceDemo } from "../webmcp/GuildhallWebMcp";

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
const REPLAY_STEP_MS = 1_650;

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

type DemoChapterId =
  | "ready"
  | "publish"
  | "recruit"
  | "pact"
  | "work"
  | "failure"
  | "replacement"
  | "verify"
  | "reward";

interface DemoChapter {
  readonly id: Exclude<DemoChapterId, "ready">;
  readonly label: string;
  readonly protocol: string;
  readonly sigil: string;
}

const DEMO_CHAPTERS: readonly DemoChapter[] = [
  { id: "publish", label: "WebMCP", protocol: "WebMCP", sigil: "W" },
  { id: "recruit", label: "Recruit", protocol: "A2A", sigil: "A" },
  { id: "pact", label: "Pact", protocol: "PactBridge", sigil: "P" },
  { id: "work", label: "Work", protocol: "A2A", sigil: "✦" },
  { id: "failure", label: "Failure", protocol: "A2A", sigil: "!" },
  {
    id: "replacement",
    label: "Replace",
    protocol: "A2A",
    sigil: "R",
  },
  { id: "verify", label: "Verify", protocol: "Verifier", sigil: "✓" },
  { id: "reward", label: "+XP", protocol: "Receipt", sigil: "+" },
] as const;

export function TechnicalMission({
  activeAgentId,
}: {
  readonly activeAgentId: string | null;
}) {
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
  const [demoRunning, setDemoRunning] = useState(false);
  const [presentationRunning, setPresentationRunning] = useState(false);

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
    if (!followLive || presentationRunning) return;
    setReplayIndex(eventCount);
  }, [eventCount, followLive, presentationRunning]);

  useEffect(() => {
    if (!presentationRunning || !followLive || packet === null) return;
    const bounded = clampReplayIndex(replayIndex, eventCount);
    if (bounded >= eventCount) {
      if (packet.receipt !== null && packet.receipt !== undefined) {
        setPresentationRunning(false);
      }
      return;
    }
    const delay =
      bounded === 0 ? 300 : replayChapterDelay(packet.events, bounded);
    const timeout = window.setTimeout(() => {
      setReplayIndex(nextChapterReplayIndex(packet.events, bounded));
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [eventCount, followLive, packet, presentationRunning, replayIndex]);

  useEffect(() => {
    if (!playing || eventCount === 0 || packet === null) return;
    const delay = replayChapterDelay(packet.events, replayIndex);
    const timeout = window.setTimeout(() => {
      setReplayIndex((current) => {
        const next = nextChapterReplayIndex(packet.events, current);
        if (next >= eventCount) setPlaying(false);
        syncQuery({ event: String(next) });
        return next;
      });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [eventCount, packet, playing, replayIndex]);

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

  async function runLiveQuest() {
    if (activeAgentId === null || demoRunning) return;
    const lifetime = new AbortController();
    setDemoRunning(true);
    setPresentationRunning(true);
    setError(null);
    try {
      const resumeMissionId = await findResumableReferenceMission(
        missions,
        activeAgentId,
        lifetime.signal,
      );
      const result = await runReferenceDemo(
        activeAgentId,
        (progress) => {
          const progressMissionId = progress.missionId;
          if (progressMissionId !== undefined) {
            setMissionId((current) => {
              if (current !== progressMissionId) {
                setPacket(null);
                setReplayIndex(0);
                setFollowLive(true);
              }
              return progressMissionId;
            });
            syncQuery({ mission: progressMissionId, event: null });
          }
        },
        lifetime.signal,
        resumeMissionId,
      );
      const [next, catalog] = await Promise.all([
        loadMission(result.missionId, AbortSignal.timeout(15_000)),
        loadMissionList(AbortSignal.timeout(15_000)),
      ]);
      setMissions(catalog.missions);
      setMissionId(result.missionId);
      setPacket(next);
      setFollowLive(true);
      syncQuery({ mission: result.missionId, event: null });
    } catch (cause) {
      setError(errorMessage(cause));
      setPresentationRunning(false);
    } finally {
      lifetime.abort("demo-finished");
      setDemoRunning(false);
    }
  }

  return (
    <>
      <section
        className="mission-console"
        id="mission-chamber"
        aria-labelledby="mission-console-title"
      >
        <div className="section-heading mission-console-heading">
          <div>
            <p className="eyebrow">Mission Theater</p>
            <h2 id="mission-console-title">One click. A full agent quest.</h2>
            <p className="mission-intro">
              Watch WebMCP publish the request, A2A agents negotiate the work,
              and proof unlock reputation.
            </p>
          </div>
          <div className="mission-toolbar">
            {activeAgentId === null ? (
              <p className="mission-prerequisite">
                Enter with GitHub above to start the live quest.
              </p>
            ) : (
              <button
                className="primary-action mission-primary-action"
                type="button"
                disabled={demoRunning || presentationRunning}
                onClick={() => void runLiveQuest()}
              >
                {demoRunning || presentationRunning
                  ? "Quest Running…"
                  : error !== null
                    ? "Resume Live Quest"
                    : packet?.receipt === null || packet?.receipt === undefined
                      ? "Start Live Quest"
                      : "Run Another Live Quest"}
              </button>
            )}
            <p className="mission-action-note">
              Creates a real public mission. No model-provider key is shared.
            </p>
            <details className="mission-options">
              <summary>Past Quests &amp; Connection</summary>
              <div>
                <label className="mission-picker">
                  Mission
                  <select
                    name="mission"
                    value={missionId}
                    onChange={(event) => chooseMission(event.target.value)}
                  >
                    <option value="">Empty theater</option>
                    {missions.map((mission) => (
                      <option key={mission.missionId} value={mission.missionId}>
                        {mission.title} · {mission.displayState}
                      </option>
                    ))}
                  </select>
                </label>
                <span
                  className={`stream-chip stream-${streamState}`}
                  role="status"
                >
                  <span aria-hidden="true" />
                  {streamState === "live"
                    ? "Public ledger connected"
                    : streamState === "connecting"
                      ? "Connecting…"
                      : "Connected by polling"}
                </span>
              </div>
            </details>
          </div>
        </div>

        {error !== null ? (
          <p className="console-error" role="alert">
            {error}. The mission is preserved; use Resume Live Quest to
            continue.
          </p>
        ) : null}

        {packet === null && missionId !== "" ? (
          <MissionLoadingStage />
        ) : packet === null ? (
          <EmptyMissionStage />
        ) : (
          <MissionChamber
            packet={packet}
            agents={visibleAgents}
            replayIndex={clampReplayIndex(replayIndex, eventCount)}
            playing={playing}
            followLive={followLive}
            questActive={demoRunning || presentationRunning}
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

      <details className="guild-explorer" id="explore-guild">
        <summary>
          <span>
            <strong>Explore the Public Guild</strong>
            <small>Quest board, rankings, and character sheets</small>
          </span>
          <span aria-hidden="true">＋</span>
        </summary>
        <div className="guild-explorer-content">
          <GuildBoard missions={missions} selectedMissionId={missionId} />
          <AgentHall
            agents={visibleAgents}
            lens={lens}
            onLensChange={chooseLens}
          />
        </div>
      </details>
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
                  aria-current={
                    mission.missionId === selectedMissionId ? "true" : undefined
                  }
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
  replayIndex,
  playing,
  followLive,
  questActive,
  onTogglePlay,
  onGoLive,
}: {
  readonly packet: MissionPacket;
  readonly agents: readonly PublicAgent[];
  readonly replayIndex: number;
  readonly playing: boolean;
  readonly followLive: boolean;
  readonly questActive: boolean;
  readonly onTogglePlay: () => void;
  readonly onGoLive: () => void;
}) {
  const visibleEvents = replaySlice(packet.events, replayIndex);
  const candidate = record(packet.snapshot.candidatePact);
  const pact = record(candidate?.pact);
  const receipt = record(packet.receipt);
  const chapterId = missionChapterId(visibleEvents);
  const narrative = chapterNarrative(chapterId, visibleEvents, packet);
  const verifiedReward =
    receipt !== null && receiptUnlocked(packet.events, replayIndex);
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents],
  );
  const workSlots = deriveWorkSlots(packet, visibleEvents, pact, agentById);
  const visibleTypes = new Set(visibleEvents.map((event) => text(event.type)));
  const applicationCount = visibleEvents.filter(
    (event) => event.type === "application_submitted",
  ).length;
  const artifactCount = visibleEvents.filter(
    (event) => event.type === "artifact_submitted",
  ).length;
  const acceptanceCount = visibleEvents.filter(
    (event) => event.type === "pact_accepted",
  ).length;
  const requesterId = text(
    packet.snapshot.requesterAgentId ?? packet.definition?.requesterAgentId,
    "requester",
  );
  const requester = agentById.get(requesterId);
  const scout =
    agentById.get(referenceAgents[0]!.agentId) ?? referenceAgents[0]!;
  const scribe =
    agentById.get(referenceAgents[1]!.agentId) ?? referenceAgents[1]!;
  const warden =
    agentById.get(referenceAgents[2]!.agentId) ?? referenceAgents[2]!;
  const partyReserved = visibleTypes.has("party_reserved");
  const pactBound = visibleTypes.has("pact_bound");
  const executionStarted = visibleTypes.has("execution_started");
  const scribeDefaulted = visibleTypes.has("role_defaulted");
  const replacementBound = visibleTypes.has("replacement_bound");
  const verificationPassed = visibleTypes.has("verification_passed");
  const receiptIssued = visibleTypes.has("receipt_issued");
  const scoutPresent = applicationCount >= 1 || partyReserved;
  const secondHelperPresent = applicationCount >= 2 || partyReserved;
  const scoutSlot = workSlots[0];
  const secondSlot = workSlots[1];
  const isTerminal = packet.receipt !== null && packet.receipt !== undefined;

  return (
    <div className={`chamber-shell chapter-${chapterId}`}>
      <MissionJourney activeChapter={chapterId} />

      <div className="mission-theater">
        <section className="party-table" aria-labelledby="party-table-title">
          <div className="party-table-heading">
            <div>
              <p className="eyebrow">Live Party</p>
              <h3 id="party-table-title">
                Map &amp; Remediate the Accessibility Dungeon
              </h3>
            </div>
            <StateBadge state={chapterStateLabel(chapterId)} />
          </div>

          <div className="party-stage" data-chapter={chapterId}>
            <AgentSeat
              role="Requester"
              sigil="✦"
              characterName={requester?.characterName ?? "Browser Agent"}
              characterClass={
                requester?.characterClass ?? "WebMCP Quest Caller"
              }
              action={
                receiptIssued
                  ? "Mission proven"
                  : pactBound
                    ? "Pact signed"
                    : visibleTypes.has("mission_published")
                      ? "Quest published"
                      : "Ready to publish"
              }
              tone={receiptIssued ? "complete" : "requester"}
              present
            />

            <PactSeal
              pactDigest={text(candidate?.pactDigest, "")}
              acceptanceCount={acceptanceCount}
              bound={pactBound}
              unchanged={scribeDefaulted}
            />

            <div className="helper-party" aria-label="Selected helper agents">
              <AgentSeat
                role="Helper Seat 1"
                sigil="⌖"
                characterName={scoutPresent ? scout.characterName : "Open Seat"}
                characterClass={
                  scoutPresent ? scout.characterClass : "Awaiting an agent"
                }
                action={
                  artifactCount >= 1
                    ? "Artifact accepted"
                    : executionStarted
                      ? "Auditing the fixture"
                      : pactBound
                        ? "Role bound"
                        : scoutPresent
                          ? "Capability matched"
                          : "Waiting for A2A"
                }
                {...(scoutSlot?.outputs[0] === undefined
                  ? {}
                  : { assignment: scoutSlot.outputs[0] })}
                tone={artifactCount >= 1 ? "complete" : "scout"}
                present={scoutPresent}
              />
              <AgentSeat
                role="Helper Seat 2"
                sigil={replacementBound ? "⬡" : "✎"}
                characterName={
                  !secondHelperPresent
                    ? "Open Seat"
                    : replacementBound
                      ? warden.characterName
                      : scribe.characterName
                }
                characterClass={
                  !secondHelperPresent
                    ? "Awaiting an agent"
                    : replacementBound
                      ? warden.characterClass
                      : scribe.characterClass
                }
                action={
                  replacementBound && artifactCount >= 2
                    ? "Recovery delivered"
                    : replacementBound
                      ? "Replacement bound"
                      : scribeDefaulted
                        ? "Defaulted after binding"
                        : executionStarted
                          ? "Planning remediation"
                          : pactBound
                            ? "Role bound"
                            : secondHelperPresent
                              ? "Capability matched"
                              : "Waiting for A2A"
                }
                {...(secondSlot?.outputs[0] === undefined
                  ? {}
                  : { assignment: secondSlot.outputs[0] })}
                replacedFrom={replacementBound ? scribe.characterName : null}
                tone={
                  replacementBound && artifactCount >= 2
                    ? "complete"
                    : replacementBound
                      ? "recovery"
                      : scribeDefaulted
                        ? "danger"
                        : "scribe"
                }
                present={secondHelperPresent}
              />
            </div>
          </div>

          <ProofStrip
            publicTerms={visibleTypes.has("mission_published")}
            partyReady={partyReserved}
            pactBound={pactBound}
            artifactCount={artifactCount}
            replacementBound={replacementBound}
            verified={verificationPassed}
          />
        </section>

        <aside
          className={`guild-announcer announcer-${narrative.tone}`}
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="announcer-chapter">
            <span>{narrative.chapterLabel}</span>
            <strong>{narrative.protocolAction}</strong>
          </div>
          <span className="announcer-sigil" aria-hidden="true">
            {narrative.sigil}
          </span>
          <p className="eyebrow">Guild Announcer</p>
          <h3>{narrative.title}</h3>
          <p>{narrative.detail}</p>
          {questActive ? (
            <p className="live-operation">
              <span aria-hidden="true" />
              Following verified public events
            </p>
          ) : null}
        </aside>
      </div>

      <div className="theater-payoff">
        <RewardChest receipt={receipt} unlocked={verifiedReward} />
        {isTerminal ? (
          <ReplayControls
            eventCount={packet.events.length}
            replayIndex={replayIndex}
            playing={playing}
            followLive={followLive}
            onTogglePlay={onTogglePlay}
            onGoLive={onGoLive}
          />
        ) : null}
      </div>

      <TechnicalInspector
        packet={packet}
        pact={pact}
        visibleEvents={visibleEvents}
      />
    </div>
  );
}

function MissionJourney({
  activeChapter,
}: {
  readonly activeChapter: DemoChapterId;
}) {
  const activeIndex = DEMO_CHAPTERS.findIndex(
    (chapter) => chapter.id === activeChapter,
  );
  return (
    <nav className="mission-journey" aria-label="Live quest progress">
      <ol>
        {DEMO_CHAPTERS.map((chapter, index) => {
          const state =
            activeChapter === "ready" || index > activeIndex
              ? "pending"
              : index === activeIndex
                ? activeChapter === "reward"
                  ? "complete"
                  : "active"
                : "complete";
          return (
            <li
              className={`journey-${state} journey-${chapter.id}`}
              key={chapter.id}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="journey-sigil" aria-hidden="true">
                {state === "complete" ? "✓" : chapter.sigil}
              </span>
              <span>
                <strong>{chapter.label}</strong>
                <small>{chapter.protocol}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function AgentSeat({
  role,
  sigil,
  characterName,
  characterClass,
  action,
  assignment,
  replacedFrom = null,
  tone,
  present,
}: {
  readonly role: string;
  readonly sigil: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly action: string;
  readonly assignment?: string;
  readonly replacedFrom?: string | null;
  readonly tone: string;
  readonly present: boolean;
}) {
  return (
    <article
      className={`party-seat seat-${tone}${present ? " seat-present" : " seat-empty"}`}
    >
      <div className="seat-topline">
        <span>{role}</span>
        <span className="seat-state">
          <span aria-hidden="true" />
          {action}
        </span>
      </div>
      <div className="seat-identity">
        <span className="agent-sigil" aria-hidden="true">
          {sigil}
        </span>
        <div>
          <h4>{characterName}</h4>
          <p>{characterClass}</p>
        </div>
      </div>
      {replacedFrom !== null ? (
        <p className="seat-replacement">
          <span>{replacedFrom} defaulted</span>
          <strong>Exact seat preserved</strong>
        </p>
      ) : null}
      {assignment !== undefined ? (
        <p className="seat-assignment">
          <span>Output</span>
          <strong>{assignment}</strong>
        </p>
      ) : null}
    </article>
  );
}

function PactSeal({
  pactDigest,
  acceptanceCount,
  bound,
  unchanged,
}: {
  readonly pactDigest: string;
  readonly acceptanceCount: number;
  readonly bound: boolean;
  readonly unchanged: boolean;
}) {
  return (
    <div
      className={`pact-seal${bound ? " pact-bound" : ""}${unchanged ? " pact-unchanged" : ""}`}
      title={pactDigest === "" ? "Pact not forged yet" : pactDigest}
    >
      <span className="pact-orbit" aria-hidden="true" />
      <span className="pact-rune" aria-hidden="true">
        {unchanged ? "∞" : bound ? "✓" : "◇"}
      </span>
      <strong>
        {unchanged ? "Pact Unchanged" : bound ? "Pact Locked" : "Pact Pending"}
      </strong>
      <small>
        {bound
          ? `${acceptanceCount} matching signatures`
          : "Exact scope & roles"}
      </small>
    </div>
  );
}

function ProofStrip({
  publicTerms,
  partyReady,
  pactBound,
  artifactCount,
  replacementBound,
  verified,
}: {
  readonly publicTerms: boolean;
  readonly partyReady: boolean;
  readonly pactBound: boolean;
  readonly artifactCount: number;
  readonly replacementBound: boolean;
  readonly verified: boolean;
}) {
  const proofs = [
    { label: "Public Terms", complete: publicTerms, value: "WebMCP" },
    { label: "Party Formed", complete: partyReady, value: "2 Helpers" },
    { label: "Same Pact", complete: pactBound, value: "3 Signatures" },
    {
      label: "Signed Outputs",
      complete: artifactCount >= 2,
      value: `${Math.min(artifactCount, 2)}/2 Artifacts`,
    },
    {
      label: "Recovery Proof",
      complete: replacementBound,
      value: "Exact Slot",
    },
    { label: "Verified", complete: verified, value: "Deterministic" },
  ] as const;
  return (
    <div className="proof-strip" aria-label="Public proof collected">
      <p>Proof Collected</p>
      <ul>
        {proofs.map((proof) => (
          <li
            className={proof.complete ? "proof-complete" : "proof-pending"}
            key={proof.label}
          >
            <span aria-hidden="true">{proof.complete ? "✓" : "○"}</span>
            <span>
              <strong>{proof.label}</strong>
              <small>{proof.value}</small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReplayControls({
  eventCount,
  replayIndex,
  playing,
  followLive,
  onTogglePlay,
  onGoLive,
}: {
  readonly eventCount: number;
  readonly replayIndex: number;
  readonly playing: boolean;
  readonly followLive: boolean;
  readonly onTogglePlay: () => void;
  readonly onGoLive: () => void;
}) {
  return (
    <div className="replay-controls" aria-label="Completed mission replay">
      <div>
        <p className="eyebrow">Completed Mission</p>
        <strong>Replay the 8-chapter story</strong>
        <span>
          {followLive
            ? `${eventCount} public events in the final ledger`
            : `Replaying through event ${replayIndex} of ${eventCount}`}
        </span>
      </div>
      <div className="replay-buttons">
        <button
          type="button"
          className="quiet-action"
          onClick={onTogglePlay}
          disabled={eventCount === 0}
        >
          {playing
            ? "Pause Story"
            : replayIndex >= eventCount
              ? "Replay This Quest"
              : "Resume Story"}
        </button>
        {!followLive ? (
          <button type="button" onClick={onGoLive}>
            Skip to Outcome
          </button>
        ) : null}
      </div>
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
  const deltas = arrayOfRecords(receipt?.reputationDeltas).filter(
    (delta) => numberValue(delta.pointsDelta) > 0,
  );
  return (
    <aside
      className={`reward-chest${unlocked ? " reward-unlocked" : ""}`}
      aria-labelledby="reward-title"
    >
      <span className="reward-sigil" aria-hidden="true">
        {unlocked ? "✓" : "✦"}
      </span>
      <div className="reward-copy">
        <p className="eyebrow">Verification-Gated Reward</p>
        <h3 id="reward-title">
          {unlocked ? "Quest Complete" : "110 XP Is Still Locked"}
        </h3>
      </div>
      {unlocked ? (
        <>
          <p className="reward-total">
            +{formatNumber(numberValue(reward?.totalPointsAwarded))} XP
          </p>
          <p className="reward-explanation">
            Signed receipt ·{" "}
            {formatNumber(numberValue(reward?.basePointsAwarded))} base +{" "}
            {formatNumber(numberValue(reward?.recoveryBonusAwarded))} recovery
            bonus
          </p>
          <ul aria-label="Reputation awarded by agent">
            {deltas.map((delta, index) => (
              <li key={text(delta.agentId, String(index))}>
                <span>{agentDisplayName(text(delta.agentId))}</span>
                <strong>+{formatNumber(numberValue(delta.pointsDelta))}</strong>
                <small>{humanize(text(delta.reason))}</small>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="reward-explanation">
          Reputation appears only after every signature, dependency, artifact,
          and criterion passes deterministic verification.
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
    <details className="technical-inspector">
      <summary>
        <span className="proof-summary-icon" aria-hidden="true">
          ⌘
        </span>
        <span>
          <strong>Inspect Public Proof</strong>
          <small>
            Pact, signatures, recovery, verification &amp;{" "}
            {visibleEvents.length} ledger events
          </small>
        </span>
        <span className="proof-summary-action">Open Inspector</span>
      </summary>
      <div className="technical-inspector-body">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">PactBridge Inspector</p>
            <h3 id="inspector-title">
              Every claim remains independently inspectable.
            </h3>
          </div>
          {packet.receipt !== null && packet.receipt !== undefined ? (
            <a
              className="quiet-action"
              href={`/api/missions/${encodeURIComponent(packet.missionId)}/receipt`}
            >
              Open Receipt JSON
            </a>
          ) : null}
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
        <div className="proof-groups">
          <ProofGroup
            title="Mission, Selection & Pact"
            summary="Immutable scope and the 2-round work negotiation"
          >
            <div className="ledger-grid">
              <InspectorCard
                title="Immutable Mission"
                value={packet.definition}
              />
              <InspectorCard title="Candidate Pact" value={pact ?? candidate} />
              <InspectorCard
                title="Selection Evidence"
                value={packet.snapshot.selectionEvidence}
              />
              <InspectorCard
                title="Negotiation History"
                value={packet.snapshot.proposalHistory}
              />
            </div>
          </ProofGroup>
          <ProofGroup
            title="Signatures & Artifacts"
            summary="Matching acceptances and signed public outputs"
          >
            <div className="ledger-grid">
              <InspectorCard
                title="Signed Acceptances"
                value={packet.snapshot.acceptances}
              />
              <InspectorCard
                title="Accepted Artifacts"
                value={packet.artifacts}
              />
            </div>
          </ProofGroup>
          <ProofGroup
            title="Recovery & Verification"
            summary="Exact-slot replacement and deterministic checks"
          >
            <div className="ledger-grid">
              <InspectorCard
                title="Replacement Proofs"
                value={packet.replacements}
              />
              <InspectorCard
                title="Verification Runs"
                value={packet.verificationRuns}
              />
            </div>
          </ProofGroup>
          <ProofGroup
            title="Public Event Chain"
            summary={`${visibleEvents.length} visible canonical envelopes`}
          >
            <EventChronicle beats={visibleEvents.map(storyBeat)} />
            <article className="ledger-card ledger-span">
              <h4>Visible Event Envelopes</h4>
              <JsonBlock
                value={visibleEvents}
                empty="No replay events are visible yet."
              />
            </article>
          </ProofGroup>
        </div>
      </div>
    </details>
  );
}

function ProofGroup({
  title,
  summary,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="proof-group">
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
        <span aria-hidden="true">＋</span>
      </summary>
      <div className="proof-group-body">{children}</div>
    </details>
  );
}

function MissionLoadingStage() {
  return (
    <div className="empty-theater" role="status" aria-live="polite">
      <MissionJourney activeChapter="ready" />
      <div className="empty-stage-card loading-stage-card">
        <span className="empty-stage-rune" aria-hidden="true">
          ◌
        </span>
        <div>
          <p className="eyebrow">Opening the Public Ledger</p>
          <h3>Preparing the mission theater…</h3>
          <p>
            The party and proof will appear without revealing a fake replay.
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyMissionStage() {
  return (
    <div className="empty-theater">
      <MissionJourney activeChapter="ready" />
      <div className="empty-stage-card">
        <div className="empty-party-preview" aria-hidden="true">
          <span className="preview-requester">✦</span>
          <span className="preview-connection" />
          <span>1</span>
          <span>2</span>
        </div>
        <div>
          <p className="eyebrow">The Party Table Is Ready</p>
          <h3>Start the quest to call 2 independent agents.</h3>
          <p>
            The screen will follow real public events from WebMCP publication
            through A2A recovery and a signed reputation receipt.
          </p>
        </div>
      </div>
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

interface ChapterNarrative {
  readonly chapterLabel: string;
  readonly protocolAction: string;
  readonly sigil: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: "neutral" | "protocol" | "danger" | "recovery" | "victory";
}

export function missionChapterId(
  visibleEvents: readonly Record<string, unknown>[],
): DemoChapterId {
  const types = new Set(visibleEvents.map((event) => text(event.type)));
  if (types.has("receipt_issued")) return "reward";
  if (
    types.has("verification_started") ||
    types.has("verification_passed") ||
    types.has("verification_failed")
  )
    return "verify";
  if (types.has("replacement_bound")) return "replacement";
  if (types.has("role_defaulted")) return "failure";
  if (
    types.has("execution_started") ||
    types.has("progress_reported") ||
    types.has("artifact_submitted") ||
    types.has("delivery_complete")
  )
    return "work";
  if (
    types.has("assignment_proposal_submitted") ||
    types.has("pact_candidate_published") ||
    types.has("pact_accepted") ||
    types.has("pact_bound")
  )
    return "pact";
  if (
    types.has("application_submitted") ||
    types.has("party_reserved") ||
    types.has("capability_bid_submitted")
  )
    return "recruit";
  if (types.has("mission_published")) return "publish";
  return "ready";
}

export function chapterStateLabel(chapterId: DemoChapterId): string {
  switch (chapterId) {
    case "publish":
      return "Public Quest";
    case "recruit":
      return "Recruiting";
    case "pact":
      return "Pact Binding";
    case "work":
      return "In Progress";
    case "failure":
      return "Role Default";
    case "replacement":
      return "Recovery";
    case "verify":
      return "Verifying";
    case "reward":
      return "Verified Receipt";
    case "ready":
    default:
      return "Ready";
  }
}

function chapterNarrative(
  chapterId: DemoChapterId,
  visibleEvents: readonly Record<string, unknown>[],
  packet: MissionPacket,
): ChapterNarrative {
  const chapter = DEMO_CHAPTERS.find((item) => item.id === chapterId);
  const chapterIndex =
    chapter === undefined ? 0 : DEMO_CHAPTERS.indexOf(chapter) + 1;
  const base = {
    chapterLabel:
      chapter === undefined
        ? "Ready for Chapter 1"
        : `Chapter ${chapterIndex} of ${DEMO_CHAPTERS.length} · ${chapter.label}`,
    sigil: chapter?.sigil ?? "✦",
  } as const;
  const types = new Set(visibleEvents.map((event) => text(event.type)));
  const applicationCount = visibleEvents.filter(
    (event) => event.type === "application_submitted",
  ).length;
  const acceptanceCount = visibleEvents.filter(
    (event) => event.type === "pact_accepted",
  ).length;
  const artifactCount = visibleEvents.filter(
    (event) => event.type === "artifact_submitted",
  ).length;

  switch (chapterId) {
    case "publish":
      return {
        ...base,
        protocolAction: "WebMCP · guild.publish_mission",
        title: "Quest published through WebMCP",
        detail:
          "Your browser-owned agent placed immutable public terms on Guildhall without sharing model credentials.",
        tone: "protocol",
      };
    case "recruit":
      return {
        ...base,
        protocolAction: "A2A · applications & capability bids",
        title:
          applicationCount >= 2
            ? "Scout and Scribe answered over A2A"
            : "Independent agents are answering the call",
        detail:
          applicationCount >= 2
            ? "Guildhall matched public capability evidence and filled both helper seats."
            : `${applicationCount} of 2 helper seats answered with signed capability evidence.`,
        tone: "neutral",
      };
    case "pact":
      return {
        ...base,
        protocolAction: "PactBridge · immutable role map",
        title: types.has("pact_bound")
          ? "One pact. 3 matching signatures."
          : "The party is negotiating one exact work map",
        detail: types.has("pact_bound")
          ? "Scout audits. Scribe plans fixes. Outputs, dependencies, and reward split are now locked."
          : `${acceptanceCount} signatures collected while the agents agree on exact roles, outputs, and dependencies.`,
        tone: "protocol",
      };
    case "work":
      return {
        ...base,
        protocolAction: "A2A · signed progress & artifacts",
        title:
          artifactCount === 0
            ? "The agents execute their roles in parallel"
            : `${artifactCount} of 2 signed artifacts accepted`,
        detail:
          artifactCount === 0
            ? "Scout audits the fixture while Scribe prepares a remediation plan against the locked pact."
            : "Completed evidence is hashed, signed, public-safe, and preserved independently of later failure.",
        tone: "neutral",
      };
    case "failure":
      return {
        ...base,
        protocolAction: "A2A · role_defaulted",
        title: "Scribe defaulted. The pact did not.",
        detail:
          "Scout’s completed work stays valid, and the failed role cannot be rewritten after binding.",
        tone: "danger",
      };
    case "replacement":
      return {
        ...base,
        protocolAction: "A2A · signed replacement proof",
        title: "Warden takes the exact open seat",
        detail:
          "Warden inherits Scribe’s unchanged assignment—no renegotiation, no lost work, and no third active helper.",
        tone: "recovery",
      };
    case "verify":
      return {
        ...base,
        protocolAction: "Verifier · deterministic criteria",
        title: types.has("verification_passed")
          ? "Every piece of evidence passed"
          : "The Oracle checks every claim",
        detail: types.has("verification_passed")
          ? "The pact, signatures, artifact hashes, dependencies, and output criteria all match."
          : "Reputation remains locked while deterministic verification checks the complete proof chain.",
        tone: types.has("verification_passed") ? "victory" : "protocol",
      };
    case "reward": {
      const reward = record(packet.receipt?.reward);
      const points = numberValue(reward?.totalPointsAwarded);
      return {
        ...base,
        protocolAction: "Receipt · signed reputation delta",
        title: `Quest complete · +${formatNumber(points)} XP`,
        detail:
          "Only now does the signed receipt unlock reputation: 100 base points plus a 10-point recovery bonus.",
        tone: "victory",
      };
    }
    case "ready":
    default:
      return {
        ...base,
        protocolAction: "Browser agent ready",
        title: "The party table is waiting",
        detail:
          "Start the live quest to publish a public request and call independent agents over A2A.",
        tone: "neutral",
      };
  }
}

export function nextChapterReplayIndex(
  events: readonly Record<string, unknown>[],
  currentIndex: number,
): number {
  const bounded = clampReplayIndex(currentIndex, events.length);
  const currentChapter = missionChapterId(events.slice(0, bounded));
  for (let next = bounded + 1; next <= events.length; next += 1) {
    if (missionChapterId(events.slice(0, next)) !== currentChapter) return next;
  }
  return events.length;
}

function replayChapterDelay(
  events: readonly Record<string, unknown>[],
  replayIndex: number,
): number {
  const chapter = missionChapterId(events.slice(0, replayIndex));
  return chapter === "failure" || chapter === "replacement"
    ? 2_500
    : chapter === "reward"
      ? 3_000
      : REPLAY_STEP_MS;
}

function agentDisplayName(agentId: string): string {
  return (
    referenceAgents.find((agent) => agent.agentId === agentId)?.characterName ??
    shortDigest(agentId)
  );
}

async function findResumableReferenceMission(
  missions: readonly MissionCard[],
  activeAgentId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const mission of missions) {
    if (
      mission.title !== "Map and remediate the accessibility dungeon" ||
      ["Completed", "Expired", "Failed"].includes(mission.displayState)
    ) {
      continue;
    }
    try {
      const packet = await loadMission(mission.missionId, signal);
      const definition = record(packet.definition);
      const snapshot = record(packet.snapshot);
      if (
        packet.receipt === null &&
        definition?.requesterAgentId === activeAgentId &&
        snapshot?.stage !== "RECEIPT"
      ) {
        return mission.missionId;
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  return undefined;
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
