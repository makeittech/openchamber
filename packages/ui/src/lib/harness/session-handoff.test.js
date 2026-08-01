import { beforeEach, describe, expect, mock, test } from 'bun:test';

const getSyncMessagesMock = mock(() => []);
const getSyncPartsMock = mock(() => []);

mock.module('@/sync/sync-refs', () => ({
  getSyncMessages: (...args) => getSyncMessagesMock(...args),
  getSyncParts: (...args) => getSyncPartsMock(...args),
}));

const {
  createHarnessHandoffSession,
  extractCompactionSummary,
} = await import(`./session-handoff?cache-test=${Date.now()}`);

beforeEach(() => {
  getSyncMessagesMock.mockReset();
  getSyncMessagesMock.mockImplementation(() => []);
  getSyncPartsMock.mockReset();
  getSyncPartsMock.mockImplementation(() => []);
});

describe('createHarnessHandoffSession', () => {
  test('creates a new session id via createSession mock', async () => {
    const createSession = mock(async () => ({ id: 'ses_new', directory: '/repo' }));
    const result = await createHarnessHandoffSession({
      sourceSessionId: 'ses_source',
      directory: '/repo',
      createSession,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(undefined, '/repo');
    expect(result.sessionId).toBe('ses_new');
    expect(result.directory).toBe('/repo');
    expect(result.sessionId).not.toBe('ses_source');
  });

  test('passes source title through to createSession', async () => {
    const createSession = mock(async () => ({ id: 'ses_named', directory: '/repo' }));
    await createHarnessHandoffSession({
      sourceSessionId: 'ses_source',
      directory: '/repo',
      title: 'Fix auth flow',
      sourceHarnessId: 'claude-code',
      createSession,
    });
    expect(createSession).toHaveBeenCalledWith('Fix auth flow', '/repo');
  });
});

describe('extractCompactionSummary', () => {
  const textPart = (text) => ({ type: 'text', text });
  const compactionPart = { type: 'compaction', auto: false };

  test('prefers the summary message linked via parentID', () => {
    getSyncMessagesMock.mockImplementation(() => [
      { id: 'm_user', role: 'user' },
      { id: 'm_cmd', role: 'user' },
      { id: 'm_summary', role: 'system', parentID: 'm_cmd' },
    ]);
    getSyncPartsMock.mockImplementation((messageId) => {
      if (messageId === 'm_cmd') return [compactionPart];
      if (messageId === 'm_summary') return [textPart('compacted summary')];
      return [];
    });
    expect(extractCompactionSummary('ses_x')).toBe('compacted summary');
  });

  test('falls back to first assistant text after the marker', () => {
    getSyncMessagesMock.mockImplementation(() => [
      { id: 'm_cmd', role: 'user' },
      { id: 'm_assistant', role: 'assistant' },
    ]);
    getSyncPartsMock.mockImplementation((messageId) => {
      if (messageId === 'm_cmd') return [compactionPart];
      if (messageId === 'm_assistant') return [textPart('opencode summary')];
      return [];
    });
    expect(extractCompactionSummary('ses_x')).toBe('opencode summary');
  });

  test('falls back to newest assistant text when no marker exists', () => {
    getSyncMessagesMock.mockImplementation(() => [
      { id: 'm_user', role: 'user' },
      { id: 'm_assistant', role: 'assistant' },
    ]);
    getSyncPartsMock.mockImplementation((messageId) => (
      messageId === 'm_assistant' ? [textPart('latest reply')] : []
    ));
    expect(extractCompactionSummary('ses_x')).toBe('latest reply');
  });

  test('returns null when nothing usable exists', () => {
    getSyncMessagesMock.mockImplementation(() => [
      { id: 'm_cmd', role: 'user' },
    ]);
    getSyncPartsMock.mockImplementation(() => [compactionPart]);
    expect(extractCompactionSummary('ses_x')).toBeNull();
  });
});
