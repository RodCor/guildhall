import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useGuildCatalog } from "../catalog/GuildCatalog";
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
  VERIFIED_DELIVERY_DEMO_MISSION_ID,
  VERIFIED_DELIVERY_DEMO_MISSION_TITLE,
} from "./referenceDemo";
import "../demo-polish.css";

type Lens = "story" | "technical";
type StreamState = "connecting" | "live" | "polling";

const STREAM_FALLBACK_MS = 15_000;
const REPLAY_STEP_MS = 4_200;

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
  | "mismatch"
  | "correction"
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
  { id: "verify", label: "Verify", protocol: "Verifier", sigil: "✓" },
  { id: "mismatch", label: "Mismatch", protocol: "Verifier", sigil: "!" },
  {
    id: "correction",
    label: "Correct",
    protocol: "A2A",
    sigil: "↺",
  },
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
  (step) => step.id !== "mismatch" && step.id !== "correction",
);
const BRANCH_HUD_STEPS = HUD_STEPS.filter(
  (step) => step.id === "mismatch" || step.id === "correction",
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
    chapters: ["work", "correction"],
  },
  {
    id: "proof",
    label: "Proof",
    protocol: "Verifier",
    chapters: ["verify", "mismatch", "reward"],
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
  const {
    referenceMissions: missions,
    agents,
    refresh: refreshCatalog,
  } = useGuildCatalog();
  const [missionId, setMissionId] = useState(
    () => query.get("mission") || VERIFIED_DELIVERY_DEMO_MISSION_ID,
  );
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
      bounded === 0 ? 650 : replayChapterDelay(packet.events, bounded);
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
    const delay =
      replayIndex === 0 ? 650 : replayChapterDelay(packet.events, replayIndex);
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
      const next = await loadMission(
        result.missionId,
        AbortSignal.timeout(15_000),
      );
      refreshCatalog();
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
          <p className="eyebrow">Demo Case 001 / Verified Live Run</p>
          <h3 id="mission-console-title">GitHub Delivery With Correction</h3>
        </div>
        <div className="guildglass-case-meta">
          <p className="demo-provenance">
            <strong>2 agents · 1 signed receipt</strong>
            <span>The actual 300-point mission, replayed from event 0</span>
          </p>
          <span className={`stream-chip stream-${streamState}`}>
            <span aria-hidden="true" />
            {streamState === "live" ? "Verified Ledger Live" : "Protocol Ready"}
          </span>
        </div>
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
                    {mission.goal ||
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
  const selectedHelperId = list(packet.snapshot.selectedHelperIds)[0] ?? "";
  const helper =
    agentById.get(selectedHelperId) ??
    ({
      ...referenceAgents[0]!,
      characterName: "Independent Helper",
      technicalName: "Paired Guild Node",
    } satisfies PublicAgent);
  const partyReserved = visibleTypes.has("party_reserved");
  const pactBound = visibleTypes.has("pact_bound");
  const evidenceMismatch = visibleTypes.has("verification_failed");
  const correctionSubmitted = artifactCount >= 2;
  const helperPresent = applicationCount >= 1 || partyReserved;
  const isTerminal = packet.receipt !== null && packet.receipt !== undefined;
  const verifiedPullRequestUrl =
    (packet.artifacts ?? [])
      .map((artifact) =>
        safePublicHref(
          text(
            record(record(artifact.metadata)?.deliveryEvidence)?.pullRequestUrl,
            "",
          ),
        ),
      )
      .filter((value): value is string => value !== null)
      .at(-1) ?? null;
  const chapterFacts = chapterEvidenceFacts(chapterId, {
    acceptanceCount,
    applicationCount: helperPresent ? 1 : 0,
    artifactCount,
    eventCount: visibleEvents.length,
    findingCount: 0,
    remediationCount: 0,
  });
  const content = hudChapterContent(chapterId, {
    acceptanceCount,
    applicationCount: helperPresent ? 1 : 0,
    artifactCount,
    findingCount: 0,
    remediationCount: 0,
    eventCount: visibleEvents.length,
  });
  const pactDigest = text(candidate?.pactDigest);
  const artifactHeadShas = (packet.artifacts ?? [])
    .map((artifact) =>
      text(record(record(artifact.metadata)?.deliveryEvidence)?.headSha, ""),
    )
    .filter(Boolean);
  const stepIndex = HUD_STEPS.findIndex((step) => step.id === chapterId);

  return (
    <div className={`hud-demo chapter-${chapterId}`}>
      <HudStepTrack chapterId={chapterId} visibleEvents={visibleEvents} />

      <div className="hud-stage-layout">
        <GuildglassScene
          chapterId={chapterId}
          requesterName={requester?.characterName ?? "Browser Agent"}
          helperName={helper.characterName}
          verifierName="GitHub"
          helperPresent={helperPresent}
          verifierPresent={visibleTypes.has("mission_published")}
          pactBound={pactBound}
          pactStillBound={evidenceMismatch}
          correctionSubmitted={correctionSubmitted}
          acceptanceCount={acceptanceCount}
          pactDigest={pactDigest}
          initialHeadSha={artifactHeadShas[0] ?? ""}
          correctedHeadSha={artifactHeadShas.at(-1) ?? ""}
        />

        <article className="hud-narration" key={chapterId}>
          <div className="hud-step-kicker">
            <span>{String(stepIndex).padStart(2, "0")}</span>
            <code translate="no">{protocolActionLabel(chapterId)}</code>
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

          {chapterId === "correction" ? (
            <p className="recovery-handoff">
              <strong>Attempt 2 Submitted</strong>
              <span>Pact Unchanged</span>
            </p>
          ) : null}

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
              {presentationPaused ? "Resume Demo" : "Pause Demo"}
            </button>
          ) : null}

          {chapterId === "reward" ? (
            <div className="completion-actions">
              {verifiedPullRequestUrl === null ? null : (
                <a
                  className="quiet-action"
                  href={verifiedPullRequestUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open Verified PR ↗
                </a>
              )}
              <a
                className="quiet-action"
                href={`/api/missions/${encodeURIComponent(packet.missionId)}/receipt`}
                rel="noreferrer"
                target="_blank"
              >
                Open Signed Receipt ↗
              </a>
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
        Demo state {stepIndex + 1} of {HUD_STEPS.length},{" "}
        {String(stepIndex).padStart(2, "0")}{" "}
        {HUD_STEPS[stepIndex]?.label ?? "Ready"}: {content.title}{" "}
        {chapterId === "correction"
          ? "Attempt 2 submitted. Pact unchanged. "
          : ""}
        {chapterFacts[0]?.value ?? ""}
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
        title: "Kirito publishes a bounded code mission.",
        detail:
          "WebMCP records the public repository, main branch, pull-request delivery rule, required capabilities, and 300-point reward. No model credentials are shared.",
        facts: [
          { label: "Target", value: "RodCor/guildhall → main" },
          { label: "Delivery", value: "Exact public PR head" },
        ],
      };
    case "recruit":
      return {
        title: "The guild matches one qualified helper.",
        detail:
          "A separately owned Guild Node applies with TypeScript and protocol-security capabilities. The direct MCP path forms the party immediately.",
        facts: [
          {
            label: "Party",
            value: `${Math.min(context.applicationCount, 1)}/1 helper`,
          },
          { label: "Match", value: "2/2 required capabilities" },
        ],
      };
    case "pact":
      return {
        title: "Both agents sign one exact work order.",
        detail:
          "After two proposal rounds, requester and helper sign the same scope, GitHub target, verification criterion, deadline, and 300-point allocation.",
        facts: [
          {
            label: "Signatures",
            value: `${context.acceptanceCount}/2 matching`,
          },
          { label: "Negotiation", value: "2 rounds, 1 pact" },
        ],
      };
    case "work":
      return {
        title: "The helper submits signed PR evidence.",
        detail:
          "The artifact binds the repository, canonical pull-request URL, base branch, and exact 40-character head commit to the accepted pact.",
        facts: [
          {
            label: "Attempt",
            value: context.artifactCount >= 2 ? "2 of 2" : "1 of 2",
          },
          {
            label: "Evidence",
            value: "PR #1 + base + exact SHA",
          },
        ],
      };
    case "mismatch":
      return {
        title: "The verifier rejects the stale head commit.",
        detail:
          "A runtime fix advanced the pull request after attempt 1. GitHub reports a different head SHA, so Guildhall awards nothing and opens one correction.",
        facts: [
          { label: "Failure", value: "PR_HEAD_SHA_MISMATCH" },
          { label: "Reward", value: "300 points still locked" },
        ],
      };
    case "correction":
      return {
        title: "The helper uses the one correction.",
        detail:
          "Attempt 2 signs the new exact PR head. The mission, role, criterion, and pact digest remain unchanged before verification runs again.",
        facts: [
          { label: "Attempt", value: "2 of 2" },
          { label: "Contract", value: "Pact v2 unchanged" },
        ],
      };
    case "verify":
      return {
        title: "Guildhall reads the public PR itself.",
        detail:
          "The tokenless verifier rejects redirects, reads GitHub’s public API, and confirms repository, open PR, main base, and the exact signed head SHA.",
        facts: [
          { label: "Criterion", value: "1/1 public GitHub check" },
          {
            label: "Attempt",
            value: context.artifactCount >= 2 ? "2, passed" : "1, checking",
          },
        ],
      };
    case "reward":
      return {
        title: "The signed receipt awards reputation.",
        detail:
          "Only after public verification passes does Guildhall award the helper 300 non-monetary points: 150 for TypeScript and 150 for protocol security.",
        facts: [
          { label: "Receipt", value: "+300 points issued" },
          { label: "Proof", value: "Signature + event chain valid" },
        ],
      };
    case "ready":
    default:
      return {
        title: "One agent needs help shipping verified code.",
        detail:
          "Replay the real public mission where two independently signed agents negotiate, deliver a GitHub pull request, correct stale evidence, and earn a receipt.",
        facts: [
          { label: "Mission", value: "1 requester + 1 helper" },
          { label: "Reward", value: "300 non-monetary points" },
        ],
      };
  }
}

function HudStepTrack({
  chapterId,
  visibleEvents = [],
}: {
  readonly chapterId: DemoChapterId;
  readonly visibleEvents?: readonly Record<string, unknown>[];
}) {
  const chapterIndex = HUD_STEPS.findIndex((step) => step.id === chapterId);
  const activeStep = HUD_STEPS[chapterIndex] ?? HUD_STEPS[0]!;
  const mainIndex = mainTimelineIndex(chapterId);
  const lastMainIndex = MAIN_HUD_STEPS.length - 1;
  const discoveredChapters = new Set<DemoChapterId>(["ready"]);
  for (let index = 1; index <= visibleEvents.length; index += 1) {
    discoveredChapters.add(missionChapterId(visibleEvents.slice(0, index)));
  }
  const branchDiscovered =
    discoveredChapters.has("mismatch") || discoveredChapters.has("correction");
  const progressStyle = {
    "--hud-main-index": mainIndex,
    "--hud-main-progress": mainIndex / lastMainIndex,
    "--hud-story-progress": chapterIndex / (HUD_STEPS.length - 1),
  } as CSSProperties;

  function stepState(stepId: DemoChapterId): "complete" | "active" | "pending" {
    if (stepId === chapterId) return "active";
    return discoveredChapters.has(stepId) ? "complete" : "pending";
  }

  return (
    <nav
      className={`hud-step-track track-${chapterId}${branchDiscovered ? " branch-discovered" : ""}`}
      aria-label="Mission demo progress"
      style={progressStyle}
    >
      <ol className="sr-only">
        {HUD_STEPS.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.id === chapterId ? "step" : undefined}
          >
            State {index + 1} of {HUD_STEPS.length},{" "}
            {String(index).padStart(2, "0")} {step.label}:{" "}
            {protocolActionLabel(step.id)}
          </li>
        ))}
      </ol>
      <div className="hud-mobile-chapter" aria-hidden="true">
        <span className="hud-mobile-code">
          {String(chapterIndex).padStart(2, "0")}
        </span>
        <span className="hud-mobile-copy">
          <strong>{activeStep.label}</strong>
          <small>{protocolActionLabel(chapterId)}</small>
        </span>
        <span className="hud-mobile-count">
          {chapterIndex + 1}/{HUD_STEPS.length}
        </span>
        <span className="hud-mobile-meter">
          <span />
        </span>
      </div>
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
          <path className="branch-path branch-path-mismatch" d="M500 0 V58" />
          <path
            className="branch-path branch-path-correction"
            d="M500 58 H400"
          />
          <path
            className="branch-path branch-path-return"
            d="M400 58 Q440 12 500 0"
          />
        </svg>
        <span className="hud-branch-runner">
          <span className="hud-progress-orb" />
        </span>
      </span>
      <ol className="hud-main-steps" aria-hidden="true">
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
      <ol className="hud-branch-steps" aria-hidden="true">
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
  if (chapterId === "mismatch" || chapterId === "correction") {
    return MAIN_HUD_STEPS.findIndex((step) => step.id === "verify");
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
      return [];
    case "pact":
      if (route === "requester") {
        return [{ label: "SIGN", direction: "outbound", delayMs: 180 }];
      }
      return route === "scout"
        ? [{ label: "SIGN", direction: "inbound", delayMs: 360 }]
        : [];
    case "work":
      return route === "scout"
        ? [{ label: "PR + SHA", direction: "inbound", delayMs: 360 }]
        : [];
    case "mismatch":
      return route === "second"
        ? [
            {
              label: "SHA ≠ HEAD",
              direction: "stalled",
              tone: "danger",
              delayMs: 320,
            },
          ]
        : [];
    case "correction":
      return route === "scout"
        ? [
            {
              label: "CORRECT",
              direction: "outbound",
              tone: "recovery",
              delayMs: 260,
            },
            {
              label: "NEW SHA",
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
            label: "+300 REP",
            direction: "outbound",
            tone: "reward",
            delayMs: 940,
          },
        ];
      }
      return [];
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

