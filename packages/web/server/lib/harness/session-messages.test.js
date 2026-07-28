import { beforeEach, afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindSession,
  configureSessionBindings,
  resetSessionBindings,
} from './session-bindings.js';
import {
  applyHarnessEventToSnapshot,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';
import { resetClaudeTranscriptCaches } from './translators/claude-code/transcript-messages.js';
import { mergeHarnessMessagesIntoSessionMessages } from './session-messages.js';

describe('mergeHarnessMessagesIntoSessionMessages', () => {
  beforeEach(() => {
    resetSessionBindings();
    configureSessionBindings({ persist: false, load: true });
    resetHarnessTurnSnapshots();
  });

  it('returns OpenCode messages unchanged for non-Claude sessions', () => {
    const openCode = [{ info: { id: 'msg_1', role: 'user', sessionID: 'ses_oc' }, parts: [] }];
    expect(mergeHarnessMessagesIntoSessionMessages(openCode, 'ses_oc')).toEqual(openCode);
  });

  it('fills empty OpenCode lists from the Claude turn snapshot', () => {
    bindSession({
      sessionId: 'ses_claude',
      harnessId: 'claude-code',
      directory: '/repo',
      target: { harnessId: 'claude-code', modelRef: 'haiku' },
    });
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: { id: 'msg_01_user', role: 'user', sessionID: 'ses_claude' },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_1',
          sessionID: 'ses_claude',
          messageID: 'msg_01_user',
          type: 'text',
          text: 'hi',
        },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: { id: 'msg_02_asst', role: 'assistant', sessionID: 'ses_claude' },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_2',
          sessionID: 'ses_claude',
          messageID: 'msg_02_asst',
          type: 'text',
          text: 'READY1',
        },
      },
    }, '/repo');

    const merged = mergeHarnessMessagesIntoSessionMessages([], 'ses_claude');
    expect(merged).toHaveLength(2);
    expect(merged[0].info.id).toBe('msg_01_user');
    expect(merged[0].parts?.[0]?.text).toBe('hi');
    expect(merged[1].info.id).toBe('msg_02_asst');
    expect(merged[1].parts?.[0]?.text).toBe('READY1');
  });
});

describe('mergeHarnessMessagesIntoSessionMessages + transcript replay', () => {
  const FOREIGN_ID = '123e4567-e89b-42d3-a456-426614174000';
  let tmpRoot;
  let previousConfigDir;

  const writeTranscript = (lines) => {
    const projectDir = path.join(tmpRoot, 'projects', '-repo');
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${FOREIGN_ID}.jsonl`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    return filePath;
  };

  const transcriptUser = (uuid, timestamp, text) => JSON.stringify({
    type: 'user',
    uuid,
    timestamp,
    sessionId: FOREIGN_ID,
    cwd: '/repo',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

  const transcriptAssistant = (uuid, timestamp, text) => JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp,
    sessionId: FOREIGN_ID,
    cwd: '/repo',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-messages-test-'));
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpRoot;
    resetSessionBindings();
    configureSessionBindings({ persist: false, load: true });
    resetHarnessTurnSnapshots();
    resetClaudeTranscriptCaches();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    resetClaudeTranscriptCaches();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('serves imported session history from the Claude transcript on disk', () => {
    writeTranscript([
      transcriptUser('u1', '2026-07-28T10:00:00.000Z', 'imported question'),
      transcriptAssistant('a1', '2026-07-28T10:00:01.000Z', 'imported answer'),
    ]);
    bindSession({
      sessionId: 'ses_imported',
      harnessId: 'claude-code',
      directory: '/repo',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      foreignSessionId: FOREIGN_ID,
    });

    const merged = mergeHarnessMessagesIntoSessionMessages([], 'ses_imported');
    expect(merged).toHaveLength(2);
    expect(merged[0].info.role).toBe('user');
    expect(merged[0].parts?.[0]?.text).toBe('imported question');
    expect(merged[1].info.role).toBe('assistant');
    expect(merged[1].parts?.[0]?.text).toBe('imported answer');
  });

  it('does not duplicate the turn the live snapshot already covers', () => {
    // The live turn is flushed to the same JSONL the replay reads.
    writeTranscript([
      transcriptUser('u1', '2026-07-28T10:00:00.000Z', 'live question'),
      transcriptAssistant('a1', '2026-07-28T10:00:01.000Z', 'live answer'),
    ]);
    bindSession({
      sessionId: 'ses_live',
      harnessId: 'claude-code',
      directory: '/repo',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      foreignSessionId: FOREIGN_ID,
    });

    const now = Date.parse('2026-07-28T10:00:02.000Z');
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: { id: 'msg_live_user', role: 'user', sessionID: 'ses_live', time: { created: now } },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_live_u',
          sessionID: 'ses_live',
          messageID: 'msg_live_user',
          type: 'text',
          text: 'live question',
        },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: {
        info: { id: 'msg_live_asst', role: 'assistant', sessionID: 'ses_live', time: { created: now } },
      },
    }, '/repo');
    applyHarnessEventToSnapshot({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_live_a',
          sessionID: 'ses_live',
          messageID: 'msg_live_asst',
          type: 'text',
          text: 'live answer',
        },
      },
    }, '/repo');

    const merged = mergeHarnessMessagesIntoSessionMessages([], 'ses_live');
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((record) => record.info.id)))
      .toEqual(new Set(['msg_live_user', 'msg_live_asst']));
  });
});
