import { beforeEach, describe, expect, it } from 'bun:test';
import {
  applyHarnessEventToSnapshot,
  listHarnessActiveStatuses,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';
import { mergeHarnessActiveIntoSessionStatuses } from './session-status.js';
import { withHarnessEventDirectory } from './events/emit.js';

const statusEvent = (sessionID, status) => ({
  type: 'session.status',
  properties: { sessionID, status },
});

describe('withHarnessEventDirectory', () => {
  for (const [name, existing, expected] of [
    ['adds a missing directory', undefined, '/repo'],
    ['preserves an existing directory', '/kept', '/kept'],
  ]) {
    it(name, () => {
      const event = statusEvent('ses_1', { type: 'busy' });
      if (existing) event.properties.directory = existing;
      expect(withHarnessEventDirectory(event, '/repo').properties).toMatchObject({
        sessionID: 'ses_1', directory: expected,
      });
    });
  }
});

describe('mergeHarnessActiveIntoSessionStatuses', () => {
  beforeEach(resetHarnessTurnSnapshots);

  it('adds active harness sessions without changing OpenCode sessions', () => {
    applyHarnessEventToSnapshot(statusEvent('ses_claude', { type: 'busy' }), '/repo');
    const expected = {
      ses_opencode: { type: 'busy' },
      ses_claude: { type: 'busy' },
    };
    expect(mergeHarnessActiveIntoSessionStatuses({ ses_opencode: { type: 'busy' } }, '/repo'))
      .toEqual(expected);
    expect(listHarnessActiveStatuses('/repo')).toEqual({ ses_claude: { type: 'busy' } });
  });

  it('omits idle harness sessions', () => {
    applyHarnessEventToSnapshot(statusEvent('ses_claude', { type: 'idle' }), '/repo');
    expect(mergeHarnessActiveIntoSessionStatuses({}, '/repo')).toEqual({});
  });

  it('replaces upstream idle with the full retry payload', () => {
    const retry = { type: 'retry', attempt: 2, message: 'claude-session-limit', next: 9000 };
    applyHarnessEventToSnapshot(statusEvent('ses_retry', retry), '/repo');
    expect(mergeHarnessActiveIntoSessionStatuses({
      ses_retry: { type: 'idle', unrelated: true },
      ses_other: { type: 'busy', since: 1 },
    }, '/repo')).toEqual({
      ses_retry: retry,
      ses_other: { type: 'busy', since: 1 },
    });
  });
});