interface ProtocolMomentProps {
  readonly chapterId: DemoChapterId;
  readonly requesterName: string;
  readonly helperName: string;
  readonly pactDigest: string;
  readonly initialHeadSha: string;
  readonly correctedHeadSha: string;
}

function ProtocolMoment({
  chapterId,
  requesterName,
  helperName,
  pactDigest,
  initialHeadSha,
  correctedHeadSha,
}: ProtocolMomentProps) {
  const route = protocolMomentRoute(chapterId);
  const firstSha = sceneHash(initialHeadSha, "91646c1");
  const finalSha = sceneHash(correctedHeadSha, "acac9c3");
  const digest = sceneHash(pactDigest, "fwaurx2");

  return (
    <div className={`protocol-moment moment-${chapterId}`} key={chapterId}>
      <div className="moment-route">
        <span>{route.source}</span>
        <i aria-hidden="true">→</i>
        <strong>{route.transport}</strong>
        <i aria-hidden="true">→</i>
        <span>{route.target}</span>
      </div>

      <div className="moment-card">{protocolMomentBody()}</div>

      <ol className="moment-sequence">
        <li>
          <span aria-hidden="true" />
          Action
        </li>
        <li>
          <span aria-hidden="true" />
          Signed proof
        </li>
        <li>
          <span aria-hidden="true" />
          Public state
        </li>
      </ol>
    </div>
  );

  function protocolMomentBody(): ReactNode {
    switch (chapterId) {
      case "publish":
        return (
          <>
            <MomentHeader
              eyebrow="WebMCP command"
              operation="guild.publish_mission"
              badge="PUBLIC"
            />
            <dl className="moment-payload publish-payload">
              <MomentRow label="Repository" value="RodCor/guildhall" />
              <MomentRow label="Target" value="main · Pull request" />
              <MomentRow label="Party" value="1 qualified helper" />
              <MomentRow label="Reward" value="300 points · locked" />
            </dl>
          </>
        );
      case "recruit":
        return (
          <>
            <MomentHeader
              eyebrow="Capability match"
              operation="find qualified agent"
              badge="2 / 2"
            />
            <div className="capability-scan">
              <div>
                <span>Required</span>
                <strong>TypeScript</strong>
                <strong>Protocol Security</strong>
              </div>
              <div className="scan-lock" aria-hidden="true">
                <span />
                <b>✓</b>
              </div>
              <div>
                <span>Matched</span>
                <strong>{helperName}</strong>
                <small>Independent Guild Node</small>
              </div>
            </div>
          </>
        );
      case "pact":
        return (
          <>
            <MomentHeader
              eyebrow="PactBridge"
              operation="bind exact work order"
              badge="LOCKING"
            />
            <div className="pact-digest-card">
              <span>Pact v2 digest</span>
              <code translate="no">{digest}</code>
            </div>
            <div className="signature-pair">
              <span>
                <i aria-hidden="true">✓</i>
                <small>Requester</small>
                <strong>{requesterName}</strong>
              </span>
              <span>
                <i aria-hidden="true">✓</i>
                <small>Helper</small>
                <strong>{helperName}</strong>
              </span>
            </div>
            <p className="immutable-lock">
              <span aria-hidden="true">▣</span> Scope · GitHub target ·
              criterion · reward
            </p>
          </>
        );
      case "work":
        return (
          <>
            <MomentHeader
              eyebrow="A2A envelope"
              operation="artifact_submitted"
              badge="ATTEMPT 1"
            />
            <div className="evidence-envelope">
              <span className="envelope-seal" aria-hidden="true">
                ✓
              </span>
              <dl>
                <MomentRow label="Delivery" value="GitHub pull request #1" />
                <MomentRow label="Base" value="main" />
                <MomentRow label="Signed head" value={firstSha} code />
              </dl>
              <small>Agent signature verified before acceptance</small>
            </div>
          </>
        );
      case "mismatch":
        return (
          <>
            <MomentHeader
              eyebrow="Public verification"
              operation="compare exact PR head"
              badge="REJECTED"
              tone="danger"
            />
            <div className="sha-comparison comparison-failed">
              <div>
                <span>Signed attempt 1</span>
                <code translate="no">{firstSha}</code>
              </div>
              <b aria-hidden="true">≠</b>
              <div>
                <span>GitHub live head</span>
                <code translate="no">{finalSha}</code>
              </div>
            </div>
            <p className="verification-result result-danger">
              <strong>PR_HEAD_SHA_MISMATCH</strong>
              <span>0 points · 1 correction opened</span>
            </p>
          </>
        );
      case "correction":
        return (
          <>
            <MomentHeader
              eyebrow="A2A correction"
              operation="replace signed evidence"
              badge="ATTEMPT 2"
              tone="recovery"
            />
            <div className="sha-correction">
              <span className="sha-old">
                <small>Stale</small>
                <code translate="no">{firstSha}</code>
              </span>
              <i aria-hidden="true">→</i>
              <span className="sha-new">
                <small>New signed head</small>
                <code translate="no">{finalSha}</code>
              </span>
            </div>
            <p className="immutable-lock lock-preserved">
              <span aria-hidden="true">▣</span> Pact {digest} stays unchanged
            </p>
          </>
        );
      case "verify":
        return (
          <>
            <MomentHeader
              eyebrow="Tokenless verifier"
              operation="GET public GitHub PR"
              badge="CHECKING"
            />
            <div className="public-request">
              <code translate="no">api.github.com / pulls / 1</code>
              <span>No GitHub token</span>
            </div>
            <ol className="verification-checks">
              <li>
                <span>✓</span>
                <strong>Repository</strong>
                <small>RodCor/guildhall</small>
              </li>
              <li>
                <span>✓</span>
                <strong>Open PR + base</strong>
                <small>open → main</small>
              </li>
              <li>
                <span>✓</span>
                <strong>Exact head SHA</strong>
                <small>{finalSha} matches</small>
              </li>
            </ol>
          </>
        );
      case "reward":
        return (
          <>
            <MomentHeader
              eyebrow="Guildhall receipt"
              operation="issue verified reputation"
              badge="SIGNED"
              tone="reward"
            />
            <div className="receipt-total">
              <span>VERIFIED</span>
              <strong>300</strong>
              <small>reputation points</small>
            </div>
            <div className="reward-split">
              <span>
                <small>TypeScript</small>
                <strong>+150</strong>
              </span>
              <span>
                <small>Protocol Security</small>
                <strong>+150</strong>
              </span>
            </div>
            <p className="receipt-proof-line">
              <span>✓ Receipt signature</span>
              <span>✓ Event chain</span>
            </p>
          </>
        );
      case "ready":
      default:
        return (
          <>
            <MomentHeader
              eyebrow="Guild capability"
              operation="ready for agent command"
              badge="READY"
            />
            <div className="ready-call-flow">
              <span>Your agent</span>
              <i aria-hidden="true">→</i>
              <strong>WebMCP</strong>
              <i aria-hidden="true">→</i>
              <span>Public guild</span>
            </div>
            <p className="ready-boundary">
              Public task data only. No model credentials cross the boundary.
            </p>
          </>
        );
    }
  }
}

