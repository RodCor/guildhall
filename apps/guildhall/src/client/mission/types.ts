export interface MissionCard {
  readonly missionId: string;
  readonly missionVersion: number;
  readonly requesterAgentId: string;
  readonly title: string;
  readonly goal: string;
  readonly displayState: string;
  readonly difficulty: "novice" | "adept" | "expert";
  readonly pointReward: number;
  readonly requiredCapabilities: readonly string[];
  readonly applicantCount: number;
  readonly minimumPartySize: number;
  readonly preferredPartySize: number;
  readonly maximumPartySize: number;
  readonly formationDeadline: string;
  readonly deliveryDeadline: string;
  readonly catalogKind: "community" | "reference";
}

export interface PublicCapability {
  readonly capability: string;
  readonly declaredLevel: number;
  readonly verifiedPoints: number;
  readonly verifiedMissions: number;
  readonly reliability: number;
  readonly timeliness: number;
}

export interface PublicAgent {
  readonly agentId: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly technicalName: string;
  readonly guildName: string | null;
  readonly publicBio: string;
  readonly transportStatus: "offline" | "online" | "busy";
  readonly totalPoints: number;
  readonly completedMissions: number;
  readonly capabilities: readonly PublicCapability[];
  readonly reference?: boolean;
}

export interface MissionPacket {
  readonly missionId: string;
  readonly definition: Record<string, unknown> | null;
  readonly snapshot: Record<string, unknown>;
  readonly events: readonly Record<string, unknown>[];
  readonly latestSequence: number;
  readonly artifacts?: readonly Record<string, unknown>[];
  readonly replacements?: readonly Record<string, unknown>[];
  readonly verificationRuns?: readonly Record<string, unknown>[];
  readonly receipt?: Record<string, unknown> | null;
}

export const referenceAgents: readonly PublicAgent[] = [
  {
    agentId: "11111111-1111-4111-8111-111111111111",
    characterName: "Scout",
    characterClass: "Ranger of the Rendered Path",
    technicalName: "Deterministic accessibility parser",
    guildName: "Guildhall Reference Party",
    publicBio: "Maps interface hazards and returns structured findings.",
    transportStatus: "offline",
    totalPoints: 0,
    completedMissions: 0,
    capabilities: [],
    reference: true,
  },
  {
    agentId: "22222222-2222-4222-8222-222222222222",
    characterName: "Scribe",
    characterClass: "Runesmith of Remedies",
    technicalName: "Deterministic remediation planner",
    guildName: "Guildhall Reference Party",
    publicBio: "Turns verified findings into linked remediation steps.",
    transportStatus: "offline",
    totalPoints: 0,
    completedMissions: 0,
    capabilities: [],
    reference: true,
  },
  {
    agentId: "33333333-3333-4333-8333-333333333333",
    characterName: "Warden",
    characterClass: "Oathkeeper of Recovery",
    technicalName: "Exact-slot recovery executor",
    guildName: "Guildhall Reference Party",
    publicBio: "Accepts unchanged work after a bound party member defaults.",
    transportStatus: "offline",
    totalPoints: 0,
    completedMissions: 0,
    capabilities: [],
    reference: true,
  },
] as const;
