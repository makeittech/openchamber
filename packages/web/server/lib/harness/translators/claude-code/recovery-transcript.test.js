import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const UNREADABLE = { safe: false, reason: 'transcript-unreadable' };

let tmpRoot;
let previousConfigDir;

const user = (content, overrides = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...overrides,
});
const prompt = (text, overrides) => user([{ type: 'text', text }], overrides);
const assistant = (content, overrides = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  ...overrides,
});
const text = (value, overrides) => assistant([{ type: 'text', text: value }], overrides);
const toolUse = (id, name, input, overrides) => assistant([
  { type: 'tool_use', id, name, input },
], overrides);
const toolResult = (toolUseId, isError = false, overrides) => user([
  { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'result' },
], overrides);

function writeTranscript(records) {
  const projectDir = path.join(tmpRoot, 'projects', '-tmp-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${FOREIGN_ID}.jsonl`);
  const lines = records.map((record) => (
    typeof record === 'string' ? record : JSON.stringify(record)
  ));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recovery-test-'));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpRoot;
  resetClaudeTranscriptCaches();
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  resetClaudeTranscriptCaches();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildRecoveryUserMessage', () => {
  it('builds a hidden, immediate continuation message', () => {
    const message = buildRecoveryUserMessage('launch-uuid');
    expect(message).toEqual({
      type: 'user',
      uuid: 'launch-uuid',
      parent_tool_use_id: null,
      isSynthetic: true,
      priority: 'now',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${RECOVERY_MARKER}\nContinue the interrupted response.` }],
      },
    });
    expect(isRecoveryContinuationRecord(message)).toBe(true);
  });

  it('uses an empty UUID when omitted', () => {
    expect(buildRecoveryUserMessage().uuid).toBe('');
  });
});

describe('fingerprintToolCall', () => {
  const equivalent = [
    ['top-level key order', 'Bash', { command: 'ls', args: ['a'] }, { args: ['a'], command: 'ls' }],
    ['nested key order', 'Tool', { outer: { a: 1, b: 2 } }, { outer: { b: 2, a: 1 } }],
    ['undefined input', 'Tool', undefined, {}],
    ['null input', 'Tool', null, {}],
    ['array input', 'Tool', [1, 2], {}],
  ];
  for (const [name, tool, left, right] of equivalent) {
    it(`treats ${name} as equivalent`, () => {
      expect(fingerprintToolCall(tool, left)).toBe(fingerprintToolCall(tool, right));
    });
  }

  const different = [
    ['array order', 'Bash', { args: ['a', 'b'] }, 'Bash', { args: ['b', 'a'] }],
    ['number and string', 'Tool', { value: 1 }, 'Tool', { value: '1' }],
    ['number and boolean', 'Tool', { value: 1 }, 'Tool', { value: true }],
    ['null and false', 'Tool', { value: null }, 'Tool', { value: false }],
    ['tool names', 'Read', { file_path: '/a' }, 'Write', { file_path: '/a' }],
  ];
  for (const [name, leftTool, left, rightTool, right] of different) {
    it(`distinguishes ${name}`, () => {
      expect(fingerprintToolCall(leftTool, left)).not.toBe(fingerprintToolCall(rightTool, right));
    });
  }
});

describe('isRecoveryContinuationRecord', () => {
  const cases = [
    ['generated message', buildRecoveryUserMessage('id'), true],
    ['text block', user([{ type: 'text', text: `${RECOVERY_MARKER}\nextra` }], { isSynthetic: true }), true],
    ['string content', user(`${RECOVERY_MARKER}\nextra`, { isSynthetic: true }), true],
    ['non-synthetic record', user([{ type: 'text', text: RECOVERY_MARKER }]), false],
    ['explicitly non-synthetic record', user([{ type: 'text', text: RECOVERY_MARKER }], { isSynthetic: false }), false],
    ['marker after a prefix', user([{ type: 'text', text: `prefix-${RECOVERY_MARKER}` }], { isSynthetic: true }), false],
    ['ordinary synthetic prompt', prompt('ordinary', { isSynthetic: true }), false],
    ['null', null, false],
    ['empty object', {}, false],
    ['missing message', { isSynthetic: true }, false],
    ['empty content', user([], { isSynthetic: true }), false],
  ];
  for (const [name, record, expected] of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isRecoveryContinuationRecord(record)).toBe(expected);
    });
  }
});

describe('inspectRecoveryTranscript', () => {
  it('fails closed for a missing, empty, oversized, or unidentified transcript', () => {
    for (const params of [{}, { foreignSessionId: '   ' }, { foreignSessionId: FOREIGN_ID }]) {
      expect(inspectRecoveryTranscript(params)).toEqual(UNREADABLE);
    }

    const filePath = writeTranscript([{}]);
    for (const prepare of [
      () => fs.writeFileSync(filePath, ''),
      () => {
        fs.writeFileSync(filePath, '{}\n');
        fs.truncateSync(filePath, MAX_TRANSCRIPT_BYTES + 1);
      },
    ]) {
      prepare();
      resetClaudeTranscriptCaches();
      expect(inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID })).toEqual(UNREADABLE);
    }
  });

  it('uses only the last visible user turn', () => {
    writeTranscript([
      prompt('first'),
      toolUse('old', 'Bash', { command: 'sleep 99' }),
      prompt('second'),
      toolUse('current', 'Read', { file_path: '/project/auth.ts' }),
      toolResult('current'),
      text('done', { uuid: 'tail' }),
    ]);

    expect(inspectRecoveryTranscript({
      foreignSessionId: FOREIGN_ID,
      expectedTailUuid: 'tail',
    })).toEqual({
      safe: true,
      fingerprints: [{
        toolName: 'Read',
        fingerprint: fingerprintToolCall('Read', { file_path: '/project/auth.ts' }),
      }],
      tailPresent: true,
    });
  });

  it('fails closed when any current tool is unsettled', () => {
    writeTranscript([
      prompt('work'),
      toolUse('settled', 'Read', { file_path: '/a' }),
      toolResult('settled'),
      toolUse('unsettled', 'Bash', { command: 'rm -rf /' }),
    ]);
    expect(inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID })).toEqual({
      safe: false,
      reason: 'unsettled-tool',
    });
  });

  it('treats successful and error tool results as settled in transcript order', () => {
    writeTranscript([
      prompt('work'),
      toolUse('write', 'Write', { file_path: '/a' }),
      toolResult('write', true),
      toolUse('read', 'Read', { file_path: '/b' }),
      toolResult('read'),
      text('done', { uuid: 'tail' }),
    ]);
    const result = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID, expectedTailUuid: 'tail' });
    expect(result.safe).toBe(true);
    expect(result.fingerprints.map(({ toolName }) => toolName)).toEqual(['Write', 'Read']);
    expect(result.tailPresent).toBe(true);
  });

  it('reports whether the expected tail is present', () => {
    writeTranscript([prompt('go'), text('done', { uuid: 'tail' })]);
    for (const [expectedTailUuid, tailPresent] of [['tail', true], ['other', false]]) {
      expect(inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID, expectedTailUuid }).tailPresent)
        .toBe(tailPresent);
    }
  });

  it('excludes internal, sidechain, and meta records', () => {
    writeTranscript([
      prompt('real turn'),
      toolUse('current', 'Bash', { command: 'true' }),
      toolResult('current'),
      user(`${RECOVERY_MARKER}\nContinue.`, { isSynthetic: true }),
      user('<task-notification>stopped</task-notification>'),
      toolUse('side', 'Bash', { command: 'unsafe' }, { isSidechain: true }),
      toolUse('meta', 'Bash', { command: 'unsafe' }, { isMeta: true }),
      text('done', { uuid: 'tail' }),
    ]);
    const result = inspectRecoveryTranscript({ foreignSessionId: FOREIGN_ID, expectedTailUuid: 'tail' });
    expect(result).toEqual({
      safe: true,
      fingerprints: [{
        toolName: 'Bash',
        fingerprint: fingerprintToolCall('Bash', { command: 'true' }),
      }],
      tailPresent: true,
    });
  });

  it('returns an empty safe result when no visible user turn exists', () => {
    writeTranscript([text('orphan', { uuid: 'tail' })]);
    expect(inspectRecoveryTranscript({
      foreignSessionId: FOREIGN_ID,
      expectedTailUuid: 'tail',
    })).toEqual({ safe: true, fingerprints: [], tailPresent: false });
  });
});

describe('createRecoveryToolGuard', () => {
  it('denies exact object and string fingerprints while allowing novel calls', async () => {
    const read = fingerprintToolCall('Read', { file_path: '/a' });
    const bash = fingerprintToolCall('Bash', { command: 'rm -rf /' });
    const guard = createRecoveryToolGuard([{ toolName: 'Read', fingerprint: read }, bash]);

    for (const input of [
      { tool_name: 'Read', tool_input: { file_path: '/a' } },
      { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    ]) {
      expect(await guard(input)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: DENY_REASON,
        },
      });
    }
    expect(await guard({ tool_name: 'Read', tool_input: { file_path: '/b' } }))
      .toEqual({ continue: true });
  });

  it('ignores empty and malformed fingerprint lists', async () => {
    for (const fingerprints of [undefined, [], [{}], ['not-a-canonical-call']]) {
      const guard = createRecoveryToolGuard(fingerprints);
      expect(await guard({ tool_name: 'Tool', tool_input: {} })).toEqual({ continue: true });
    }
  });
});