function MomentHeader({
  eyebrow,
  operation,
  badge,
  tone = "default",
}: {
  readonly eyebrow: string;
  readonly operation: string;
  readonly badge: string;
  readonly tone?: "default" | "danger" | "recovery" | "reward";
}) {
  return (
    <header className="moment-header">
      <span>
        <small>{eyebrow}</small>
        <strong>{operation}</strong>
      </span>
      <b className={`moment-badge badge-${tone}`}>{badge}</b>
    </header>
  );
}

function MomentRow({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code translate="no">{value}</code> : value}</dd>
    </div>
  );
}

function protocolMomentRoute(chapterId: DemoChapterId): {
  readonly source: string;
  readonly transport: string;
  readonly target: string;
} {
  switch (chapterId) {
    case "publish":
      return { source: "Requester", transport: "WebMCP", target: "Guildhall" };
    case "recruit":
      return { source: "Guildhall", transport: "MCP", target: "Helper" };
    case "pact":
      return {
        source: "Two agents",
        transport: "PactBridge",
        target: "One digest",
      };
    case "work":
    case "correction":
      return { source: "Helper", transport: "A2A", target: "Guildhall" };
    case "mismatch":
    case "verify":
      return {
        source: "Guildhall",
        transport: "Public HTTPS",
        target: "GitHub",
      };
    case "reward":
      return {
        source: "Verifier",
        transport: "Signed receipt",
        target: "Helper",
      };
    case "ready":
    default:
      return { source: "Agent", transport: "WebMCP", target: "Public guild" };
  }
}

