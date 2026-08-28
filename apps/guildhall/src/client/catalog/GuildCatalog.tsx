import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { MissionCard, PublicAgent } from "../mission/types";

interface MissionListResponse {
  readonly missions: readonly MissionCard[];
}

interface AgentListResponse {
  readonly agents: readonly PublicAgent[];
}

interface GuildCatalogValue {
  readonly missions: readonly MissionCard[];
  readonly referenceMissions: readonly MissionCard[];
  readonly agents: readonly PublicAgent[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refreshedAt: number | null;
  readonly refresh: () => void;
}

const GuildCatalogContext = createContext<GuildCatalogValue | null>(null);

export function GuildCatalogProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [missions, setMissions] = useState<readonly MissionCard[]>([]);
  const [referenceMissions, setReferenceMissions] = useState<
    readonly MissionCard[]
  >([]);
  const [agents, setAgents] = useState<readonly PublicAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(
    () => setRefreshVersion((value) => value + 1),
    [],
  );

  useEffect(() => {
    const lifetime = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      loadJson<MissionListResponse>(
        "/api/missions?limit=50&catalogKind=community",
        lifetime.signal,
      ),
      loadJson<MissionListResponse>(
        "/api/missions?limit=1&catalogKind=reference",
        lifetime.signal,
      ),
      loadJson<AgentListResponse>("/api/agents?limit=50", lifetime.signal),
    ])
      .then(([community, reference, registry]) => {
        if (lifetime.signal.aborted) return;
        setMissions(community.missions);
        setReferenceMissions(reference.missions);
        setAgents(registry.agents);
        setRefreshedAt(Date.now());
      })
      .catch((reason: unknown) => {
        if (lifetime.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The guild catalog is unavailable.",
        );
      })
      .finally(() => {
        if (!lifetime.signal.aborted) setLoading(false);
      });
    return () => lifetime.abort();
  }, [refreshVersion]);

  const value = useMemo<GuildCatalogValue>(
    () => ({
      missions,
      referenceMissions,
      agents,
      loading,
      error,
      refreshedAt,
      refresh,
    }),
    [agents, error, loading, missions, referenceMissions, refresh, refreshedAt],
  );

  return (
    <GuildCatalogContext.Provider value={value}>
      {children}
    </GuildCatalogContext.Provider>
  );
}

export function useGuildCatalog(): GuildCatalogValue {
  const value = useContext(GuildCatalogContext);
  if (value === null) {
    throw new Error("useGuildCatalog must be used inside GuildCatalogProvider");
  }
  return value;
}

async function loadJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Guild catalog request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}
