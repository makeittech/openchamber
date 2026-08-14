import { describe, expect, test } from 'bun:test';
import { dayKeyFromMs } from './usagePeriodStats';
import { loadUsageHistory, resetUsageHistoryCache } from './useUsageHistory';

const NOW = Date.now();
const TODAY = dayKeyFromMs(NOW);
const MIN_DAY = '2020-01-01';

const session = (id: string, updated: number = NOW) => ({ id, time: { created: updated, updated } });

const assistant = (providerID: string, ms: number, tokens = 10, cost = 0.5) => ({
  role: 'assistant',
  providerID,
  cost,
  tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: ms, completed: ms },
});

const user = (ms: number) => ({ role: 'user', time: { created: ms } });
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('loadUsageHistory', () => {
  test('aggregates assistant usage per day and provider, ignoring other roles', async () => {
    resetUsageHistoryCache();
    const snapshot = await loadUsageHistory([session('ses_1')], MIN_DAY, {
      fetcher: async () => [
        user(NOW),
        assistant('CodeCommander', NOW),
        assistant('codecommander', NOW, 5, 0.25),
        assistant('openrouter', NOW, 0, 0),
      ],
    });

    expect(snapshot.status).toBe('ready');
    expect(snapshot.records).toHaveLength(2);
    const codeCommander = snapshot.records.find((record) => record.providerId === 'codecommander');
    const openRouter = snapshot.records.find((record) => record.providerId === 'openrouter');
    expect(codeCommander?.dayKey).toBe(TODAY);
    expect(codeCommander?.tokens).toBe(15);
    expect(codeCommander?.cost).toBe(0.75);
    expect(codeCommander?.requests).toBe(2);
    expect(openRouter?.tokens).toBe(0);
    expect(openRouter?.requests).toBe(1);
    expect(snapshot.providerNames.get('codecommander')).toBe('CodeCommander');
  });

  test('skips refetching sessions whose updated stamp is unchanged', async () => {
    resetUsageHistoryCache();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [assistant('xai', NOW)];
    };
    const sessions = [session('ses_1')];
    await loadUsageHistory(sessions, MIN_DAY, { fetcher });
    await loadUsageHistory(sessions, MIN_DAY, { fetcher });
    expect(calls).toBe(1);

    // An updated stamp marks new activity and triggers a refetch that replaces records.
    const bumped = [session('ses_1', NOW + 1000)];
    const next = await loadUsageHistory(bumped, MIN_DAY, {
      fetcher: async () => [assistant('xai', NOW, 20, 1)],
    });
    expect(next.records[0]?.tokens).toBe(20);
    expect(next.records[0]?.cost).toBe(1);
  });

  test('does not double count a message repeated across cursor pages', async () => {
    resetUsageHistoryCache();
    const repeated = { ...assistant('claude', NOW), id: 'msg_1' };
    const snapshot = await loadUsageHistory([session('ses_1')], MIN_DAY, {
      fetcher: async () => [repeated, repeated],
    });

    expect(snapshot.records[0]?.requests).toBe(1);
    expect(snapshot.records[0]?.tokens).toBe(10);
  });

  test('keeps good sessions when another one fails and reports partial', async () => {
    resetUsageHistoryCache();
    const snapshot = await loadUsageHistory([session('good'), session('bad')], MIN_DAY, {
      fetcher: async ({ id }) => {
        if (id === 'bad') throw new Error('boom');
        return [assistant('deepseek', NOW)];
      },
    });

    expect(snapshot.status).toBe('partial');
    expect(snapshot.records.map((record) => record.providerId)).toEqual(['deepseek']);

    // A retry run refetches only the failed session.
    let retriedBad = false;
    const retried = await loadUsageHistory([session('good'), session('bad')], MIN_DAY, {
      fetcher: async ({ id }) => {
        if (id === 'bad') {
          retriedBad = true;
          return [assistant('crof', NOW, 5, 0.1)];
        }
        return [assistant('deepseek', NOW)];
      },
    });
    expect(retriedBad).toBe(true);
    expect(retried.status).toBe('ready');
    expect(retried.records).toHaveLength(2);
  });

  test('drops sessions that disappeared from the global list', async () => {
    resetUsageHistoryCache();
    const fetcher = async () => [assistant('xai', NOW)];
    await loadUsageHistory([session('ses_1'), session('ses_2')], MIN_DAY, { fetcher });
    const snapshot = await loadUsageHistory([session('ses_1')], MIN_DAY, { fetcher });
    const dayBuckets = snapshot.records.filter((record) => record.dayKey === TODAY);
    expect(dayBuckets).toHaveLength(1);
  });

  test('does not let an older in-flight load resurrect an authoritatively removed session', async () => {
    resetUsageHistoryCache();
    const fetchGate = deferred();
    const fetchStarted = deferred();
    const first = loadUsageHistory([session('ses_1')], MIN_DAY, {
      fetcher: async () => {
        fetchStarted.resolve();
        await fetchGate.promise;
        return [assistant('xai', NOW)];
      },
    });
    await fetchStarted.promise;
    const removed = loadUsageHistory([], MIN_DAY);
    fetchGate.resolve();

    await first;
    expect((await removed).records).toHaveLength(0);
    expect((await loadUsageHistory([], MIN_DAY)).records).toHaveLength(0);
  });

  test('rejects a completion invalidated by cache reset', async () => {
    resetUsageHistoryCache();
    const fetchGate = deferred();
    const fetchStarted = deferred();
    const pending = loadUsageHistory([session('ses_1')], MIN_DAY, {
      fetcher: async () => {
        fetchStarted.resolve();
        await fetchGate.promise;
        return [assistant('xai', NOW)];
      },
    });
    await fetchStarted.promise;
    resetUsageHistoryCache();
    fetchGate.resolve();

    expect((await pending).status).toBe('idle');
    expect((await loadUsageHistory([], MIN_DAY)).records).toHaveLength(0);
  });

  test('keys equal session IDs by directory and preserves missing cache for incomplete lists', async () => {
    resetUsageHistoryCache();
    const sessions = [
      { ...session('same'), directory: '/one' },
      { ...session('same'), directory: '/two' },
    ];
    const first = await loadUsageHistory(sessions, MIN_DAY, {
      fetcher: async ({ directory }) => [
        assistant(directory === '/one' ? 'claude' : 'openrouter', NOW),
      ],
    });
    expect(first.records).toHaveLength(2);

    const partial = await loadUsageHistory([sessions[0]], MIN_DAY, {
      completeSessionList: false,
      fetcher: async () => [],
    });
    expect(partial.records).toHaveLength(2);
  });
});
