import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configureSessionBindings,
  resetSessionBindings,
} from '../../session-bindings.js';
import { resetClaudeTranscriptCaches, MAX_TRANSCRIPT_BYTES } from './transcript-messages.js';
import {
  RECOVERY_MARKER,
  buildRecoveryUserMessage,
  createRecoveryToolGuard,
  fingerprintToolCall,
  inspectRecoveryTranscript,
  isRecoveryContinuationRecord,
} from './recovery-transcript.js';

const FOREIGN_ID = 'c0ffee00-1234-4321-8765-aaaabbbbcccd';
const DENY_REASON = 'OpenChamber blocked an exact pre-limit tool replay.';

let tmpRoot;
let previousConfigDir;

const baseRecord = (overrides = {}) => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: '/tmp/project',
  sessionId: FOREIGN_ID,
  version: '2.1.220',
  ...overrides,
});

const userTextRecord = (uuid, timestamp, text, overrides = {}) => JSON.stringify(baseRecord({
  type: 'user',
  uuid,
  timestamp,
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...overrides,
}));

const userSyntheticRecord = (uuid, timestamp, text, overrides = {}) => JSON.stringify(baseRecord({
  type: 'user',
  uuid,
  timestamp,
  isSynthetic: true,
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...overrides,
}));

const assistantRecord = (uuid, timestamp, content, overrides = {}) => JSON.stringify(baseRecord({
  type: 'assistant',
  uuid,
  timestamp,
  message: { role: 'assistant', content },
  ...overrides,
}));

const assistantText = (uuid, timestamp, text) => assistantRecord(uuid, timestamp, [{ type: 'text', text }]);

const assistantToolUseWithText = (uuid, timestamp, callId, toolName, input, text) =>
  assistantRecord(uuid, timestamp, [
    ...(text ? [{ type: 'text', text }] : []),
    { type: 'tool_use', id: callId, name: toolName, input },
  ]);

const userToolResult = (uuid, timestamp, callId, isError = false, content = 'ok') =>
  JSON.stringify(baseRecord({
    type: 'user',
    uuid,
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError, content }],
    },
  }));

const writeTranscript = (lines) => {
  const projectDir = path.join(tmpRoot, 'projects', '-tmp-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${FOREIGN_ID}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recovery-test-'));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpRoot;
  resetSessionBindings();
  configureSessionBindings({ persist: false, load: true });
  resetClaudeTranscriptCaches();
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  resetClaudeTranscriptCaches();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildRecoveryUserMessage', () => {
  it('produces a synthetic now-priority SDK user message whose text starts with the recovery marker', () => {
    const msg = buildRecoveryUserMessage('launch-uuid-1234');
    expect(msg.type).toBe('user');
    expect(msg.uuid).toBe('launch-uuid-1234');
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.isSynthetic).toBe(true);
    expect(msg.priority).toBe('now');
    expect(msg.message.role).toBe('user');
    expect(Array.isArray(msg.message.content)).toBe(true);
    expect(msg.message.content).toHaveLength(1);
    expect(msg.message.content[0].type).toBe('text');
    expect(msg.message.content[0].text.startsWith(RECOVERY_MARKER)).toBe(true);
    expect(msg.message.content[0].text).toContain('Continue the interrupted response.');
    // Self-classification round-trip: the parser must hide this record.
    expect(isRecoveryContinuationRecord(msg)).toBe(true);
  });

  it('defaults uuid to an empty string when omitted', () => {
    const msg = buildRecoveryUserMessage();
    expect(msg.uuid).toBe('');
    expect(isRecoveryContinuationRecord(msg)).toBe(true);
  });
});

