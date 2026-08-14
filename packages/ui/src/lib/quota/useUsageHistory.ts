import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { opencodeClient } from '@/lib/opencode/client';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { mapWithConcurrency } from '@/lib/concurrency';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getAllSyncSessions, getSyncSessionDirectory } from '@/sync/sync-refs';
import {
  ensureGlobalSessionsLoaded,
  refreshGlobalSessions,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import {
  aggregateUsageRecords,
  dayKeyFromMs,
  sessionTokenTotal,
  type UsageHistoryRecord,
} from './usagePeriodStats';

type UsageHistoryStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'error';
type UsageSessionSourceStatus = 'idle' | 'loading' | 'ready' | 'error';

interface UsageHistorySnapshot {
  records: UsageHistoryRecord[];
  providerNames: Map<string, string>;
  status: UsageHistoryStatus;
}

interface SessionLike {
  id?: string;
  directory?: string | null;
  project?: { worktree?: string | null } | null;
  time?: { created?: number | null; updated?: number | null } | null;
}

type UsageMessage = {
  id?: string;
  role?: string;
  providerID?: string | null;
  cost?: number | null;
  tokens?: Parameters<typeof sessionTokenTotal>[0];
  time?: { created?: number | null; completed?: number | null } | null;
};

type SessionUsageFetcher = (target: { id: string; directory: string | null }) => Promise<readonly UsageMessage[]>;

interface UsageRow {
  dayKey: string;
  /** Raw provider ID as reported by the message (case preserved for display). */
  providerId: string;
  cost: number;
  tokens: number;
  requests: number;
}

interface HistoryCache {
  /** runtime-local (directory, session id) → last fetched `time.updated` stamp */
  sessionStamps: Map<string, number>;
  /** runtime-local (directory, session id) → compact per-message usage rows */
  bySession: Map<string, UsageRow[]>;
  failedSessions: Set<string>;
}

const caches = new Map<string, HistoryCache>();
const runtimeQueues = new Map<string, Promise<void>>();
let cacheGeneration = 0;

/** Test-only: drop cached per-runtime history so cases stay isolated. */
export const resetUsageHistoryCache = (): void => {
  cacheGeneration += 1;
  caches.clear();
  runtimeQueues.clear();
};

subscribeRuntimeEndpointWillChange(resetUsageHistoryCache);

const USAGE_FETCH_CONCURRENCY = 4;
const USAGE_MESSAGE_PAGE_SIZE = 100;
const EMPTY_SNAPSHOT: UsageHistorySnapshot = { records: [], providerNames: new Map(), status: 'idle' };

const emptyCache = (): HistoryCache => ({
  sessionStamps: new Map(),
  bySession: new Map(),
  failedSessions: new Set(),
});

const sessionCacheKey = (sessionId: string, directory: string | null): string =>
  JSON.stringify([directory, sessionId]);

const snapshotFromCache = (cache: HistoryCache, minDayKey: string): UsageHistorySnapshot => {
  const rows: UsageRow[] = [];
  for (const records of cache.bySession.values()) {
    for (const record of records) {
      if (record.dayKey >= minDayKey) rows.push(record);
    }
  }
  const { records, providerNames } = aggregateUsageRecords(rows);
  const failed = cache.failedSessions.size > 0;
  const status: UsageHistoryStatus = failed && records.length === 0 ? 'error' : failed ? 'partial' : 'ready';
  return { records, providerNames, status };
};

const defaultFetcher: SessionUsageFetcher = async ({ id, directory }) => {
  const messages: UsageMessage[] = [];
  const visitedCursors = new Set<string>();
  let before: string | undefined;
  while (true) {
    const page = await runBackgroundNetworkTask(() => opencodeClient.getSessionMessagesPage(id, {
      limit: USAGE_MESSAGE_PAGE_SIZE,
      before,
      directory,
    }));
    messages.push(...page.messages.map((entry) => entry.info as unknown as UsageMessage));
    if (!page.cursor) return messages;
    if (visitedCursors.has(page.cursor)) throw new Error('Session usage pagination made no progress');
    visitedCursors.add(page.cursor);
    before = page.cursor;
  }
};

const usageRowsFromSession = (messages: readonly UsageMessage[]): UsageRow[] => {
  const rows = new Map<string, UsageRow>();
  const seenMessageIds = new Set<string>();
  for (const info of messages) {
    if (info?.role !== 'assistant') continue;
    const providerId = typeof info.providerID === 'string' ? info.providerID.trim() : '';
    const completed = info.time?.completed;
    const created = info.time?.created;
    const stamp = typeof completed === 'number' && Number.isFinite(completed)
      ? completed
      : typeof created === 'number' && Number.isFinite(created)
        ? created
        : null;
    if (!providerId || stamp === null) continue;
    if (info.id) {
      if (seenMessageIds.has(info.id)) continue;
      seenMessageIds.add(info.id);
    }
    const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) ? Math.max(0, info.cost) : 0;
    const tokens = Math.max(0, sessionTokenTotal(info.tokens ?? null));
    const dayKey = dayKeyFromMs(stamp);
    const key = JSON.stringify([dayKey, providerId.toLowerCase()]);
    const row = rows.get(key);
    if (row) {
      row.cost += cost;
      row.tokens += tokens;
      row.requests += 1;
    } else {
      // Every assistant message is a request, even when a provider omits cost/token accounting.
      rows.set(key, { dayKey, providerId, cost, tokens, requests: 1 });
    }
  }
  return Array.from(rows.values());
};

