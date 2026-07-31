import { beforeEach, describe, expect, it } from 'bun:test';
import {
  applyHarnessEventToSnapshot,
  listHarnessActiveStatuses,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';
import { mergeHarnessActiveIntoSessionStatuses } from './session-status.js';
import { withHarnessEventDirectory } from './events/emit.js';

describe('withHarnessEventDirectory', () => {
  it('stamps directory onto event properties for SSE routing', () => {
    const stamped = withHarnessEventDirectory({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        status: { type: 'busy' },
      },
    }, '/repo');
    expect(stamped.properties.directory).toBe('/repo');
    expect(stamped.properties.sessionID).toBe('ses_1');
  });

  it('preserves an existing properties.directory', () => {
    const stamped = withHarnessEventDirectory({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        directory: '/kept',
        status: { type: 'busy' },
      },
    }, '/repo');
    expect(stamped.properties.directory).toBe('/kept');
  });
});

describe('mergeHarnessActiveIntoSessionStatuses', () => {
  beforeEach(() => {
    resetHarnessTurnSnapshots();
  });

  it('overlays harness busy onto OpenCode status snapshots', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_claude', status: { type: 'busy' } },
    }, '/repo');

    const merged = mergeHarnessActiveIntoSessionStatuses(
      { ses_opencode: { type: 'busy' } },
      '/repo',
    );
    expect(merged).toEqual({
      ses_opencode: { type: 'busy' },
      ses_claude: { type: 'busy' },
    });
    expect(listHarnessActiveStatuses('/repo')).toEqual({
      ses_claude: { type: 'busy' },
    });
  });

  it('does not invent idle harness entries', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_claude', status: { type: 'idle' } },
    }, '/repo');
    expect(mergeHarnessActiveIntoSessionStatuses({}, '/repo')).toEqual({});
  });

  it('overlays full retry status over upstream idle and absence', () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: { sessionID: 'ses_retry', status: {
        type: 'retry', attempt: 2, message: 'claude-session-limit', next: 9000,
      } },
    }, '/repo');
    expect(mergeHarnessActiveIntoSessionStatuses({
      ses_retry: { type: 'idle', unrelated: true },
      ses_other: { type: 'busy', since: 1 },
    }, '/repo')).toEqual({
      ses_retry: { type: 'retry', attempt: 2, message: 'claude-session-limit', next: 9000 },
      ses_other: { type: 'busy', since: 1 },
    });
  });
});
