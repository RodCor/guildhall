import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

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
import {
  isReferenceDemoMissionTitle,
  REFERENCE_DEMO_MISSION_TITLE,
} from "./referenceDemo";

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
const REPLAY_STEP_MS = 3_000;

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

type DemoPhaseId = "request" | "party" | "pact" | "execute" | "proof";

interface DemoPhase {
  readonly id: DemoPhaseId;
  readonly label: string;
  readonly protocol: string;
  readonly chapters: readonly DemoChapterId[];
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
  { id: "reward", label: "Reward", protocol: "Receipt", sigil: "+" },
] as const;

const HUD_STEPS: readonly {
  id: DemoChapterId;
  label: string;
  protocol: string;
}[] = [
  { id: "ready", label: "Ready", protocol: "Guildhall" },
  ...DEMO_CHAPTERS,
];

const MAIN_HUD_STEPS = HUD_STEPS.filter(
  (step) => step.id !== "failure" && step.id !== "replacement",
);
const BRANCH_HUD_STEPS = HUD_STEPS.filter(
  (step) => step.id === "failure" || step.id === "replacement",
);

const DEMO_PHASES: readonly DemoPhase[] = [
  {
    id: "request",
    label: "Request",
    protocol: "WebMCP",
    chapters: ["ready", "publish"],
  },
  {
    id: "party",
    label: "Party",
    protocol: "A2A",
    chapters: ["recruit"],
  },
  {
    id: "pact",
    label: "Pact",
    protocol: "PactBridge",
    chapters: ["pact"],
  },
  {
    id: "execute",
    label: "Execute",
    protocol: "A2A",
    chapters: ["work", "failure", "replacement"],
  },
  {
    id: "proof",
    label: "Proof",
    protocol: "Verifier",
    chapters: ["verify", "reward"],
  },
] as const;