describe('fingerprintToolCall', () => {
  it('is stable across object-key order at the top level and nested', () => {
    expect(fingerprintToolCall('Bash', { command: 'ls', args: ['a', 'b'] }))
      .toBe(fingerprintToolCall('Bash', { args: ['a', 'b'], command: 'ls' }));
    expect(fingerprintToolCall('Read', { file_path: '/a', limit: 100 }))
      .toBe(fingerprintToolCall('Read', { limit: 100, file_path: '/a' }));
    expect(fingerprintToolCall('Tool', { outer: { a: 1, b: 2 } }))
      .toBe(fingerprintToolCall('Tool', { outer: { b: 2, a: 1 } }));
  });

  it('preserves array order', () => {
    expect(fingerprintToolCall('Bash', { args: ['a', 'b'] }))
      .not.toBe(fingerprintToolCall('Bash', { args: ['b', 'a'] }));
  });

  it('preserves value types (number vs string vs boolean)', () => {
    expect(fingerprintToolCall('Tool', { n: 1 })).not.toBe(fingerprintToolCall('Tool', { n: '1' }));
    expect(fingerprintToolCall('Tool', { n: 1 })).not.toBe(fingerprintToolCall('Tool', { n: true }));
    expect(fingerprintToolCall('Tool', { v: null })).not.toBe(fingerprintToolCall('Tool', { v: false }));
  });

  it('distinguishes tool names', () => {
    expect(fingerprintToolCall('Read', { file_path: '/a' }))
      .not.toBe(fingerprintToolCall('Write', { file_path: '/a' }));
  });

  it('coerces a missing or non-object input to an empty-object canonical form', () => {
    expect(fingerprintToolCall('Tool', undefined)).toBe(fingerprintToolCall('Tool', {}));
    expect(fingerprintToolCall('Tool', null)).toBe(fingerprintToolCall('Tool', {}));
    expect(fingerprintToolCall('Tool', [1, 2])).toBe(fingerprintToolCall('Tool', {}));
  });
});

describe('isRecoveryContinuationRecord', () => {
  it('is true for synthetic records whose user text content exactly starts with the marker', () => {
    expect(isRecoveryContinuationRecord(buildRecoveryUserMessage('uX'))).toBe(true);
    expect(isRecoveryContinuationRecord({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: `${RECOVERY_MARKER}\nextra` }] },
    })).toBe(true);
    // String-form content is also supported (SDK stores some notifications that way).
    expect(isRecoveryContinuationRecord({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: `${RECOVERY_MARKER}\nstring-form-allowed` },
    })).toBe(true);
  });

  it('is false when isSynthetic is missing or not strictly true, even if the text matches', () => {
    expect(isRecoveryContinuationRecord({
      type: 'user',
      isSynthetic: false,
      message: { role: 'user', content: [{ type: 'text', text: RECOVERY_MARKER }] },
    })).toBe(false);
    expect(isRecoveryContinuationRecord({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: RECOVERY_MARKER }] },
    })).toBe(false);
  });

  it('is false for synthetic records whose text merely contains (not starts with) the marker', () => {
    expect(isRecoveryContinuationRecord({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: `xor-${RECOVERY_MARKER}` }] },
    })).toBe(false);
    expect(isRecoveryContinuationRecord({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: 'just a normal prompt' }] },
    })).toBe(false);
  });

  it('is false for malformed inputs (null/empty/wrong message shape)', () => {
    expect(isRecoveryContinuationRecord(null)).toBe(false);
    expect(isRecoveryContinuationRecord(undefined)).toBe(false);
    expect(isRecoveryContinuationRecord({})).toBe(false);
    expect(isRecoveryContinuationRecord({ isSynthetic: true })).toBe(false);
    expect(isRecoveryContinuationRecord({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: [] },
    })).toBe(false);
  });
});