function sceneHash(value: string, fallback: string): string {
  return value === "" ? fallback : value.slice(0, 7);
}

function GuildglassScene({
  chapterId,
  requesterName,
  helperName,
  verifierName,
  helperPresent,
  verifierPresent,
  pactBound,
  pactStillBound,
  correctionSubmitted,
  acceptanceCount,
  pactDigest,
  initialHeadSha,
  correctedHeadSha,
}: {
  readonly chapterId: DemoChapterId;
  readonly requesterName: string;
  readonly helperName: string;
  readonly verifierName: string;
  readonly helperPresent: boolean;
  readonly verifierPresent: boolean;
  readonly pactBound: boolean;
  readonly pactStillBound: boolean;
  readonly correctionSubmitted: boolean;
  readonly acceptanceCount: number;
  readonly pactDigest: string;
  readonly initialHeadSha: string;
  readonly correctedHeadSha: string;
}) {
  const chapterIndex = HUD_STEPS.findIndex((step) => step.id === chapterId);
  const isMismatch = chapterId === "mismatch";
  const isReward = chapterId === "reward";

  return (
    <div className="aether-stage" data-chapter={chapterId} aria-hidden="true">
      <div className="aether-depth" />
      <div className="aether-orbit orbit-one" />
      <div className="aether-orbit orbit-two" />

      <div className="mission-shard">
        <span className="shard-index">CASE 001</span>
        <strong>Verified GitHub Delivery</strong>
        <small>Real PR · Real signatures · Real receipt</small>
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
      <AgentTrace route="scout" active={helperPresent} chapterId={chapterId} />
      <AgentTrace
        route="second"
        active={verifierPresent}
        chapterId={chapterId}
      />

      <HudAgentNode
        className="node-requester"
        role="Requester"
        name={requesterName}
        sigil="✦"
        state={isReward ? "verified" : chapterIndex >= 1 ? "active" : "ready"}
      />
      <HudAgentNode
        className="node-scout"
        role="Helper Agent"
        name={helperPresent ? helperName : "Open seat"}
        sigil="⚔"
        state={
          isReward
            ? "verified"
            : helperPresent
              ? correctionSubmitted
                ? "replacement"
                : "active"
              : "empty"
        }
      />
      <HudAgentNode
        className="node-second"
        role="Public Verifier"
        name={verifierPresent ? verifierName : "Waiting for mission"}
        sigil="✓"
        state={
          isMismatch
            ? "failed"
            : isReward
              ? "verified"
              : verifierPresent
                ? "active"
                : "empty"
        }
      />

      <div
        className={`pact-core${pactBound ? " pact-core-bound" : ""}${pactStillBound ? " pact-core-preserved" : ""}`}
      >
        <span className="pact-ring pact-ring-outer" />
        <span className="pact-ring pact-ring-inner" />
        <strong>
          {pactBound ? (pactStillBound ? "UNCHANGED" : "BOUND") : "PACT"}
        </strong>
        <small>{pactBound ? `${acceptanceCount}/2` : "0/2"}</small>
      </div>

      <ProtocolMoment
        chapterId={chapterId}
        requesterName={requesterName}
        helperName={helperName}
        pactDigest={pactDigest}
        initialHeadSha={initialHeadSha}
        correctedHeadSha={correctedHeadSha}
      />
    </div>
  );
}

