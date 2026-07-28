import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bindSession,
  configureSessionBindings,
  resetSessionBindings,
} from '../../session-bindings.js';
import {
  findClaudeTranscriptPath,
  getClaudeTranscriptMessages,
  parseClaudeTranscript,
  readClaudeTranscriptTitle,
  resetClaudeTranscriptCaches,
} from './transcript-messages.js';

const FOREIGN_ID = '123e4567-e89b-42d3-a456-426614174000';

let tmpRoot;
let previousConfigDir;

const writeTranscript = (lines, projectKey = '-tmp-project') => {
  const projectDir = path.join(tmpRoot, 'projects', projectKey);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${FOREIGN_ID}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
};

const baseRecord = (overrides = {}) => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: '/tmp/project',
  sessionId: FOREIGN_ID,
  version: '2.1.220',
  ...overrides,
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-test-'));
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

describe('parseClaudeTranscript', () => {
  it('replays user text, assistant text, thinking, and settled tools', () => {
    const filePath = writeTranscript([
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-28T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
      })),
      JSON.stringify(baseRecord({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-28T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: 'thinking', thinking: 'Let me look at the auth flow', signature: 'sig' },
            { type: 'text', text: 'I will inspect the code.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/project/auth.ts' } },
          ],
        },
      })),
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-07-28T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file bytes' }] },
      })),
      JSON.stringify(baseRecord({
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-07-28T10:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found it — the redirect URL is wrong.' }] },
      })),
    ]);

    const { messages } = parseClaudeTranscript({
      sessionId: 'ses_shell',
      directory: '/tmp/project',
      modelRef: 'opus',
      transcriptPath: filePath,
    });

    expect(messages).toHaveLength(2);
    const [user, assistant] = messages;
    expect(user.info.role).toBe('user');
    expect(user.parts.map((part) => part.text)).toEqual(['Fix the login bug']);

    expect(assistant.info.role).toBe('assistant');
    expect(assistant.info.parentID).toBe(user.info.id);
    expect(assistant.info.modelID).toBe('claude-opus-4-6');
    expect(assistant.info.tokens.input).toBe(10);
    expect(assistant.info.finish).toBe('stop');

    const kinds = assistant.parts.map((part) => part.type);
    expect(kinds).toEqual(['reasoning', 'text', 'tool', 'text']);
    expect(assistant.parts[0].text).toBe('Let me look at the auth flow');
    expect(assistant.parts[2].tool).toBe('Read');
    expect(assistant.parts[2].state.status).toBe('completed');
    expect(assistant.parts[2].state.input).toEqual({ file_path: '/tmp/project/auth.ts' });
    expect(assistant.parts[2].state.output).toBe('file bytes');
    expect(assistant.parts[3].text).toContain('redirect URL');

    // Ids are ascending in transcript order (UI sorts messages among
    // themselves and parts among themselves — each by id).
    const messageIds = messages.map((message) => message.info.id);
    expect(messageIds).toEqual([...messageIds].sort());
    for (const message of messages) {
      const partIds = message.parts.map((part) => part.id);
      expect(partIds).toEqual([...partIds].sort());
    }
  });

  it('marks tool calls that never settled as error instead of running', () => {
    const filePath = writeTranscript([
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-28T10:00:00.000Z',
        message: { role: 'user', content: 'abort this' },
      })),
      JSON.stringify(baseRecord({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-28T10:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'sleep 99' } }],
        },
      })),
    ]);

    const { messages } = parseClaudeTranscript({ sessionId: 'ses_shell', transcriptPath: filePath });
    const tool = messages[1].parts.find((part) => part.type === 'tool');
    expect(tool.state.status).toBe('error');
  });

  it('skips sidechains, meta, and non-message records; reads ai-title', () => {
    const filePath = writeTranscript([
      JSON.stringify({ type: 'summary', summary: 'Old summary' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login redirect', sessionId: FOREIGN_ID }),
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u1',
        isSidechain: true,
        timestamp: '2026-07-28T10:00:00.000Z',
        message: { role: 'user', content: 'subagent thread' },
      })),
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-07-28T10:00:01.000Z',
        message: { role: 'user', content: 'real user turn' },
      })),
    ]);

    const { messages, aiTitle } = parseClaudeTranscript({ sessionId: 'ses_shell', transcriptPath: filePath });
    expect(aiTitle).toBe('Fix login redirect');
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0].text).toBe('real user turn');
  });
});

describe('getClaudeTranscriptMessages', () => {
  it('returns [] without a Claude binding and replays when bound', () => {
    writeTranscript([
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-28T10:00:00.000Z',
        message: { role: 'user', content: 'imported history' },
      })),
    ]);

    expect(getClaudeTranscriptMessages('ses_unbound')).toEqual([]);

    bindSession({
      sessionId: 'ses_bound',
      harnessId: 'claude-code',
      directory: '/tmp/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      foreignSessionId: FOREIGN_ID,
    });

    const messages = getClaudeTranscriptMessages('ses_bound');
    expect(messages).toHaveLength(1);
    expect(messages[0].info.sessionID).toBe('ses_bound');
    expect(messages[0].parts[0].text).toBe('imported history');
  });

  it('serves cached results until the transcript file changes', () => {
    const filePath = writeTranscript([
      JSON.stringify(baseRecord({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-28T10:00:00.000Z',
        message: { role: 'user', content: 'first' },
      })),
    ]);
    bindSession({
      sessionId: 'ses_bound',
      harnessId: 'claude-code',
      directory: '/tmp/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      foreignSessionId: FOREIGN_ID,
    });

    expect(getClaudeTranscriptMessages('ses_bound')).toHaveLength(1);

    fs.appendFileSync(filePath, JSON.stringify(baseRecord({
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-07-28T10:05:00.000Z',
      message: { role: 'user', content: 'second' },
    })) + '\n');
    // mtime granularity guard: bump size+mtime explicitly via utimes.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, future, future);

    expect(getClaudeTranscriptMessages('ses_bound')).toHaveLength(2);
  });
});

describe('findClaudeTranscriptPath / readClaudeTranscriptTitle', () => {
  it('locates transcripts and reads the latest ai-title', () => {
    writeTranscript([
      JSON.stringify({ type: 'ai-title', aiTitle: 'First name', sessionId: FOREIGN_ID }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Renamed session', sessionId: FOREIGN_ID }),
    ]);

    expect(findClaudeTranscriptPath(FOREIGN_ID)).toContain(`${FOREIGN_ID}.jsonl`);
    expect(readClaudeTranscriptTitle(FOREIGN_ID)).toBe('Renamed session');
    expect(readClaudeTranscriptTitle('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