describe('inspectRecoveryTranscript', () => {
  it('returns transcript-unreadable when no transcript exists for the foreign session id', () => {
    const result = inspectRecoveryTranscript({
      foreignSessionId: FOREIGN_ID,
      expectedTailUuid: 'tail-uuid',
      launchUuid: 'launch-uuid',
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('transcript-unreadable');
  });

  it('returns transcript-unreadable when the file is empty or oversize', () => {
    const filePath = writeTranscript([JSON.stringify(baseRecord({ type: 'summary', summary: 'x' }))]);

    fs.writeFileSync(filePath, '');
    let result = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('transcript-unreadable');

    // Sparse-ftruncate past the bound: stat reports the oversize, no huge
    // write is needed.
    fs.writeFileSync(filePath, '{}\n');
    fs.truncateSync(filePath, MAX_TRANSCRIPT_BYTES + 1);
    result = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('transcript-unreadable');
  });

  it('returns transcript-unreadable when the foreign session id is empty/missing', () => {
    expect(inspectRecoveryTranscript({}).safe).toBe(false);
    expect(inspectRecoveryTranscript({}).reason).toBe('transcript-unreadable');
    expect(inspectRecoveryTranscript({ foreignSessionId: '   ' }).reason).toBe('transcript-unreadable');
  });

  it('analyses from the last real non-sidechain non-meta non-internal user turn and ignores earlier unsettled tools', () => {
    writeTranscript([
      userTextRecord('u1', '2026-07-28T10:00:00.000Z', 'first real prompt'),
      // callC lacks any tool_result — would be unsafe if the whole transcript
      // were the analysis window.
      assistantToolUseWithText('a1', '2026-07-28T10:00:01.000Z', 'callC', 'Bash', { command: 'sleep 99' }, 'kicking off'),
      // The LAST real user turn — analysis window starts here.
      userTextRecord('u2', '2026-07-28T10:00:02.000Z', 'second real prompt'),
      assistantToolUseWithText('a2', '2026-07-28T10:00:03.000Z', 'callD', 'Read', { file_path: '/tmp/project/auth.ts' }, 'looking'),
      userToolResult('u_callD', '2026-07-28T10:00:04.000Z', 'callD', false, 'file bytes'),
      assistantText('a3', '2026-07-28T10:00:05.000Z', 'final answer'),
    ]);

    const result = inspectRecoveryTranscript({
      foreignSessionId: FOREIGN_ID,
      expectedTailUuid: 'a3',
      launchUuid: 'launch-1',
    });

    expect(result.safe).toBe(true);
    expect(result.tailPresent).toBe(true);
    expect(Array.isArray(result.fingerprints)).toBe(true);
    expect(result.fingerprints).toHaveLength(1);
    expect(result.fingerprints[0].toolName).toBe('Read');
    expect(result.fingerprints[0].fingerprint)
      .toBe(fingerprintToolCall('Read', { file_path: '/tmp/project/auth.ts' }));
  });

  it('flags any tool_use lacking a matching tool_result as unsettled-tool', () => {
    writeTranscript([
      userTextRecord('u1', '2026-07-28T11:00:00.000Z', 'do work'),
      assistantToolUseWithText('a1', '2026-07-28T11:00:01.000Z', 'callC', 'Read', { file_path: '/a' }, 'a'),
      userToolResult('u_callC', '2026-07-28T11:00:02.000Z', 'callC', false, 'ok'),
      // callD has NO tool_result — unsettled.
      assistantToolUseWithText('a2', '2026-07-28T11:00:03.000Z', 'callD', 'Bash', { command: 'rm -rf /' }, 'b'),
    ]);

    const result = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('unsettled-tool');
  });

  it('treats both successful and error tool_results as settled', () => {
    writeTranscript([
      userTextRecord('u1', '2026-07-28T12:00:00.000Z', 'do work'),
      // settled via an error_result
      assistantToolUseWithText('a1', '2026-07-28T12:00:01.000Z', 'callC', 'Write', { file_path: '/a' }, 'writing'),
      userToolResult('u_callC', '2026-07-28T12:00:02.000Z', 'callC', true, 'permission denied'),
      // settled via a normal tool_result
      assistantToolUseWithText('a2', '2026-07-28T12:00:03.000Z', 'callD', 'Read', { file_path: '/b' }, 'reading'),
      userToolResult('u_callD', '2026-07-28T12:00:04.000Z', 'callD', false, 'file bytes'),
      assistantText('a3', '2026-07-28T12:00:05.000Z', 'recovered'),
    ]);

    const result = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID, expectedTailUuid: 'a3' });
    expect(result.safe).toBe(true);
    expect(result.fingerprints).toHaveLength(2);
    expect(result.fingerprints[0].toolName).toBe('Write');
    expect(result.fingerprints[1].toolName).toBe('Read');
    expect(result.tailPresent).toBe(true);
  });

  it('verifies the expected tail UUID presence and absence', () => {
    writeTranscript([
      userTextRecord('u1', '2026-07-28T13:00:00.000Z', 'go'),
      assistantToolUseWithText('a1', '2026-07-28T13:00:01.000Z', 'callC', 'Read', { file_path: '/a' }, 'reading'),
      userToolResult('u_callC', '2026-07-28T13:00:02.000Z', 'callC', false, 'ok'),
      assistantText('a2', '2026-07-28T13:00:03.000Z', 'tail'),
    ]);

    const present = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID, expectedTailUuid: 'a2' });
    expect(present.safe).toBe(true);
    expect(present.tailPresent).toBe(true);

    const absent = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID, expectedTailUuid: 'bogus-uuid' });
    expect(absent.safe).toBe(true);
    expect(absent.tailPresent).toBe(false);
  });

  it('skips sidechain, meta, and synthetic continuation records when locating the window and matching tools', () => {
    writeTranscript([
      userTextRecord('u_real', '2026-07-28T14:00:00.000Z', 'real user turn'),
      assistantToolUseWithText('a1', '2026-07-28T14:00:01.000Z', 'callC', 'Bash', { command: 'true' }, 'first'),
      userToolResult('u_callC', '2026-07-28T14:00:02.000Z', 'callC', false, 'done'),
      // Synthetic recovery continuation from a prior attempt — internal, hidden.
      userSyntheticRecord('u_recovery', '2026-07-28T14:00:03.000Z', `${RECOVERY_MARKER}\nContinue.`),
      // Task-notification — internal context.
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u_task',
        timestamp: '2026-07-28T14:00:04.000Z',
        message: {
          role: 'user',
          content: '<task-notification>\n<status>stopped</status>\n</task-notification>',
        },
      })),
      // Sidechain assistant with a tool_use — must be excluded from analysis.
      JSON.stringify(baseRecord({
        type: 'assistant',
        uuid: 'a_side',
        timestamp: '2026-07-28T14:00:05.000Z',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'callX', name: 'Bash', input: { command: 'ls' } }] },
      })),
      assistantText('a2', '2026-07-28T14:00:06.000Z', 'tail'),
    ]);

    const result = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID, expectedTailUuid: 'a2' });
    expect(result.safe).toBe(true);
    // callX is excluded; callC is settled; fingerprint list has only callC.
    expect(result.fingerprints).toHaveLength(1);
    expect(result.fingerprints[0].toolName).toBe('Bash');
    expect(result.fingerprints[0].fingerprint).toBe(fingerprintToolCall('Bash', { command: 'true' }));
    expect(result.tailPresent).toBe(true);
  });

  it('returns a safe empty analysis with tailPresent=false when no real user turn exists', () => {
    writeTranscript([
      assistantText('a_no_user_first', '2026-07-28T15:00:00.000Z', 'no real user yet'),
    ]);

    const result = inspectRecoveryTranscript({
      foreignSessionId: FOREIGN_ID,
      expectedTailUuid: 'a_no_user_first',
    });
    expect(result.safe).toBe(true);
    expect(result.fingerprints).toHaveLength(0);
    expect(result.tailPresent).toBe(false);
  });
});