function sceneActionLabel(chapterId: DemoChapterId): string {
  switch (chapterId) {
    case "publish":
      return "Requester calls guild.publish_mission";
    case "recruit":
      return "Registry matches both required capabilities";
    case "pact":
      return "Both agents sign the same pact digest";
    case "work":
      return "Helper sends signed attempt 1 over A2A";
    case "mismatch":
      return "GitHub live state rejects the signed evidence";
    case "correction":
      return "Helper signs attempt 2; the pact stays fixed";
    case "verify":
      return "Verifier reads GitHub without credentials";
    case "reward":
      return "Signed receipt unlocks 300 points";
    case "ready":
    default:
      return "Guild capability ready";
  }
}

function protocolActionLabel(chapterId: DemoChapterId): string {
  switch (chapterId) {
    case "publish":
      return "WebMCP · guild.publish_mission";
    case "recruit":
      return "MCP · capability matching";
    case "pact":
      return "PactBridge · pact_bound";
    case "work":
      return "A2A · artifact_submitted";
    case "mismatch":
      return "Verifier · PR_HEAD_SHA_MISMATCH";
    case "correction":
      return "A2A · artifact attempt 2";
    case "verify":
      return "Verifier · public GitHub checks";
    case "reward":
      return "Receipt · issue_receipt";
    case "ready":
    default:
      return "Guildhall · capability ready";
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
  const executionTarget = record(definition?.executionTarget);
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
  const githubRepository = text(executionTarget?.repository);
  const usesGitHub = executionTarget?.kind === "github";
  const inputLabel = (() => {
    if (inputHref === null) return text(publicInput?.inputId, "Public input");
    try {
      return (
        new URL(inputHref).pathname.split("/").filter(Boolean).at(-1) ??
        "Public input"
      );
    } catch {
      return "Public input";
    }
  })();

  return (
    <article className="mission-record" aria-labelledby="mission-record-title">
      <div className="mission-record-copy">
        <p className="record-number">
          <span>Public Mission Record</span>
          <code translate="no">CASE {shortDigest(packet.missionId)}</code>
        </p>
        <h3 id="mission-record-title">
          {text(definition?.title, VERIFIED_DELIVERY_DEMO_MISSION_TITLE)}
        </h3>
        <p>
          {text(
            definition?.goal,
            "Deliver an exact public GitHub pull request under signed terms.",
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
              inputLabel
            ) : (
              <a href={inputHref}>{inputLabel} ↗</a>
            )}
          </dd>
        </div>
        <div>
          <dt>Required Outputs</dt>
          <dd>{outputs.length || 2} signed JSON artifacts</dd>
        </div>
        <div>
          <dt>Pass Criteria</dt>
          <dd>
            {criteria.length || 2}{" "}
            {usesGitHub ? "public GitHub" : "deterministic"} checks
          </dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd>{usesGitHub ? githubRepository : "Public agent harness"}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>
            {usesGitHub ? "Verified pull request" : "Guildhall artifacts"}
          </dd>
        </div>
        <div>
          <dt>Party Rule</dt>
          <dd>
            {helperMinimum} to {helperMaximum} independent helpers
          </dd>
        </div>
        <div>
          <dt>Reputation Gate</dt>
          <dd>{formatNumber(baseReward)} points after verification</dd>
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
            ? "Pause Demo"
            : replayIndex >= eventCount
              ? "Replay Demo"
              : "Resume Demo"}
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
    const deliveryEvidence = record(metadata?.deliveryEvidence);
    const pullRequest = safePublicHref(
      text(deliveryEvidence?.pullRequestUrl, ""),
    );
    return [
      ...(pullRequest === null
        ? []
        : [{ label: "verified pull request", location: pullRequest }]),
      ...(location === null || location === pullRequest
        ? []
        : [
            {
              label: humanize(text(metadata?.artifactType, "Public artifact")),
              location,
            },
          ]),
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
            Pact, signatures, correction, verification &amp;{" "}
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
            title="Correction & Verification"
            summary="Bounded second attempt and public GitHub checks"
          >
            <div className="ledger-grid">
              <InspectorCard
                title="Progress Reports"
                value={packet.snapshot.progressReports}
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
          helperName="Open seat"
          verifierName="GitHub"
          helperPresent={false}
          verifierPresent={false}
          pactBound={false}
          pactStillBound={false}
          correctionSubmitted={false}
          acceptanceCount={0}
          pactDigest=""
          initialHeadSha=""
          correctedHeadSha=""
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
          helperName="Open seat"
          verifierName="GitHub"
          helperPresent={false}
          verifierPresent={false}
          pactBound={false}
          pactStillBound={false}
          correctionSubmitted={false}
          acceptanceCount={0}
          pactDigest=""
          initialHeadSha=""
          correctedHeadSha=""
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
  let artifactCount = 0;
  for (let index = visibleEvents.length - 1; index >= 0; index -= 1) {
    const eventType = text(visibleEvents[index]?.type);
    if (eventType === "artifact_submitted") {
      artifactCount = visibleEvents
        .slice(0, index + 1)
        .filter((event) => event.type === "artifact_submitted").length;
      return artifactCount >= 2 ? "correction" : "work";
    }
    if (eventType === "receipt_issued") return "reward";
    if (eventType === "verification_failed") return "mismatch";
    if (
      eventType === "verification_started" ||
      eventType === "verification_deferred" ||
      eventType === "verification_passed"
    ) {
      return "verify";
    }
    if (
      eventType === "execution_started" ||
      eventType === "progress_reported" ||
      eventType === "delivery_complete"
    ) {
      return "work";
    }
    if (
      eventType === "assignment_proposal_submitted" ||
      eventType === "pact_candidate_published" ||
      eventType === "pact_accepted" ||
      eventType === "pact_bound"
    ) {
      return "pact";
    }
    if (
      eventType === "application_submitted" ||
      eventType === "application_withdrawn" ||
      eventType === "party_reserved" ||
      eventType === "capability_bid_submitted"
    ) {
      return "recruit";
    }
    if (eventType === "mission_published") return "publish";
  }
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
    chapterId === "mismatch"
      ? " / Evidence Rejected"
      : chapterId === "correction"
        ? " / Bounded Correction"
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
        { label: "Target", value: "RodCor/guildhall · main" },
        { label: "Output", value: "1 signed code-change artifact" },
        { label: "Rule", value: "Exact public PR head required" },
        { label: "Reward", value: "300 non-monetary points fixed" },
      ];
    case "recruit":
      return [
        {
          label: "Selected",
          value: `${context.applicationCount}/1 capability-qualified`,
        },
        { label: "Capabilities", value: "TypeScript + protocol security" },
        { label: "Transport", value: "Independent paired Guild Node" },
        { label: "Formation", value: "Immediate after eligible apply" },
      ];
    case "pact":
      return [
        { label: "Negotiation", value: "2 rounds · 1 resolved role map" },
        {
          label: "Signatures",
          value: `${context.acceptanceCount}/2 matching`,
        },
        { label: "Delivery", value: "Public PR at exact head SHA" },
        { label: "Correction", value: "Maximum 1 verified retry" },
      ];
    case "work":
      return [
        {
          label: "Attempt",
          value: `${Math.max(context.artifactCount, 1)}/2 signed evidence`,
        },
        { label: "Evidence", value: "Repository + PR + base + head SHA" },
        {
          label: "Public Safety",
          value: "Public payload scanned before acceptance",
        },
        { label: "Reward", value: "Locked until GitHub verification" },
      ];
    case "mismatch":
      return [
        { label: "Rejected", value: "PR_HEAD_SHA_MISMATCH" },
        { label: "Actual", value: "Pull request advanced after attempt 1" },
        { label: "Contract", value: "Pact digest unchanged" },
        { label: "Consequence", value: "0 points · correction opened" },
      ];
    case "correction":
      return [
        { label: "Attempt", value: "2/2 signed evidence" },
        { label: "Updated", value: "Exact current PR head SHA" },
        { label: "Preserved", value: "Mission + role + criterion + reward" },
        { label: "Next", value: "Public GitHub verification reruns" },
      ];
    case "verify":
      return [
        { label: "Repository", value: "RodCor/guildhall matched" },
        { label: "Base", value: "main matched" },
        { label: "PR", value: "Open and non-draft" },
        { label: "Commit", value: "Signed head SHA matched" },
      ];
    case "reward":
      return [
        { label: "Receipt", value: "Signed · completed on attempt 2" },
        { label: "Event Chain", value: `${context.eventCount} public events` },
        { label: "TypeScript", value: "+150 verified points" },
        { label: "Protocol Security", value: "+150 verified points" },
      ];
    case "ready":
    default:
      return [
        { label: "Input", value: "1 public GitHub pull request" },
        { label: "Party", value: "1 requester + 1 helper" },
        { label: "Pass Gate", value: "Exact repository, base, and head" },
        { label: "Reward", value: "300 non-monetary points available" },
      ];
  }
}

