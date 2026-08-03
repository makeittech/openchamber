import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyHarnessEventToSnapshot,
  getHarnessRecentMessages,
  getHarnessTurnSnapshot,
  isHarnessSessionWorking,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';

describe('harness turn snapshot', () => {
  beforeEach(() => {
    resetHarnessTurnSnapshots();
  });

  it('tracks busy/idle and assistant text for goal ticks', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'busy' } },
    }, '/proj');
    expect(isHarnessSessionWorking('ses_a')).toBe(true);

    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_u',
          sessionID: 'ses_a',
          role: 'user',
          time: { created: 1 },
        },
      },
    }, '/proj');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_t',
          sessionID: 'ses_a',
          messageID: 'msg_a',
          type: 'text',
          text: 'done',
        },
      },
    }, '/proj');
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_a',
          sessionID: 'ses_a',
          role: 'assistant',
          providerID: 'claude-code',
          modelID: 'sonnet',
          time: { created: 1, completed: 2 },
        },
      },
    }, '/proj');
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'idle' } },
    }, '/proj');

    expect(isHarnessSessionWorking('ses_a')).toBe(false);
    const snap = getHarnessTurnSnapshot('ses_a');
    expect(snap?.directory).toBe('/proj');
    expect(snap?.lastAssistant?.info?.modelID).toBe('sonnet');
    expect(getHarnessRecentMessages('ses_a')?.at(-1)?.parts?.[0]?.text).toBe('done');
  });

  it('marks aborted assistants', () => {
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_a',
          sessionID: 'ses_b',
          role: 'assistant',
          error: { name: 'MessageAbortedError' },
          time: { created: 1, completed: 2 },
        },
      },
    }, '/proj');
    expect(getHarnessTurnSnapshot('ses_b')?.aborted).toBe(true);
  });

  it('stores the full retry payload and treats retry as working', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_retry', status: {
        type: 'retry', attempt: 3, message: 'claude-session-limit', next: 1234,
      } },
    }, '/proj');
    expect(getHarnessTurnSnapshot('ses_retry')?.status).toEqual({
      type: 'retry', attempt: 3, message: 'claude-session-limit', next: 1234,
    });
    expect(isHarnessSessionWorking('ses_retry')).toBe(true);
  });
});

describe('snapshot eviction', () => {
  beforeEach(() => {
    resetHarnessTurnSnapshots();
  });

  const setStatus = (sessionId, type) => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: sessionId, status: { type } },
    }, '/proj');
  };

  it('never evicts a busy session when over the limit', () => {
    // The busy session is the oldest key, so insertion-order eviction would
    // drop exactly the in-flight turn and report it as idle.
    setStatus('ses_busy', 'busy');
    for (let i = 0; i < 600; i += 1) setStatus(`ses_idle_${i}`, 'idle');

    expect(isHarnessSessionWorking('ses_busy')).toBe(true);
    expect(getHarnessTurnSnapshot('ses_busy')).not.toBeNull();
  });

  it('never evicts a retry session when over the limit', () => {
    setStatus('ses_retry', 'retry');
    for (let i = 0; i < 600; i += 1) setStatus(`ses_idle_${i}`, 'idle');
    expect(isHarnessSessionWorking('ses_retry')).toBe(true);
    expect(getHarnessTurnSnapshot('ses_retry')).not.toBeNull();
  });

  it('evicts the least recently updated idle session', () => {
    for (let i = 0; i < 501; i += 1) setStatus(`ses_${i}`, 'idle');
    // ses_0 was written first and never touched again.
    expect(getHarnessTurnSnapshot('ses_0')).toBeNull();
    expect(getHarnessTurnSnapshot('ses_500')).not.toBeNull();
  });
});
