import { beforeEach, describe, expect, mock, test } from 'bun:test';

let agentCalls: Array<string | undefined> = [];
let bindingCalls: string[] = [];
let loadAgents: (directory?: string) => Promise<unknown>;
let loadBinding: (sessionId: string) => Promise<unknown>;

const actualClient = await import('@/lib/harness/client');

mock.module('@/lib/harness/client', () => ({
  ...actualClient,
  harnessClaudeAgents: async (directory?: string) => {
    agentCalls.push(directory);
    return loadAgents(directory);
  },
  harnessSessionBinding: async (sessionId: string) => {
    bindingCalls.push(sessionId);
    return loadBinding(sessionId);
  },
}));

const { useClaudeAgentsStore } = await import('./useClaudeAgentsStore');

const agent = (name: string) => ({
  name,
  description: `${name} description`,
  model: '',
  source: 'project' as const,
});
const agentsResult = (...names: string[]) => ({
  agents: names.map(agent),
  roots: { user: null, project: null },
});
const namesFor = (directory: string) =>
  useClaudeAgentsStore.getState().getAgents(directory).map(({ name }) => name);

beforeEach(() => {
  agentCalls = [];
  bindingCalls = [];
  loadAgents = async () => agentsResult();
  loadBinding = async () => null;
  useClaudeAgentsStore.getState().reset();
});

describe('useClaudeAgentsStore.load', () => {
  test('loads agents per directory and returns one stable empty list', async () => {
    loadAgents = async () => agentsResult('reviewer');
    await useClaudeAgentsStore.getState().load('/repo');

    expect(agentCalls).toEqual(['/repo']);
    expect(namesFor('/repo')).toEqual(['reviewer']);
    const firstEmpty = useClaudeAgentsStore.getState().getAgents('/other');
    expect(firstEmpty).toBe(useClaudeAgentsStore.getState().getAgents('/missing'));
  });

  test('failure preserves previous agents and is retried', async () => {
    loadAgents = async () => agentsResult('reviewer');
    await useClaudeAgentsStore.getState().load('/repo');

    loadAgents = async () => { throw new Error('offline'); };
    await useClaudeAgentsStore.getState().load('/repo', { force: true });
    expect(namesFor('/repo')).toEqual(['reviewer']);
    expect(useClaudeAgentsStore.getState().byDirectory['/repo']?.error).toBe('offline');

    loadAgents = async () => agentsResult('planner');
    await useClaudeAgentsStore.getState().load('/repo');
    expect(agentCalls).toHaveLength(3);
    expect(namesFor('/repo')).toEqual(['planner']);
  });

  test('fresh loads are cached unless forced', async () => {
    loadAgents = async () => agentsResult('reviewer');
    await useClaudeAgentsStore.getState().load('/repo');
    await useClaudeAgentsStore.getState().load('/repo');
    await useClaudeAgentsStore.getState().load('/repo', { force: true });
    expect(agentCalls).toHaveLength(2);
  });

  test('concurrent loads for one directory share a request', async () => {
    let resolveLoad: ((value: unknown) => void) | undefined;
    loadAgents = () => new Promise((resolve) => { resolveLoad = resolve; });

    const first = useClaudeAgentsStore.getState().load('/repo');
    const second = useClaudeAgentsStore.getState().load('/repo');
    resolveLoad?.(agentsResult('reviewer'));
    await Promise.all([first, second]);

    expect(agentCalls).toHaveLength(1);
  });
});

describe('useClaudeAgentsStore selection', () => {
  test('selection is session-scoped and blank selection clears its key', () => {
    const store = useClaudeAgentsStore.getState();
    store.select('ses_a', 'Explore');
    store.select('ses_b', 'Plan');
    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('Explore');
    expect(useClaudeAgentsStore.getState().getSelected('ses_b')).toBe('Plan');

    store.select('ses_a', '   ');
    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('');
    expect(Object.keys(useClaudeAgentsStore.getState().selectedBySessionId)).toEqual(['ses_b']);
  });

  test('reselecting the same agent preserves the selection map', () => {
    useClaudeAgentsStore.getState().select('ses_a', 'Explore');
    const before = useClaudeAgentsStore.getState().selectedBySessionId;
    useClaudeAgentsStore.getState().select('ses_a', 'Explore');
    expect(useClaudeAgentsStore.getState().selectedBySessionId).toBe(before);
  });

  test('empty session ids are ignored', () => {
    useClaudeAgentsStore.getState().select('', 'Explore');
    useClaudeAgentsStore.getState().select(null, 'Explore');
    expect(useClaudeAgentsStore.getState().selectedBySessionId).toEqual({});
    expect(useClaudeAgentsStore.getState().getSelected(null)).toBe('');
  });

  test('hydration restores a binding once', async () => {
    loadBinding = async () => ({ claudeAgentName: 'Explore' });
    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');
    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');
    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('Explore');
    expect(bindingCalls).toEqual(['ses_a']);
  });

  test('hydration never overwrites a live selection', async () => {
    useClaudeAgentsStore.getState().select('ses_a', 'Plan');
    loadBinding = async () => ({ claudeAgentName: 'Explore' });
    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');
    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('Plan');
    expect(bindingCalls).toEqual([]);
  });

  test('a missing binding leaves the selection empty', async () => {
    await useClaudeAgentsStore.getState().hydrateSelection('ses_a');
    expect(useClaudeAgentsStore.getState().getSelected('ses_a')).toBe('');
    expect(useClaudeAgentsStore.getState().selectedBySessionId).toEqual({});
  });
});