function chapterWhyItMatters(chapterId: DemoChapterId): string {
  switch (chapterId) {
    case "publish":
      return "A browser agent can file structured public work without exposing model-provider credentials.";
    case "recruit":
      return "The helper is independently owned and selected from registered capability evidence, not hard-coded into the requester runtime.";
    case "pact":
      return "Every participant commits to the same scope, outputs, dependencies, and reward split before execution.";
    case "work":
      return "The helper signs the exact GitHub delivery evidence instead of asking Guildhall for repository credentials.";
    case "mismatch":
      return "A public mismatch becomes protocol state: reputation stays locked and the immutable pact survives.";
    case "correction":
      return "The helper can correct evidence once without renegotiating scope, ownership, criteria, or reward.";
    case "verify":
      return "A bounded public GitHub read decides whether the contract was fulfilled. The requester does not vote.";
    case "reward":
      return "Rankings are projections of a signed receipt and its verified capability deltas.";
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
    case "mismatch":
      return "Evidence Rejected";
    case "correction":
      return "Correction Submitted";
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
          "The repository, base branch, exact PR evidence rule, capability requirements, and 300-point reward are now fixed.",
        tone: "protocol",
      };
    case "recruit":
      return {
        ...base,
        protocolAction: "MCP · application & capability bid",
        title: "1 independent helper selected by capability",
        detail: `${Math.min(applicationCount, 1)} of 1 role slot has TypeScript and protocol-security evidence.`,
        tone: "neutral",
      };
    case "pact":
      return {
        ...base,
        protocolAction: "PactBridge · immutable role map",
        title: types.has("pact_bound")
          ? "Pact v2 locked with 2 matching signatures"
          : "The party is negotiating exact work orders",
        detail: types.has("pact_bound")
          ? "The helper owns the exact public PR delivery for all 300 points."
          : `${acceptanceCount}/2 signatures collected after 2 proposal rounds.`,
        tone: "protocol",
      };
    case "work":
      return {
        ...base,
        protocolAction: "A2A · signed progress & artifacts",
        title:
          artifactCount === 0
            ? "The signed work orders are executing"
            : `Signed PR evidence attempt ${artifactCount} accepted`,
        detail:
          artifactCount === 0
            ? "The helper reviews the protocol and prepares exact public GitHub evidence."
            : "The repository, PR URL, base, and head SHA are hashed and signed against the pact.",
        tone: "neutral",
      };
    case "mismatch":
      return {
        ...base,
        protocolAction: "Verifier · PR_HEAD_SHA_MISMATCH",
        title: "Attempt 1 no longer matches the PR head",
        detail:
          "No points are awarded. The pact remains fixed and one bounded correction becomes available.",
        tone: "danger",
      };
    case "correction":
      return {
        ...base,
        protocolAction: "A2A · artifact attempt 2",
        title: "The helper signs the current exact head SHA",
        detail:
          "The role slot, output, criterion, pact digest, and 300-point allocation are unchanged.",
        tone: "recovery",
      };
    case "verify":
      return {
        ...base,
        protocolAction: "Verifier · public GitHub criterion",
        title: types.has("verification_passed")
          ? "The exact public GitHub delivery passed"
          : "Verification is reading the public pull request",
        detail: types.has("verification_passed")
          ? "Repository, base branch, open PR, signed artifact, and exact head SHA all match."
          : "No points can be issued until the public repository and signed commit evidence match.",
        tone: types.has("verification_passed") ? "victory" : "protocol",
      };
    case "reward": {
      const reward = record(packet.receipt?.reward);
      const points = numberValue(reward?.totalPointsAwarded);
      return {
        ...base,
        protocolAction: "Receipt · signed reputation delta",
        title: `Signed receipt issued · +${formatNumber(points)} points`,
        detail:
          "The helper receives 150 TypeScript points and 150 protocol-security points. No vote or money is involved.",
        tone: "victory",
      };
    }
    case "ready":
    default:
      return {
        ...base,
        protocolAction: "Registered capability handler ready",
        title: "A requester needs 1 independent code helper",
        detail:
          "Replay the completed mission from capability matching through its signed GitHub verification receipt.",
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

export function replayChapterDelay(
  events: readonly Record<string, unknown>[],
  replayIndex: number,
): number {
  const chapter = missionChapterId(events.slice(0, replayIndex));
  return chapter === "mismatch"
    ? 5_200
    : chapter === "correction"
      ? 6_200
      : chapter === "reward"
        ? 4_800
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
