import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindSession, configureSessionBindings, resetSessionBindings } from './session-bindings.js';
import { applyHarnessEventToSnapshot, resetHarnessTurnSnapshots } from './turn-snapshot.js';
import { resetClaudeTranscriptCaches } from './translators/claude-code/transcript-messages.js';
import { mergeHarnessMessagesIntoSessionMessages } from './session-messages.js';
import { RECOVERY_MARKER } from './translators/claude-code/recovery-transcript.js';

const FOREIGN_ID = '123e4567-e89b-42d3-a456-426614174000';

function bindClaude(sessionId, foreignSessionId) {
  bindSession({
    sessionId,
    harnessId: 'claude-code',
    directory: '/repo',
    target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    foreignSessionId,
  });
}

function applyMessage(sessionId, id, role, text, created) {
  applyHarnessEventToSnapshot({
    type: 'message.updated',
    properties: { info: { id, role, sessionID: sessionId, ...(created ? { time: { created } } : {}) } },
  }, '/repo');
  applyHarnessEventToSnapshot({
    type: 'message.part.updated',
    properties: {
      part: { id: `prt_${id}`, sessionID: sessionId, messageID: id, type: 'text', text },
    },
  }, '/repo');
}

function transcriptLine(role, uuid, timestamp, text, extra = {}) {
  return JSON.stringify({
    type: role,
    uuid,
    timestamp,
    sessionId: FOREIGN_ID,
    cwd: '/repo',
    ...extra,
    message: { role, content: [{ type: 'text', text }] },
  });
}

describe('mergeHarnessMessagesIntoSessionMessages', () => {
  beforeEach(() => {
    resetSessionBindings();
    configureSessionBindings({ persist: false, load: true });
    resetHarnessTurnSnapshots();
  });

  it('returns OpenCode messages unchanged for non-Claude sessions', () => {
    const messages = [{ info: { id: 'msg_1', role: 'user', sessionID: 'ses_oc' }, parts: [] }];
    expect(mergeHarnessMessagesIntoSessionMessages(messages, 'ses_oc')).toEqual(messages);
  });

  it('fills an empty OpenCode response from the live snapshot', () => {
    bindClaude('ses_claude');
    applyMessage('ses_claude', 'msg_01_user', 'user', 'hi');
    applyMessage('ses_claude', 'msg_02_asst', 'assistant', 'READY1');
    expect(mergeHarnessMessagesIntoSessionMessages([], 'ses_claude').map((record) => (
      [record.info.id, record.parts[0].text]
    ))).toEqual([
      ['msg_01_user', 'hi'],
      ['msg_02_asst', 'READY1'],
    ]);
  });
});

describe('transcript replay overlay', () => {
  let root;
  let previousConfigDir;

  function writeTranscript(lines) {
    const directory = path.join(root, 'projects', '-repo');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${FOREIGN_ID}.jsonl`), `${lines.join('\n')}\n`);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-messages-test-'));
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    resetSessionBindings();
    configureSessionBindings({ persist: false, load: true });
    resetHarnessTurnSnapshots();
    resetClaudeTranscriptCaches();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    resetClaudeTranscriptCaches();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves imported history from disk', () => {
    writeTranscript([
      transcriptLine('user', 'u1', '2026-07-28T10:00:00.000Z', 'imported question'),
      transcriptLine('assistant', 'a1', '2026-07-28T10:00:01.000Z', 'imported answer'),
    ]);
    bindClaude('ses_imported', FOREIGN_ID);
    expect(mergeHarnessMessagesIntoSessionMessages([], 'ses_imported').map((record) => (
      [record.info.role, record.parts[0].text]
    ))).toEqual([
      ['user', 'imported question'],
      ['assistant', 'imported answer'],
    ]);
  });

  it('lets a recent live snapshot replace its transcript copy', () => {
    writeTranscript([
      transcriptLine('user', 'u1', '2026-07-28T10:00:00.000Z', 'live question'),
      transcriptLine('assistant', 'a1', '2026-07-28T10:00:01.000Z', 'live answer'),
    ]);
    bindClaude('ses_live', FOREIGN_ID);
    const created = Date.parse('2026-07-28T10:00:02.000Z');
    applyMessage('ses_live', 'msg_live_user', 'user', 'live question', created);
    applyMessage('ses_live', 'msg_live_asst', 'assistant', 'live answer', created);
    expect(new Set(mergeHarnessMessagesIntoSessionMessages([], 'ses_live').map(({ info }) => info.id)))
      .toEqual(new Set(['msg_live_user', 'msg_live_asst']));
  });

  it('hides recovery prompts without closing the original turn', () => {
    writeTranscript([
      transcriptLine('user', 'u1', '2026-07-28T10:00:00.000Z', 'imported question'),
      transcriptLine('assistant', 'a1', '2026-07-28T10:00:01.000Z', 'imported answer'),
      transcriptLine(
        'user',
        'u_recovery',
        '2026-07-28T10:00:02.000Z',
        `${RECOVERY_MARKER}\nContinue the interrupted response.`,
        { isSynthetic: true },
      ),
      transcriptLine('assistant', 'a2', '2026-07-28T10:00:03.000Z', 'recovered continuation'),
    ]);
    bindClaude('ses_recovery', FOREIGN_ID);

    const merged = mergeHarnessMessagesIntoSessionMessages([], 'ses_recovery');
    expect(merged).toHaveLength(2);
    expect(merged[1].info.parentID).toBe(merged[0].info.id);
    expect(merged[1].parts.filter(({ type }) => type === 'text').map(({ text }) => text))
      .toEqual(['imported answer', 'recovered continuation']);
    expect(merged.flatMap(({ parts }) => parts.map(({ text }) => text || '')))
      .not.toContain(`${RECOVERY_MARKER}\nContinue the interrupted response.`);
  });
});