describe('createRecoveryToolGuard', () => {
  it('denies an exact fingerprint replay and allows a novel call', async () => {
    const fingerprint = fingerprintToolCall('Read', { file_path: '/a' });
    const guard = createRecoveryToolGuard([{ toolName: 'Read', fingerprint }]);

    const denied = await guard({ tool_name: 'Read', tool_input: { file_path: '/a' } }, 'toolu_1', { signal: new AbortController().signal });
    expect(denied.hookSpecificOutput).toBeDefined();
    expect(denied.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toBe(DENY_REASON);

    const allowed = await guard({ tool_name: 'Read', tool_input: { file_path: '/b' } }, 'toolu_2', { signal: new AbortController().signal });
    expect(allowed.continue).toBe(true);
    expect(allowed.hookSpecificOutput).toBeUndefined();

    const allowedOther = await guard({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'toolu_3', { signal: new AbortController().signal });
    expect(allowedOther.continue).toBe(true);
  });

  it('accepts a list of bare fingerprint strings in place of { toolName, fingerprint }', async () => {
    const guard = createRecoveryToolGuard([fingerprintToolCall('Bash', { command: 'rm -rf /' })]);
    const denied = await guard({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, 't4', { signal: new AbortController().signal });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');

    const allowed = await guard({ tool_name: 'Bash', tool_input: { command: 'true' } }, 't5', { signal: new AbortController().signal });
    expect(allowed.continue).toBe(true);
  });

  it('allows everything when fingerprints list is empty or malformed', async () => {
    const guardUndefined = createRecoveryToolGuard(undefined);
    expect((await guardUndefined({ tool_name: 'X', tool_input: {} }, 't6', { signal: new AbortController().signal })).continue).toBe(true);

    const guardEmpty = createRecoveryToolGuard([]);
    expect((await guardEmpty({ tool_name: 'X', tool_input: {} }, 't7', { signal: new AbortController().signal })).continue).toBe(true);

    const guardMalformed = createRecoveryToolGuard([{ /* no fingerprint key */ }, 'good-as-string']);
    // The 'good-as-string' literal won't match any real call's canonical form.
    expect((await guardMalformed({ tool_name: 'Y', tool_input: { z: 1 } }, 't8', { signal: new AbortController().signal })).continue).toBe(true);
  });
});