export const loadUsageHistory = async (
  sessions: readonly SessionLike[],
  minDayKey: string,
  options: { completeSessionList?: boolean; fetcher?: SessionUsageFetcher } = {},
): Promise<UsageHistorySnapshot> => {
  const runtimeKey = getRuntimeKey();
  const generation = cacheGeneration;
  const previous = runtimeQueues.get(runtimeKey) ?? Promise.resolve();
  // Serialize cache reconciliation per runtime: a stale completion must not
  // resurrect a session omitted by a newer authoritative list.
  const run = previous.catch(() => undefined).then(async (): Promise<UsageHistorySnapshot> => {
    if (generation !== cacheGeneration || getRuntimeKey() !== runtimeKey) return EMPTY_SNAPSHOT;
    const cache = caches.get(runtimeKey) ?? emptyCache();
    caches.set(runtimeKey, cache);
    // Old runtimes must not retain colliding session identities or message metadata.
    for (const key of caches.keys()) {
      if (key !== runtimeKey) caches.delete(key);
    }

    const minStamp = Date.parse(`${minDayKey}T00:00:00`);
    const seenKeys = new Set<string>();
    const sessionByKey = new Map<string, { session: SessionLike; id: string; directory: string | null }>();
    const staleKeys: string[] = [];

    for (const session of sessions) {
      const id = typeof session.id === 'string' ? session.id : '';
      if (!id) continue;
      const directory = resolveGlobalSessionDirectory(session);
      const key = sessionCacheKey(id, directory);
      seenKeys.add(key);
      sessionByKey.set(key, { session, id, directory });

      const updated = session.time?.updated ?? session.time?.created ?? null;
      if (typeof updated !== 'number' || !Number.isFinite(updated)) continue;
      // No activity inside the requested history window means no message can contribute.
      if (updated < minStamp) {
        cache.failedSessions.delete(key);
        continue;
      }
      if (cache.sessionStamps.get(key) !== updated || cache.failedSessions.has(key)) {
        staleKeys.push(key);
      }
    }

    // Only an authoritative global list may turn omission into deletion.
    if (options.completeSessionList !== false) {
      const cachedKeys = new Set([
        ...cache.bySession.keys(),
        ...cache.sessionStamps.keys(),
        ...cache.failedSessions,
      ]);
      for (const key of cachedKeys) {
        if (seenKeys.has(key)) continue;
        cache.bySession.delete(key);
        cache.sessionStamps.delete(key);
        cache.failedSessions.delete(key);
      }
    }

    const fetcher = options.fetcher ?? defaultFetcher;
    await mapWithConcurrency(staleKeys, USAGE_FETCH_CONCURRENCY, async (key) => {
      const target = sessionByKey.get(key);
      if (!target) return;
      const updated = target.session.time?.updated ?? target.session.time?.created ?? 0;
      try {
        const messages = await fetcher({ id: target.id, directory: target.directory });
        cache.bySession.set(key, usageRowsFromSession(messages));
        cache.sessionStamps.set(key, updated);
        cache.failedSessions.delete(key);
      } catch {
        // Preserve any older complete records for this session and expose partial authority.
        cache.failedSessions.add(key);
      }
    });

    if (generation !== cacheGeneration || getRuntimeKey() !== runtimeKey) return EMPTY_SNAPSHOT;
    return snapshotFromCache(cache, minDayKey);
  });
  const queueTail = run.then(() => undefined, () => undefined);
  runtimeQueues.set(runtimeKey, queueTail);

  try {
    return await run;
  } finally {
    if (runtimeQueues.get(runtimeKey) === queueTail) runtimeQueues.delete(runtimeKey);
  }
};