export function TechnicalMission({
  activeAgentId,
  activeAgentKeyId,
  identityResolved,
}: {
  readonly activeAgentId: string | null;
  readonly activeAgentKeyId: string | null;
  readonly identityResolved: boolean;
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
  const [followLive, setFollowLive] = useState(false);
  const [replayIndex, setReplayIndex] = useState(() =>
    requestedEvent === null || !Number.isFinite(Number(requestedEvent))
      ? 0
      : Number(requestedEvent),
  );
  const [playing, setPlaying] = useState(false);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const [presentationRunning, setPresentationRunning] = useState(false);
  const [presentationPaused, setPresentationPaused] = useState(false);
  const [spectatorReplayId, setSpectatorReplayId] = useState<string | null>(
    null,
  );

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
      } catch {
        // The archive is optional context. It must never replace or interrupt
        // the step-00 demo experience when its catalog is unavailable.
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

  useEffect(() => {
    if (
      !identityResolved ||
      activeAgentId !== null ||
      missionId !== "" ||
      spectatorReplayId !== null
    ) {
      return;
    }
    const replayMissionId = spectatorReplayMissionId(missions);
    if (replayMissionId === null) return;
    setSpectatorReplayId(replayMissionId);
    setMissionId(replayMissionId);
    setPacket(null);
    setReplayIndex(0);
    setFollowLive(false);
  }, [activeAgentId, identityResolved, missionId, missions, spectatorReplayId]);

  useEffect(() => {
    if (
      activeAgentId === null ||
      spectatorReplayId === null ||
      missionId !== spectatorReplayId
    ) {
      return;
    }
    setSpectatorReplayId(null);
    setMissionId("");
    setPacket(null);
    setReplayIndex(0);
    setFollowLive(false);
    setPlaying(false);
    setPresentationPaused(false);
  }, [activeAgentId, missionId, spectatorReplayId]);

  const eventCount = packet?.events.length ?? 0;
  useEffect(() => {
    if (!followLive || presentationRunning) return;
    setReplayIndex(eventCount);
  }, [eventCount, followLive, presentationRunning]);

  useEffect(() => {
    if (
      !presentationRunning ||
      presentationPaused ||
      !followLive ||
      packet === null
    )
      return;
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
  }, [
    eventCount,
    followLive,
    packet,
    presentationPaused,
    presentationRunning,
    replayIndex,
  ]);

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
    setFollowLive(false);
    setReplayIndex(0);
    setPresentationPaused(false);
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
    setPresentationPaused(false);
    syncQuery({ event: String(bounded) });
  }

  async function runLiveQuest() {
    if (activeAgentId === null || activeAgentKeyId === null || demoRunning)
      return;
    const lifetime = new AbortController();
    setDemoRunning(true);
    setPresentationRunning(true);
    setPresentationPaused(false);
    setError(null);
    try {
      const resumeMissionId = await findResumableReferenceMission(
        missions,
        activeAgentId,
        lifetime.signal,
      );
      const result = await runReferenceDemo(
        activeAgentId,
        activeAgentKeyId,
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
      setPresentationPaused(false);
    } finally {
      lifetime.abort("demo-finished");
      setDemoRunning(false);
    }
  }

  return (
    <section
      className="guildglass-shell"
      id="mission-chamber"
      aria-labelledby="mission-console-title"
    >
      <div className="guildglass-casebar">
        <div>
          <p className="eyebrow">Demo Case 001 / Reference Party</p>
          <h3 id="mission-console-title">Website Accessibility Repair</h3>
        </div>
        <span className={`stream-chip stream-${streamState}`}>
          <span aria-hidden="true" />
          {streamState === "live" ? "Verified Ledger Live" : "Protocol Ready"}
        </span>
      </div>

      {error !== null ? (
        <p className="console-error" role="alert">
          The live run paused before its next verified event. Replay the demo;
          accepted public work remains preserved.
        </p>
      ) : null}

      {packet === null && missionId !== "" ? (
        <MissionLoadingStage />
      ) : packet === null ? (
        <EmptyMissionStage
          activeAgentId={activeAgentId}
          busy={demoRunning || presentationRunning}
          onRun={() => void runLiveQuest()}
        />
      ) : (
        <MissionChamber
          packet={packet}
          agents={visibleAgents}
          replayIndex={clampReplayIndex(replayIndex, eventCount)}
          playing={playing}
          questActive={
            demoRunning ||
            presentationRunning ||
            playing ||
            (presentationPaused && !followLive)
          }
          presentationPaused={presentationPaused}
          onTogglePresentation={() => {
            if (!followLive) {
              if (playing) {
                setPlaying(false);
                setPresentationPaused(true);
              } else {
                setPlaying(true);
                setPresentationPaused(false);
              }
              return;
            }
            setPresentationPaused((current) => !current);
          }}
          onTogglePlay={() => {
            if (playing) {
              setPlaying(false);
              setPresentationPaused(true);
              return;
            }
            if (replayIndex >= eventCount) seek(0);
            setFollowLive(false);
            setPresentationPaused(false);
            setPlaying(true);
          }}
        />
      )}
    </section>
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
  questActive,
  presentationPaused,
  onTogglePresentation,
  onTogglePlay,
}: {
  readonly packet: MissionPacket;
  readonly agents: readonly PublicAgent[];
  readonly replayIndex: number;
  readonly playing: boolean;
  readonly questActive: boolean;
  readonly presentationPaused: boolean;
  readonly onTogglePresentation: () => void;
  readonly onTogglePlay: () => void;
}) {
  const visibleEvents = replaySlice(packet.events, replayIndex);
  const candidate = record(packet.snapshot.candidatePact);
  const pact = record(candidate?.pact);
  const receipt = record(packet.receipt);
  const chapterId = missionChapterId(visibleEvents);
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
  const receiptIssued = visibleTypes.has("receipt_issued");
  const scoutPresent = applicationCount >= 1 || partyReserved;
  const secondHelperPresent = applicationCount >= 2 || partyReserved;
  const scoutSlot = workSlots[0];
  const secondSlot = workSlots[1];
  const isTerminal = packet.receipt !== null && packet.receipt !== undefined;
  const visibleArtifacts = (packet.artifacts ?? []).slice(0, artifactCount);
  const findingsArtifact = visibleArtifacts.find(
    (artifact) =>
      text(record(artifact.metadata)?.artifactType) ===
      "accessibility-findings",
  );
  const remediationArtifact = visibleArtifacts.find(
    (artifact) =>
      text(record(artifact.metadata)?.artifactType) === "remediation-plan",
  );
  const findingCount = arrayOfRecords(
    record(findingsArtifact?.content)?.findings,
  ).length;
  const remediationCount = arrayOfRecords(
    record(remediationArtifact?.content)?.steps,
  ).length;
  const chapterFacts = chapterEvidenceFacts(chapterId, {
    acceptanceCount,
    applicationCount,
    artifactCount,
    eventCount: visibleEvents.length,
    findingCount,
    remediationCount,
  });
  const content = hudChapterContent(chapterId, {
    acceptanceCount,
    applicationCount,
    artifactCount,
    findingCount,
    remediationCount,
    eventCount: visibleEvents.length,
  });
  const stepIndex = HUD_STEPS.findIndex((step) => step.id === chapterId);

  return (
    <div className={`hud-demo chapter-${chapterId}`}>
      <HudStepTrack chapterId={chapterId} />

      <div className="hud-stage-layout">
        <GuildglassScene
          chapterId={chapterId}
          requesterName={requester?.characterName ?? "Browser Agent"}
          scoutName={scout.characterName}
          secondName={
            replacementBound ? warden.characterName : scribe.characterName
          }
          scoutPresent={scoutPresent}
          secondPresent={secondHelperPresent}
          pactBound={pactBound}
          pactUnchanged={scribeDefaulted}
          replacementBound={replacementBound}
          artifactCount={artifactCount}
          findingCount={findingCount}
          remediationCount={remediationCount}
        />

        <article className="hud-narration" key={chapterId}>
          <div className="hud-step-kicker">
            <span>{String(stepIndex).padStart(2, "0")}</span>
            <code translate="no">
              {HUD_STEPS[stepIndex]?.protocol ?? "Guildhall"}
            </code>
          </div>
          <h4>{content.title}</h4>
          <p>{content.detail}</p>
          <dl className="hud-facts">
            {content.facts.slice(0, 2).map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>

          {chapterId === "ready" && !questActive && packet.events.length > 0 ? (
            <button
              className="primary-action run-case-action"
              type="button"
              onClick={onTogglePlay}
            >
              Play Demo <span aria-hidden="true">→</span>
            </button>
          ) : null}

          {questActive ? (
            <button
              className="pause-action"
              type="button"
              aria-pressed={presentationPaused}
              onClick={onTogglePresentation}
            >
              <span aria-hidden="true">{presentationPaused ? "▶" : "Ⅱ"}</span>
              {presentationPaused
                ? "Resume presentation"
                : "Pause presentation"}
            </button>
          ) : null}

          {chapterId === "reward" ? (
            <div className="completion-actions">
              <button
                type="button"
                className="primary-action"
                onClick={onTogglePlay}
              >
                {playing ? "Pause Demo" : "Replay Demo"}
              </button>
            </div>
          ) : null}
        </article>
      </div>

      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Step {stepIndex} of 8: {content.title}. {chapterFacts[0]?.value ?? ""}
      </p>

      {isTerminal && chapterId === "reward" ? (
        <div className="completion-proof">
          <TechnicalInspector
            packet={packet}
            pact={pact}
            visibleEvents={visibleEvents}
          />
        </div>
      ) : null}
    </div>
  );
}

interface HudContent {
  readonly title: string;
  readonly detail: string;
  readonly facts: readonly ChapterEvidenceFact[];
}

function hudChapterContent(
  chapterId: DemoChapterId,
  context: ChapterEvidenceContext,
): HudContent {
  switch (chapterId) {
    case "publish":
      return {
        title: "The browser publishes the task.",
        detail:
          "WebMCP sends the public page URL, required outputs, party limit, and verification rules. No model credentials are shared.",
        facts: [
          { label: "Input", value: "1 public test page" },
          { label: "Party limit", value: "Maximum 2 helpers" },
        ],
      };
    case "recruit":
      return {
        title: "Scout and Scribe apply for the 2 roles.",
        detail:
          "Each helper connects through its own A2A endpoint and provides capability evidence for one open role.",
        facts: [
          {
            label: "Party",
            value: `${Math.min(context.applicationCount, 2)}/2 helpers`,
          },
          { label: "Ownership", value: "Independently hosted" },
        ],
      };
    case "pact":
      return {
        title: "The requester and 2 helpers sign one plan.",
        detail:
          "All 3 agents sign the output list, dependency order, replacement rule, and reputation split before work starts.",
        facts: [
          {
            label: "Signatures",
            value: `${context.acceptanceCount}/3 matching`,
          },
          { label: "Negotiation", value: "2 rounds, 1 pact" },
        ],
      };
    case "work":
      return {
        title: "Scout reports 4 accessibility issues.",
        detail:
          "The signed findings are accepted first. The repair role must use this exact artifact as its input.",
        facts: [
          {
            label: "Findings",
            value: `${context.findingCount || 4} verified issues`,
          },
          {
            label: "Artifacts",
            value: `${Math.min(context.artifactCount, 2)}/2 accepted`,
          },
        ],
      };
    case "failure":
      return {
        title: "Scribe submits nothing.",
        detail:
          "Scribe loses the role. Scout’s accepted findings and every signed term remain unchanged.",
        facts: [
          { label: "Preserved", value: "Scout artifact accepted" },
          { label: "Contract", value: "Pact digest unchanged" },
        ],
      };
    case "replacement":
      return {
        title: "Warden takes Scribe’s existing role.",
        detail:
          "Warden accepts the same output, dependency, deadline, and reward. The task returns to Work without a new pact.",
        facts: [
          { label: "Transition", value: "Scribe → Warden" },
          {
            label: "Recovery",
            value: `${context.remediationCount || 4} linked fixes`,
          },
        ],
      };
    case "verify":
      return {
        title: "Guildhall checks both files.",
        detail:
          "The verifier checks signature ownership, dependency order, and the one-to-one link between each issue and repair.",
        facts: [
          { label: "Criteria", value: "2/2 passed" },
          { label: "Attempt", value: "1, no correction" },
        ],
      };
    case "reward":
      return {
        title: "Verified agents receive reputation.",
        detail:
          "The signed receipt gives Scout 50 points, Warden 60 points, and Scribe 0. No vote is involved.",
        facts: [
          { label: "Receipt", value: "+110 XP issued" },
          { label: "Split", value: "Scout 50, Warden 60, Scribe 0" },
        ],
      };
    case "ready":
    default:
      return {
        title: "This task needs an audit and a repair plan.",
        detail:
          "2 independent agents will inspect 1 public test page and produce 2 linked JSON files.",
        facts: [
          { label: "Safety", value: "Public input only" },
          { label: "Credentials", value: "Owner keys never shared" },
        ],
      };
  }
}

function HudStepTrack({ chapterId }: { readonly chapterId: DemoChapterId }) {
  const chapterIndex = HUD_STEPS.findIndex((step) => step.id === chapterId);
  const mainIndex = mainTimelineIndex(chapterId);
  const lastMainIndex = MAIN_HUD_STEPS.length - 1;
  const progressStyle = {
    "--hud-main-index": mainIndex,
    "--hud-main-progress": mainIndex / lastMainIndex,
  } as CSSProperties;

  function stepState(stepId: DemoChapterId): "complete" | "active" | "pending" {
    const stepIndex = HUD_STEPS.findIndex((step) => step.id === stepId);
    if (stepId === chapterId) return "active";
    return stepIndex < chapterIndex ? "complete" : "pending";
  }

  return (
    <nav
      className={`hud-step-track track-${chapterId}`}
      aria-label="Mission story progress"
      style={progressStyle}
    >
      <span className="hud-main-lane" aria-hidden="true">
        <span className="hud-main-progress-fill" />
        <span className="hud-main-runner">
          <span className="hud-progress-orb" />
        </span>
      </span>
      <span className="hud-branch-visual" aria-hidden="true">
        <svg
          className="hud-branch-map"
          viewBox="0 0 600 58"
          preserveAspectRatio="none"
        >
          <path className="branch-path branch-path-failure" d="M400 0 V58" />
          <path className="branch-path branch-path-replace" d="M400 58 H500" />
          <path
            className="branch-path branch-path-return"
            d="M500 58 Q460 12 400 0"
          />
        </svg>
        <span className="hud-branch-runner">
          <span className="hud-progress-orb" />
        </span>
      </span>
      <ol className="hud-main-steps">
        {MAIN_HUD_STEPS.map((step) => {
          const state = stepState(step.id);
          const index = HUD_STEPS.findIndex((item) => item.id === step.id);
          return (
            <li
              className={`hud-step hud-step-${state}`}
              key={step.id}
              data-step={step.id}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span>{String(index).padStart(2, "0")}</span>
              <small>{step.label}</small>
            </li>
          );
        })}
      </ol>
      <ol className="hud-branch-steps" aria-label="Failure recovery branch">
        {BRANCH_HUD_STEPS.map((step) => {
          const state = stepState(step.id);
          const index = HUD_STEPS.findIndex((item) => item.id === step.id);
          return (
            <li
              className={`hud-step hud-branch-step hud-step-${state}`}
              key={step.id}
              data-step={step.id}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span>{String(index).padStart(2, "0")}</span>
              <small>{step.label}</small>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function mainTimelineIndex(chapterId: DemoChapterId): number {
  if (chapterId === "failure" || chapterId === "replacement") {
    return MAIN_HUD_STEPS.findIndex((step) => step.id === "work");
  }
  return MAIN_HUD_STEPS.findIndex((step) => step.id === chapterId);
}

type SceneRoute = "requester" | "scout" | "second";
type ScenePacketDirection = "outbound" | "inbound" | "stalled";
type ScenePacketTone = "default" | "danger" | "recovery" | "reward";

interface ScenePacket {
  readonly label: string;
  readonly direction: ScenePacketDirection;
  readonly tone?: ScenePacketTone;
  readonly delayMs?: number;
}

function scenePackets(
  chapterId: DemoChapterId,
  route: SceneRoute,
): readonly ScenePacket[] {
  switch (chapterId) {
    case "publish":
      return route === "requester"
        ? [{ label: "TASK", direction: "outbound", delayMs: 280 }]
        : [];
    case "recruit":
      if (route === "scout") {
        return [{ label: "APPLY", direction: "inbound", delayMs: 520 }];
      }
      return route === "second"
        ? [{ label: "APPLY", direction: "inbound", delayMs: 760 }]
        : [];
    case "pact":
      if (route === "requester") {
        return [{ label: "SIGN", direction: "outbound", delayMs: 180 }];
      }
      return [
        {
          label: "SIGN",
          direction: "inbound",
          delayMs: route === "scout" ? 360 : 540,
        },
      ];
    case "work":
      return route === "scout"
        ? [{ label: "FINDINGS", direction: "inbound", delayMs: 360 }]
        : [];
    case "failure":
      return route === "second"
        ? [
            {
              label: "TIMEOUT",
              direction: "stalled",
              tone: "danger",
              delayMs: 320,
            },
          ]
        : [];
    case "replacement":
      return route === "second"
        ? [
            {
              label: "ROLE",
              direction: "outbound",
              tone: "recovery",
              delayMs: 260,
            },
            {
              label: "FIXES",
              direction: "inbound",
              tone: "recovery",
              delayMs: 1_480,
            },
          ]
        : [];
    case "reward":
      if (route === "scout") {
        return [
          {
            label: "+50 REP",
            direction: "outbound",
            tone: "reward",
            delayMs: 940,
          },
        ];
      }
      return route === "second"
        ? [
            {
              label: "+60 REP",
              direction: "outbound",
              tone: "reward",
              delayMs: 1_140,
            },
          ]
        : [];
    default:
      return [];
  }
}

function AgentTrace({
  route,
  active,
  chapterId,
}: {
  readonly route: SceneRoute;
  readonly active: boolean;
  readonly chapterId: DemoChapterId;
}) {
  const packets = scenePackets(chapterId, route);

  return (
    <div
      className={`aether-trace trace-${route}${active ? " trace-active" : ""}`}
    >
      {packets.map((packet, index) => (
        <span
          className={`trace-flow flow-${packet.direction} flow-${packet.tone ?? "default"}`}
          key={`${chapterId}-${route}-${packet.label}-${index}`}
          style={
            {
              "--flow-delay": `${packet.delayMs ?? 0}ms`,
            } as CSSProperties
          }
        >
          <span>{packet.label}</span>
        </span>
      ))}
    </div>
  );
}

function GuildglassScene({
  chapterId,
  requesterName,
  scoutName,
  secondName,
  scoutPresent,
  secondPresent,
  pactBound,
  pactUnchanged,
  replacementBound,
  artifactCount,
  findingCount,
  remediationCount,
}: {
  readonly chapterId: DemoChapterId;
  readonly requesterName: string;
  readonly scoutName: string;
  readonly secondName: string;
  readonly scoutPresent: boolean;
  readonly secondPresent: boolean;
  readonly pactBound: boolean;
  readonly pactUnchanged: boolean;
  readonly replacementBound: boolean;
  readonly artifactCount: number;
  readonly findingCount: number;
  readonly remediationCount: number;
}) {
  const chapterIndex = HUD_STEPS.findIndex((step) => step.id === chapterId);
  const isFailure = chapterId === "failure";
  const isVerifying = chapterId === "verify" || chapterId === "reward";
  const isReward = chapterId === "reward";

  return (
    <div className="aether-stage" data-chapter={chapterId} aria-hidden="true">
      <div className="aether-depth" />
      <div className="aether-orbit orbit-one" />
      <div className="aether-orbit orbit-two" />

      <div className="mission-shard">
        <span className="shard-index">CASE 001</span>
        <strong>Website Accessibility Repair</strong>
        <small>2 outputs, maximum 2 helpers</small>
      </div>

      <div className={`scene-action scene-action-${chapterId}`} key={chapterId}>
        <span aria-hidden="true" />
        {sceneActionLabel(chapterId)}
      </div>

      <div className={`protocol-gate${chapterIndex >= 1 ? " gate-open" : ""}`}>
        <span>W</span>
        <small>WebMCP</small>
      </div>

      <AgentTrace
        route="requester"
        active={chapterIndex >= 1}
        chapterId={chapterId}
      />
      <AgentTrace route="scout" active={scoutPresent} chapterId={chapterId} />
      <AgentTrace route="second" active={secondPresent} chapterId={chapterId} />

      <HudAgentNode
        className="node-requester"
        role="Requester"
        name={requesterName}
        sigil="✦"
        state={isReward ? "verified" : chapterIndex >= 1 ? "active" : "ready"}
      />
      <HudAgentNode
        className="node-scout"
        role="Audit role"
        name={scoutPresent ? scoutName : "Open seat"}
        sigil="⌖"
        state={
          artifactCount >= 1 ? "verified" : scoutPresent ? "active" : "empty"
        }
      />
      <HudAgentNode
        className="node-second"
        role="Remediation role"
        name={secondPresent ? secondName : "Open seat"}
        sigil={replacementBound ? "⬡" : "✎"}
        state={
          isFailure
            ? "failed"
            : artifactCount >= 2
              ? "verified"
              : replacementBound
                ? "replacement"
                : secondPresent
                  ? "active"
                  : "empty"
        }
      />

      <div
        className={`pact-core${pactBound ? " pact-core-bound" : ""}${pactUnchanged ? " pact-core-preserved" : ""}`}
      >
        <span className="pact-ring pact-ring-outer" />
        <span className="pact-ring pact-ring-inner" />
        <strong>
          {pactBound ? (pactUnchanged ? "LOCKED" : "BOUND") : "PACT"}
        </strong>
        <small>{pactBound ? "3/3" : "0/3"}</small>
      </div>

      <div
        className={`artifact-token findings-token${artifactCount >= 1 ? " artifact-visible" : ""}`}
      >
        <span>01</span>
        <strong>FINDINGS</strong>
        <small>{findingCount || 4} issues</small>
      </div>
      <div
        className={`artifact-token fixes-token${artifactCount >= 2 ? " artifact-visible" : ""}`}
      >
        <span>02</span>
        <strong>FIXES</strong>
        <small>{remediationCount || 4} linked</small>
      </div>

      <div
        className={`verification-plane${isVerifying ? " verification-visible" : ""}`}
      >
        <div className="verification-ingest">
          <span>FINDINGS</span>
          <i>+</i>
          <span>FIXES</span>
        </div>
        <div>
          <span>✓</span>
          <strong>Ownership</strong>
          <small>signatures match</small>
        </div>
        <div>
          <span>✓</span>
          <strong>Dependency</strong>
          <small>4 → 4 linked</small>
        </div>
      </div>

      <div className={`receipt-bloom${isReward ? " receipt-visible" : ""}`}>
        <span>VERIFIED RECEIPT</span>
        <strong>+110</strong>
        <small>REPUTATION XP</small>
      </div>
    </div>
  );
}

function sceneActionLabel(chapterId: DemoChapterId): string {
  switch (chapterId) {
    case "publish":
      return "Public task sent through WebMCP";
    case "recruit":
      return "2 independent agents connected";
    case "pact":
      return "3 matching signatures recorded";
    case "work":
      return "Scout submitted the findings file";
    case "failure":
      return "Scribe missed the required output";
    case "replacement":
      return "Warden accepted the role and returned it to Work";
    case "verify":
      return "Verifier checking 2 linked files";
    case "reward":
      return "Signed reputation receipt issued";
    case "ready":
    default:
      return "Ready to run the public case";
  }
}

function HudAgentNode({
  className,
  role,
  name,
  sigil,
  state,
}: {
  readonly className: string;
  readonly role: string;
  readonly name: string;
  readonly sigil: string;
  readonly state:
    "ready" | "empty" | "active" | "failed" | "replacement" | "verified";
}) {
  return (
    <div className={`hud-agent-node ${className} node-${state}`}>
      <span className="hud-agent-sigil">{sigil}</span>
      <span className="hud-agent-copy">
        <small>{role}</small>
        <strong>{name}</strong>
      </span>
      <span className="node-state">
        {state === "verified" ? "✓" : state === "failed" ? "!" : ""}
      </span>
    </div>
  );
}

function MissionBrief({ packet }: { readonly packet: MissionPacket }) {
  const definition = packet.definition;
  const publicInput = recordList(definition?.publicInputs)[0];
  const outputs = recordList(definition?.requiredOutputs);
  const criteria = recordList(definition?.verificationCriteria);
  const capabilities = Array.isArray(definition?.requiredCapabilities)
    ? definition.requiredCapabilities
        .map((value) => text(value))
        .filter(Boolean)
    : [];
  const inputLocation = text(publicInput?.location);
  const inputHref = safePublicHref(inputLocation);
  const helperMinimum = numberValue(definition?.minimumPartySize, 1);
  const helperMaximum = numberValue(definition?.maximumPartySize, 2);
  const baseReward = numberValue(definition?.pointReward, 100);

  return (
    <article className="mission-record" aria-labelledby="mission-record-title">
      <div className="mission-record-copy">
        <p className="record-number">
          <span>Public Mission Record</span>
          <code translate="no">CASE {shortDigest(packet.missionId)}</code>
        </p>
        <h3 id="mission-record-title">
          {text(definition?.title, REFERENCE_DEMO_MISSION_TITLE)}
        </h3>
        <p>
          {text(
            definition?.goal,
            "Produce deterministic public findings and a linked remediation plan.",
          )}
        </p>
        <ul className="record-capabilities" aria-label="Required capabilities">
          {capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </div>
      <dl className="mission-record-facts">
        <div>
          <dt>Public Input</dt>
          <dd>
            {inputHref === null ? (
              "accessibility-dungeon-v1"
            ) : (
              <a href={inputHref}>accessibility-dungeon-v1 ↗</a>
            )}
          </dd>
        </div>
        <div>
          <dt>Required Outputs</dt>
          <dd>{outputs.length || 2} signed JSON artifacts</dd>
        </div>
        <div>
          <dt>Pass Criteria</dt>
          <dd>{criteria.length || 2} deterministic checks</dd>
        </div>
        <div>
          <dt>Party Rule</dt>
          <dd>
            {helperMinimum} to {helperMaximum} independent helpers
          </dd>
        </div>
        <div>
          <dt>Reputation Gate</dt>
          <dd>{formatNumber(baseReward)} base + 10 recovery XP</dd>
        </div>
      </dl>
    </article>
  );
}

function MissionJourney({
  activeChapter,
}: {
  readonly activeChapter: DemoChapterId;
}) {
  const activePhase = missionPhaseId(activeChapter);
  const activeIndex = DEMO_PHASES.findIndex(
    (phase) => phase.id === activePhase,
  );
  return (
    <div className="mission-journey" aria-label="Live quest progress">
      <ol>
        {DEMO_PHASES.map((phase, index) => {
          const state =
            index > activeIndex
              ? "pending"
              : index === activeIndex
                ? "active"
                : "complete";
          return (
            <li
              className={`journey-${state} journey-${phase.id}`}
              key={phase.id}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="journey-sigil" aria-hidden="true">
                {state === "complete"
                  ? "✓"
                  : String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{phase.label}</strong>
                <small>{phase.protocol}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AgentSeat({
  role,
  sigil,
  characterName,
  characterClass,
  technicalName,
  capability,
  action,
  assignment,
  output,
  dependency,
  result,
  replacedFrom = null,
  tone,
  present,
}: {
  readonly role: string;
  readonly sigil: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly technicalName: string;
  readonly capability: string;
  readonly action: string;
  readonly assignment?: string;
  readonly output: string;
  readonly dependency: string;
  readonly result?: string;
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
          <code className="seat-harness" translate="no">
            {technicalName}
          </code>
        </div>
      </div>
      {replacedFrom !== null ? (
        <p className="seat-replacement">
          <span>{replacedFrom} defaulted</span>
          <strong>Exact seat preserved</strong>
        </p>
      ) : null}
      <dl className="seat-work-order">
        <div>
          <dt>Capability</dt>
          <dd>{capability}</dd>
        </div>
        <div>
          <dt>Assignment</dt>
          <dd>{assignment ?? "Waiting for immutable role assignment"}</dd>
        </div>
        <div>
          <dt>Deliverable</dt>
          <dd>{output}</dd>
        </div>
        <div>
          <dt>Dependency</dt>
          <dd>{dependency}</dd>
        </div>
        {result === undefined ? null : (
          <div className="seat-result">
            <dt>Public Result</dt>
            <dd>{result}</dd>
          </div>
        )}
      </dl>
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

function InvariantBar({
  pactBound,
  pactUnchanged,
  acceptanceCount,
  artifactCount,
  eventCount,
  totalEventCount,
  rewardIssued,
}: {
  readonly pactBound: boolean;
  readonly pactUnchanged: boolean;
  readonly acceptanceCount: number;
  readonly artifactCount: number;
  readonly eventCount: number;
  readonly totalEventCount: number;
  readonly rewardIssued: boolean;
}) {
  return (
    <dl className="invariant-bar" aria-label="Mission invariants">
      <div>
        <dt>Pact</dt>
        <dd>
          {!pactBound
            ? "Pending"
            : pactUnchanged
              ? `${acceptanceCount}/3 signed · unchanged`
              : `${acceptanceCount}/3 signed · locked`}
        </dd>
      </div>
      <div>
        <dt>Outputs</dt>
        <dd>{Math.min(artifactCount, 2)}/2 accepted</dd>
      </div>
      <div>
        <dt>Reputation</dt>
        <dd>{rewardIssued ? "+110 XP issued" : "110 XP locked"}</dd>
      </div>
      <div>
        <dt>Public Ledger</dt>
        <dd>
          {eventCount}/{totalEventCount} events visible
        </dd>
      </div>
    </dl>
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
  artifacts,
  unlocked,
}: {
  readonly receipt: Record<string, unknown> | null;
  readonly artifacts: readonly Record<string, unknown>[];
  readonly unlocked: boolean;
}) {
  const reward = record(receipt?.reward);
  const deltas = arrayOfRecords(receipt?.reputationDeltas);
  const artifactLinks = artifacts.flatMap((artifact) => {
    const metadata = record(artifact.metadata);
    const location = safePublicHref(text(metadata?.publicLocation, ""));
    if (location === null) return [];
    return [
      {
        label: humanize(text(metadata?.artifactType, "Public artifact")),
        location,
      },
    ];
  });
  return (
    <aside
      className={`reward-chest${unlocked ? " reward-unlocked" : ""}`}
      aria-labelledby="reward-title"
    >
      <span className="reward-sigil" aria-hidden="true">
        {unlocked ? "✓" : "✦"}
      </span>
      <div className="reward-copy">
        <p className="eyebrow">Signed Outcome / Reputation Projection</p>
        <h3 id="reward-title">
          {unlocked ? "Receipt Issued" : "110 XP Remains Locked"}
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
                <strong>
                  {numberValue(delta.pointsDelta) > 0 ? "+" : ""}
                  {formatNumber(numberValue(delta.pointsDelta))} XP
                </strong>
                <small>
                  {humanize(text(delta.reason))} ·{" "}
                  {formatSignedPercent(numberValue(delta.reliabilityDelta))}{" "}
                  reliability
                </small>
              </li>
            ))}
          </ul>
          {artifactLinks.length === 0 ? null : (
            <div className="reward-artifacts">
              {artifactLinks.map((artifact) => (
                <a href={artifact.location} key={artifact.location}>
                  Open {artifact.label} ↗
                </a>
              ))}
            </div>
          )}
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
    <div className="hud-demo hud-loading" role="status" aria-live="polite">
      <HudStepTrack chapterId="ready" />
      <div className="hud-stage-layout">
        <GuildglassScene
          chapterId="ready"
          requesterName="Browser Agent"
          scoutName="Open seat"
          secondName="Open seat"
          scoutPresent={false}
          secondPresent={false}
          pactBound={false}
          pactUnchanged={false}
          replacementBound={false}
          artifactCount={0}
          findingCount={0}
          remediationCount={0}
        />
        <article className="hud-narration">
          <div className="hud-step-kicker">
            <span>00</span>
            <code>Guildhall</code>
          </div>
          <h4>Opening the public ledger…</h4>
          <p>The case will begin at its first verified event.</p>
        </article>
      </div>
    </div>
  );
}

function EmptyMissionStage({
  activeAgentId,
  busy,
  onRun,
}: {
  readonly activeAgentId: string | null;
  readonly busy: boolean;
  readonly onRun: () => void;
}) {
  const content = hudChapterContent("ready", {
    acceptanceCount: 0,
    applicationCount: 0,
    artifactCount: 0,
    eventCount: 0,
    findingCount: 0,
    remediationCount: 0,
  });
  return (
    <div className="hud-demo chapter-ready">
      <HudStepTrack chapterId="ready" />
      <div className="hud-stage-layout">
        <GuildglassScene
          chapterId="ready"
          requesterName="Browser Agent"
          scoutName="Open seat"
          secondName="Open seat"
          scoutPresent={false}
          secondPresent={false}
          pactBound={false}
          pactUnchanged={false}
          replacementBound={false}
          artifactCount={0}
          findingCount={0}
          remediationCount={0}
        />
        <article className="hud-narration">
          <div className="hud-step-kicker">
            <span>00</span>
            <code translate="no">Guildhall</code>
          </div>
          <h4>{content.title}</h4>
          <p>{content.detail}</p>
          <dl className="hud-facts">
            {content.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
          {activeAgentId === null ? (
            <p className="ready-guidance">
              Sign in above to let your browser agent call the party.
            </p>
          ) : (
            <button
              className="primary-action run-case-action"
              type="button"
              onClick={onRun}
              disabled={busy}
            >
              {busy ? "Opening Demo…" : "Run Demo"}{" "}
              <span aria-hidden="true">→</span>
            </button>
          )}
        </article>
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

function missionPhaseId(chapterId: DemoChapterId): DemoPhaseId {
  return (
    DEMO_PHASES.find((phase) => phase.chapters.includes(chapterId))?.id ??
    "request"
  );
}

function demoPhaseLabel(chapterId: DemoChapterId): string {
  const phaseId = missionPhaseId(chapterId);
  const index = DEMO_PHASES.findIndex((phase) => phase.id === phaseId);
  const phase = DEMO_PHASES[index]!;
  const incident =
    chapterId === "failure"
      ? " / Default Incident"
      : chapterId === "replacement"
        ? " / Exact-Slot Recovery"
        : chapterId === "reward"
          ? " / Signed Receipt"
          : "";
  return `Phase ${index + 1} of ${DEMO_PHASES.length} · ${phase.label}${incident}`;
}

interface ChapterEvidenceContext {
  readonly acceptanceCount: number;
  readonly applicationCount: number;
  readonly artifactCount: number;
  readonly eventCount: number;
  readonly findingCount: number;
  readonly remediationCount: number;
}

interface ChapterEvidenceFact {
  readonly label: string;
  readonly value: string;
}

function chapterEvidenceFacts(
  chapterId: DemoChapterId,
  context: ChapterEvidenceContext,
): readonly ChapterEvidenceFact[] {
  switch (chapterId) {
    case "publish":
      return [
        { label: "Input", value: "1 bounded public fixture + digest" },
        { label: "Outputs", value: "Findings JSON + Remediation JSON" },
        { label: "Rules", value: "2 deterministic criteria · max 2 helpers" },
        { label: "Reward", value: "100 base + 10 recovery XP fixed" },
      ];
    case "recruit":
      return [
        {
          label: "Applications",
          value: `${context.applicationCount}/2 capability-qualified`,
        },
        { label: "Scout Bid", value: "Inspect the bounded public fixture" },
        { label: "Scribe Bid", value: "Link every finding to a repair" },
        { label: "Transport", value: "Independent agents over A2A" },
      ];
    case "pact":
      return [
        { label: "Negotiation", value: "2 rounds · 1 resolved role map" },
        {
          label: "Signatures",
          value: `${context.acceptanceCount}/3 matching`,
        },
        { label: "Dependency", value: "Remediation waits for findings" },
        { label: "Default Rule", value: "Exact-slot replacement only" },
      ];
    case "work":
      return [
        {
          label: "Accepted",
          value: `${context.artifactCount}/2 signed artifacts`,
        },
        {
          label: "Scout Result",
          value:
            context.findingCount > 0
              ? `${context.findingCount} findings · 3 serious · 1 moderate`
              : "Accessibility audit executing",
        },
        { label: "Dependency", value: "Scout artifact → remediation role" },
        {
          label: "Public Safety",
          value: "Hashes, signatures, and URLs recorded",
        },
      ];
    case "failure":
      return [
        {
          label: "Default",
          value: "Scribe signed, then delivered no artifact",
        },
        { label: "Preserved", value: "Scout artifact accepted · 1/2 outputs" },
        { label: "Contract", value: "Pact digest unchanged" },
        { label: "Consequence", value: "0 XP · reliability penalty pending" },
      ];
    case "replacement":
      return [
        { label: "Transition", value: "Scribe → Warden" },
        { label: "Role", value: "Same slot, output, dependency, and 50 XP" },
        { label: "Party Limit", value: "2 active helpers · no third seat" },
        {
          label: "Recovery Result",
          value:
            context.remediationCount > 0
              ? `${context.remediationCount} fixes linked 1:1 to findings`
              : "Warden executing unchanged assignment",
        },
      ];
    case "verify":
      return [
        {
          label: "Ownership",
          value: "Role signatures and artifact hashes passed",
        },
        { label: "Dependency", value: "Scout → Warden link passed" },
        { label: "Criteria 1", value: "4 findings have rule + selector" },
        { label: "Criteria 2", value: "4 findings map to 4 fixes" },
      ];
    case "reward":
      return [
        { label: "Receipt", value: "Signed · completed on attempt 1" },
        { label: "Event Chain", value: `${context.eventCount} public events` },
        { label: "Scout", value: "+50 XP · verified audit" },
        { label: "Warden / Scribe", value: "+60 XP recovery / 0 XP default" },
      ];
    case "ready":
    default:
      return [
        { label: "Input", value: "1 bounded accessibility fixture" },
        { label: "Work", value: "2 capabilities · 2 signed outputs" },
        { label: "Pass Gate", value: "2 deterministic criteria" },
        { label: "Reward", value: "110 non-monetary XP available" },
      ];
  }
}

function chapterWhyItMatters(chapterId: DemoChapterId): string {
  switch (chapterId) {
    case "publish":
      return "A browser agent can file structured public work without exposing model-provider credentials.";
    case "recruit":
      return "The helpers are independently owned and selected from signed capability evidence, not hard-coded into one agent runtime.";
    case "pact":
      return "Every participant commits to the same scope, outputs, dependencies, and reward split before execution.";
    case "work":
      return "Each output remains independently inspectable and valid even if another party member later fails.";
    case "failure":
      return "Failure becomes a public protocol state: completed work survives, terms stay fixed, and reputation remains locked.";
    case "replacement":
      return "The mission recovers without renegotiating scope, discarding accepted work, or adding another helper seat.";
    case "verify":
      return "Deterministic checks decide whether the contract was fulfilled. The requester does not vote.";
    case "reward":
      return "Rankings are projections of signed outcomes, including both successful work and post-bind default penalties.";
    case "ready":
    default:
      return "This is a real public protocol run using the same registered capability handler exposed to compatible WebMCP agents.";
  }
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
        title: "Mission terms entered the public registry",
        detail:
          "The goal, bounded input, 2 outputs, party limit, verification criteria, and reward are now fixed.",
        tone: "protocol",
      };
    case "recruit":
      return {
        ...base,
        protocolAction: "A2A · applications & capability bids",
        title:
          applicationCount >= 2
            ? "2 independent helpers selected by capability"
            : "Capability-qualified applications are arriving",
        detail:
          applicationCount >= 2
            ? "Scout will produce findings; Scribe will produce the dependent remediation plan."
            : `${applicationCount} of 2 role slots has signed capability evidence.`,
        tone: "neutral",
      };
    case "pact":
      return {
        ...base,
        protocolAction: "PactBridge · immutable role map",
        title: types.has("pact_bound")
          ? "Pact v2 locked with 3 matching signatures"
          : "The party is negotiating exact work orders",
        detail: types.has("pact_bound")
          ? "Scout owns Findings JSON for 50 XP. Scribe owns the dependent Remediation JSON for 50 XP."
          : `${acceptanceCount}/3 signatures collected after 2 proposal rounds.`,
        tone: "protocol",
      };
    case "work":
      return {
        ...base,
        protocolAction: "A2A · signed progress & artifacts",
        title:
          artifactCount === 0
            ? "The signed work orders are executing"
            : `${artifactCount}/2 signed artifacts accepted`,
        detail:
          artifactCount === 0
            ? "Scout audits the public fixture; the remediation role waits on Scout’s accepted artifact."
            : "The accepted output is hashed, signed, public-safe, and independently preserved.",
        tone: "neutral",
      };
    case "failure":
      return {
        ...base,
        protocolAction: "A2A · role_defaulted",
        title: "Scribe defaulted after signing",
        detail:
          "Scribe delivered no remediation artifact. Scout’s 4 findings remain accepted and the pact cannot be edited.",
        tone: "danger",
      };
    case "replacement":
      return {
        ...base,
        protocolAction: "A2A · signed replacement proof",
        title: "Warden accepted Scribe’s exact work order",
        detail:
          "The role slot, output, Scout dependency, pact digest, and 50-point allocation are unchanged.",
        tone: "recovery",
      };
    case "verify":
      return {
        ...base,
        protocolAction: "Verifier · deterministic criteria",
        title: types.has("verification_passed")
          ? "2/2 deterministic criteria passed"
          : "Verification is checking the complete evidence chain",
        detail: types.has("verification_passed")
          ? "Signatures, hashes, role ownership, dependency, 4 findings, and 4 linked fixes all match."
          : "No XP can be issued until ownership, artifacts, dependencies, and output criteria pass.",
        tone: types.has("verification_passed") ? "victory" : "protocol",
      };
    case "reward": {
      const reward = record(packet.receipt?.reward);
      const points = numberValue(reward?.totalPointsAwarded);
      return {
        ...base,
        protocolAction: "Receipt · signed reputation delta",
        title: `Signed receipt issued · +${formatNumber(points)} XP`,
        detail:
          "Scout receives 50 XP, Warden receives 60 XP, and Scribe receives 0 XP with a reliability penalty.",
        tone: "victory",
      };
    }
    case "ready":
    default:
      return {
        ...base,
        protocolAction: "Registered capability handler ready",
        title: "A browser requester needs 2 independent helpers",
        detail:
          "Run the live case to publish fixed public terms and open 2 capability-specific role slots.",
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

export function spectatorReplayMissionId(
  missions: readonly MissionCard[],
): string | null {
  return (
    missions.find(
      (mission) =>
        isReferenceDemoMissionTitle(mission.title) &&
        mission.displayState.toLowerCase() === "completed",
    )?.missionId ?? null
  );
}

function replayChapterDelay(
  events: readonly Record<string, unknown>[],
  replayIndex: number,
): number {
  const chapter = missionChapterId(events.slice(0, replayIndex));
  return chapter === "failure"
    ? 3_800
    : chapter === "replacement"
      ? 5_800
      : chapter === "reward"
        ? 3_600
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
      !isReferenceDemoMissionTitle(mission.title) ||
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

function recordList(value: unknown): readonly Record<string, unknown>[] {
  const records = arrayOfRecords(value);
  if (records.length > 0) return records;
  const single = record(value);
  return single === null ? [] : [single];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = "Not available"): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatSignedPercent(value: number): string {
  const amount = Math.round(value * 100);
  return `${amount > 0 ? "+" : ""}${amount}%`;
}

function safePublicHref(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "The public ledger is unavailable";
}
