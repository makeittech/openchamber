import { beforeEach, describe, expect, mock, test } from 'bun:test';

let harnessClaudeAgentsCalls: Array<string | undefined> = [];
let harnessClaudeAgentsImpl: (directory?: string) => Promise<unknown> = async () => ({
  agents: [],
  roots: { user: null, project: null },
});

class FakeHarnessClientError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

let harnessSessionBindingCalls: string[] = [];
let harnessSessionBindingImpl: (sessionId: string) => Promise<unknown> = async () => null;

mock.module('@/lib/harness/client', () => ({
  harnessClaudeAgents: async (directory?: string) => {
    harnessClaudeAgentsCalls.push(directory);
    return harnessClaudeAgentsImpl(directory);
  },
  harnessSessionBinding: async (sessionId: string) => {
    harnessSessionBindingCalls.push(sessionId);
    return harnessSessionBindingImpl(sessionId);
  },
  HarnessClientError: FakeHarnessClientError,
}));

const { useClaudeAgentsStore } = await import('./useClaudeAgentsStore');

const agent = (name: string) => ({
  name,
  description: `${name} description`,
  model: '',
  source: 'project' as const,
});

beforeEach(() => {
  harnessClaudeAgentsCalls = [];
  harnessClaudeAgentsImpl = async () => ({ agents: [], roots: { user: null, project: null } });
  harnessSessionBindingCalls = [];
  harnessSessionBindingImpl = async () => null;
  useClaudeAgentsStore.getState().reset();
});

describe('useClaudeAgentsStore.load', () => {
  test('stores the fetched agents per directory and forwards the directory', async () => {
    harnessClaudeAgentsImpl = async () => ({
      agents: [agent('reviewer')],
      roots: { user: null, project: '/repo/.claude/agents' },
    });

    await useClaudeAgentsStore.getState().load('/repo');

    expect(harnessClaudeAgentsCalls).toEqual(['/repo']);
    expect(useClaudeAgentsStore.getState().getAgents('/repo').map((a) => a.name)).toEqual(['reviewer']);
    // A different directory has its own scope and is still empty.
    expect(useClaudeAgentsStore.getState().getAgents('/other')).toEqual([]);
  });

  test('returns a referentially stable empty list for unknown directories', () => {
    const first = useClaudeAgentsStore.getState().getAgents('/nope');
    const second = useClaudeAgentsStore.getState().getAgents('/also-nope');
    // React selectors depend on this; a fresh [] each call would re-render forever.
    expect(first).toBe(second);
  });

  test('a fetch failure keeps the previously loaded agents instead of clearing them', async () => {
    harnessClaudeAgentsImpl = async () => ({
      agents: [agent('reviewer')],
      roots: { user: null, project: '/repo/.claude/agents' },
    });
    await useClaudeAgentsStore.getState().load('/repo');

    harnessClaudeAgentsImpl = async () => {
      throw new FakeHarnessClientError('offline', 'HARNESS_NETWORK');
    };
    await useClaudeAgentsStore.getState().load('/repo', { force: true });

    // Failure must not masquerade as "this project has no agents".
    expect(useClaudeAgentsStore.getState().getAgents('/repo').map((a) => a.name)).toEqual(['reviewer']);
  });

  test('a failed load is retried on the next call instead of being cached as fresh', async () => {
    harnessClaudeAgentsImpl = async () => {
      throw new FakeHarnessClientError('offline', 'HARNESS_NETWORK');
    };
    await useClaudeAgentsStore.getState().load('/repo');
    expect(harnessClaudeAgentsCalls.length).toBe(1);

    harnessClaudeAgentsImpl = async () => ({
      agents: [agent('reviewer')],
      roots: { user: null, project: null },
    });
    await useClaudeAgentsStore.getState().load('/repo');

    expect(harnessClaudeAgentsCalls.length).toBe(2);
    expect(useClaudeAgentsStore.getState().getAgents('/repo').map((a) => a.name)).toEqual(['reviewer']);
  });

  test('a fresh successful load is not refetched, but force bypasses the window', async () => {
    harnessClaudeAgentsImpl = async () => ({ agents: [agent('reviewer')], roots: { user: null, project: null } });

    await useClaudeAgentsStore.getState().load('/repo');
    await useClaudeAgentsStore.getState().load('/repo');
    expect(harnessClaudeAgentsCalls.length).toBe(1);

    await useClaudeAgentsStore.getState().load('/repo', { force: true });
    expect(harnessClaudeAgentsCalls.length).toBe(2);
  });

  test('concurrent loads for the same directory share one request', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    harnessClaudeAgentsImpl = () => new Promise((resolve) => { resolveFetch = resolve; });

    const first = useClaudeAgentsStore.getState().load('/repo');
    const second = useClaudeAgentsStore.getState().load('/repo');
    resolveFetch?.({ agents: [agent('reviewer')], roots: { user: null, project: null } });
    await Promise.all([first, second]);

    expect(harnessClaudeAgentsCalls.length).toBe(1);
  });
});

