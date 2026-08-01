import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ClaudeSessionCapabilities } from '@/lib/harness/client';

const capabilities = (
  overrides: Partial<ClaudeSessionCapabilities> = {},
): ClaudeSessionCapabilities => ({
  sessionId: 'sess-1',
  slashCommands: [],
  skills: [],
  agents: [],
  tools: [],
  mcpServers: [],
  updatedAt: 1,
  ...overrides,
});

let loadCapabilities: () => Promise<{ capabilities: ClaudeSessionCapabilities }>;
const actualClient = await import('@/lib/harness/client');

mock.module('@/lib/harness/client', () => ({
  ...actualClient,
  harnessSessionCapabilities: async (sessionId: string) => {
    const result = await loadCapabilities();
    return { capabilities: { ...result.capabilities, sessionId } };
  },
}));

const {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  selectClaudeSlashCommands,
  useClaudeSessionCapabilitiesStore,
} = await import('./useClaudeSessionCapabilitiesStore');

beforeEach(() => {
  useClaudeSessionCapabilitiesStore.getState().reset();
  loadCapabilities = async () => ({ capabilities: capabilities() });
});

describe('useClaudeSessionCapabilitiesStore', () => {
  test('builtin slash fallback keeps one stable reference', async () => {
    const state = useClaudeSessionCapabilitiesStore.getState();
    expect(selectClaudeSlashCommands(state, null)).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
    expect(state.getSlashCommands('missing')).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);

    await state.refresh('sess-1');
    expect(useClaudeSessionCapabilitiesStore.getState().getSlashCommands('sess-1'))
      .toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
  });

  test('server slash commands are returned by reference', async () => {
    const slashCommands = ['usage', 'compact'];
    loadCapabilities = async () => ({ capabilities: capabilities({ slashCommands, updatedAt: 2 }) });
    await useClaudeSessionCapabilitiesStore.getState().refresh('sess-1');

    const selected = useClaudeSessionCapabilitiesStore.getState().getSlashCommands('sess-1');
    expect(selected).toBe(slashCommands);
    expect(selected).toEqual(['usage', 'compact']);
  });

  test('failure keeps prior capabilities and provides defaults on first failure', async () => {
    const slashCommands = ['usage'];
    loadCapabilities = async () => ({ capabilities: capabilities({ slashCommands, updatedAt: 2 }) });
    await useClaudeSessionCapabilitiesStore.getState().refresh('sess-1');

    loadCapabilities = async () => { throw new Error('offline'); };
    expect(await useClaudeSessionCapabilitiesStore.getState().refresh('sess-1'))
      .toBe(useClaudeSessionCapabilitiesStore.getState().getCapabilities('sess-1'));
    expect(useClaudeSessionCapabilitiesStore.getState().getSlashCommands('sess-1')).toBe(slashCommands);

    const failed = await useClaudeSessionCapabilitiesStore.getState().refresh('sess-2');
    expect(failed?.updatedAt).toBe(0);
    expect(failed?.slashCommands).toBe(CLAUDE_BUILTIN_SLASH_COMMANDS);
  });

  test('an older server result cannot replace newer capabilities', async () => {
    loadCapabilities = async () => ({ capabilities: capabilities({ slashCommands: ['new'], updatedAt: 10 }) });
    await useClaudeSessionCapabilitiesStore.getState().refresh('sess-1');
    loadCapabilities = async () => ({ capabilities: capabilities({ slashCommands: ['old'], updatedAt: 5 }) });
    await useClaudeSessionCapabilitiesStore.getState().refresh('sess-1');

    expect(useClaudeSessionCapabilitiesStore.getState().getSlashCommands('sess-1')).toEqual(['new']);
  });
});
