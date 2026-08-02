import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyHarnessEventToSnapshot,
  getHarnessRecentMessages,
  getHarnessTurnSnapshot,
  isHarnessSessionWorking,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';

const setStatus = (sessionId, type, extra = {}) => applyHarnessEventToSnapshot({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type, ...extra } },
}, '/proj');

const setMessage = (sessionId, info) => applyHarnessEventToSnapshot({
  type: 'message.updated',
  properties: { info: { sessionID: sessionId, ...info } },
}, '/proj');

describe('harness turn snapshot', () => {
  beforeEach(resetHarnessTurnSnapshots);

  it('tracks lifecycle and out-of-order assistant text for goal ticks', () => {
    setStatus('ses_a', 'busy');
    expect(isHarnessSessionWorking('ses_a')).toBe(true);
    setMessage('ses_a', { id: 'msg_u', role: 'user', time: { created: 1 } });
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_t', sessionID: 'ses_a', messageID: 'msg_a', type: 'text', text: 'done',
        },
      },
    }, '/proj');
    setMessage('ses_a', {
      id: 'msg_a',
      role: 'assistant',
      providerID: 'claude-code',
      modelID: 'sonnet',
      time: { created: 1, completed: 2 },
    });
    setStatus('ses_a', 'idle');

    expect(isHarnessSessionWorking('ses_a')).toBe(false);
    expect(getHarnessTurnSnapshot('ses_a')).toMatchObject({
      directory: '/proj',
      lastAssistant: { info: { modelID: 'sonnet' } },
    });
    expect(getHarnessRecentMessages('ses_a').at(-1).parts[0].text).toBe('done');
  });

  it('marks aborted assistants', () => {
    setMessage('ses_b', {
      id: 'msg_a', role: 'assistant', error: { name: 'MessageAbortedError' },
    });
    expect(getHarnessTurnSnapshot('ses_b').aborted).toBe(true);
  });

  it('stores complete retry state as working', () => {
    const retry = { attempt: 3, message: 'claude-session-limit', next: 1234 };
    setStatus('ses_retry', 'retry', retry);
    expect(getHarnessTurnSnapshot('ses_retry').status).toEqual({ type: 'retry', ...retry });
    expect(isHarnessSessionWorking('ses_retry')).toBe(true);
  });
});

describe('snapshot eviction', () => {
  beforeEach(resetHarnessTurnSnapshots);

  for (const type of ['busy', 'retry']) {
    it(`never evicts an old ${type} session`, () => {
      setStatus(`ses_${type}`, type);
      for (let index = 0; index < 600; index += 1) setStatus(`ses_idle_${index}`, 'idle');
      expect(isHarnessSessionWorking(`ses_${type}`)).toBe(true);
      expect(getHarnessTurnSnapshot(`ses_${type}`)).not.toBeNull();
    });
  }

  it('evicts the least recently updated idle session', () => {
    for (let index = 0; index < 501; index += 1) setStatus(`ses_${index}`, 'idle');
    expect(getHarnessTurnSnapshot('ses_0')).toBeNull();
    expect(getHarnessTurnSnapshot('ses_500')).not.toBeNull();
  });
});