export const useUsageSessions = (refreshKey?: unknown): {
  sessions: Session[];
  status: UsageSessionSourceStatus;
  minimumDayKey: string;
  refresh: () => Promise<void>;
} => {
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const status = useGlobalSessionsStore((state) => state.status);

  React.useEffect(() => {
    if (status === 'idle') void ensureGlobalSessionsLoaded(getAllSyncSessions());
  }, [status]);

  const sessions = React.useMemo(() => {
    void refreshKey;
    const byIdentity = new Map<string, Session>();
    const knownDirectoriesById = new Map<string, Set<string>>();
    const add = (session: Session, directoryHint?: string | null) => {
      const ownDirectory = resolveGlobalSessionDirectory(session);
      const directory = ownDirectory ?? directoryHint ?? null;
      const resolvedSession = !ownDirectory && directory ? { ...session, directory } : session;
      const unknownKey = sessionCacheKey(session.id, null);
      if (!directory) {
        if ((knownDirectoriesById.get(session.id)?.size ?? 0) > 0) return;
        byIdentity.set(unknownKey, resolvedSession);
        return;
      }
      byIdentity.delete(unknownKey);
      const knownDirectories = knownDirectoriesById.get(session.id) ?? new Set<string>();
      knownDirectories.add(directory);
      knownDirectoriesById.set(session.id, knownDirectories);
      const key = sessionCacheKey(session.id, directory);
      byIdentity.set(key, resolvedSession);
    };
    for (const session of activeSessions) add(session);
    for (const session of archivedSessions) add(session);
    // Live child stores carry fresher `time.updated` and override their global snapshots.
    for (const session of getAllSyncSessions()) add(session, getSyncSessionDirectory(session.id));
    return Array.from(byIdentity.values());
  }, [activeSessions, archivedSessions, refreshKey]);

  const minimumDayKey = React.useMemo(() => {
    let earliest = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      const created = session.time?.created;
      if (typeof created === 'number' && Number.isFinite(created) && created > 0) {
        earliest = Math.min(earliest, created);
      }
    }
    return dayKeyFromMs(Math.min(Number.isFinite(earliest) ? earliest : Date.now(), Date.now()));
  }, [sessions]);

  const refresh = React.useCallback(async () => {
    await refreshGlobalSessions(getAllSyncSessions());
  }, []);

  return { sessions, status, minimumDayKey, refresh };
};

/** Visible usage surfaces re-aggregate over this snapshot; per-session fetch dedupe lives in the cache. */
export const useUsageHistory = (
  sessions: readonly SessionLike[],
  options: {
    minDayKey: string;
    refreshKey?: unknown;
    sourceStatus?: UsageSessionSourceStatus;
  },
): UsageHistorySnapshot => {
  const { minDayKey, refreshKey = null, sourceStatus = 'ready' } = options;
  const [snapshot, setSnapshot] = React.useState<UsageHistorySnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadUsageHistory(sessions, minDayKey, { completeSessionList: sourceStatus === 'ready' })
      .then((result) => {
        if (cancelled) return;
        setSnapshot(result);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSnapshot((current) => ({
          ...current,
          status: current.records.length > 0 ? 'partial' : 'error',
        }));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessions, minDayKey, refreshKey, sourceStatus]);

  return React.useMemo<UsageHistorySnapshot>(() => {
    if (loading || sourceStatus === 'idle' || sourceStatus === 'loading') {
      return { ...snapshot, status: 'loading' };
    }
    if (sourceStatus === 'error') {
      return { ...snapshot, status: snapshot.records.length > 0 ? 'partial' : 'error' };
    }
    return snapshot;
  }, [loading, snapshot, sourceStatus]);
};