describe('useClaudeAgentsStore selection', () => {
  test('selection is scoped per session', () => {
    const store = useClaudeAgentsStore.getState();
    store.select('ses_a', 'Explore');
    store.select('ses_b', 'Plan');

    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('Explore');
    expect(useClaudeAgentsStore.getState().getSelected('ses_b')).toBe('Plan');
    expect(useClaudeAgentsStore.getState().getSelected('ses_missing')).toBe('');
  });

  test('selecting a blank name clears the session back to Claude default', () => {
    useClaudeAgentsStore.getState().select('ses_a', 'Explore');
    useClaudeAgentsStore.getState().select('ses_a', '   ');

    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('');
    // The key is removed, not left as an empty string.
    expect(Object.keys(useClaudeAgentsStore.getState().selectedBySessionId)).toEqual([]);
  });

  test('re-selecting the same name does not produce a new state object', () => {
    useClaudeAgentsStore.getState().select('ses_a', 'Explore');
    const before = useClaudeAgentsStore.getState().selectedBySessionId;
    useClaudeAgentsStore.getState().select('ses_a', 'Explore');

    expect(useClaudeAgentsStore.getState().selectedBySessionId).toBe(before);
  });

  test('hydrateSelection restores the agent the server recorded for the session', async () => {
    harnessSessionBindingImpl = async () => ({
      sessionId: 'ses_a',
      harnessId: 'claude-code',
      claudeAgentName: 'Explore',
    });

    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');

    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('Explore');
    expect(harnessSessionBindingCalls).toEqual(['ses_a']);
  });

  test('hydrateSelection never overwrites a pick made in this tab', async () => {
    useClaudeAgentsStore.getState().select('ses_a', 'Plan');
    harnessSessionBindingImpl = async () => ({
      sessionId: 'ses_a',
      harnessId: 'claude-code',
      claudeAgentName: 'Explore',
    });

    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');

    // The live pick is the newer authority; the binding is only a fallback.
    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('Plan');
    expect(harnessSessionBindingCalls).toEqual([]);
  });

  test('hydrateSelection runs at most once per session', async () => {
    harnessSessionBindingImpl = async () => null;

    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');
    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');

    expect(harnessSessionBindingCalls).toEqual(['ses_a']);
  });

  test('a missing binding or a failed lookup leaves the selection untouched', async () => {
    harnessSessionBindingImpl = async () => null;
    await useClaudeAgentsStore.getState().hydrateSelection('ses_missing');
    expect(useClaudeAgentsStore.getState().getSelected('ses_missing')).toBe('');

    // A binding with no recorded Claude agent is not evidence of "default".
    harnessSessionBindingImpl = async () => ({ sessionId: 'ses_b', harnessId: 'claude-code' });
    await useClaudeAgentsStore.getState().hydrateSelection('ses_b');
    expect(useClaudeAgentsStore.getState().getSelected('ses_b')).toBe('');
    expect(Object.keys(useClaudeAgentsStore.getState().selectedBySessionId)).toEqual([]);
  });

  test('an empty session id is ignored rather than creating a bogus entry', () => {
    useClaudeAgentsStore.getState().select('', 'Explore');
    useClaudeAgentsStore.getState().select(null, 'Explore');

    expect(useClaudeAgentsStore.getState().selectedBySessionId).toEqual({});
    expect(useClaudeAgentsStore.getState().getSelected(null)).toBe('');
  });
});
