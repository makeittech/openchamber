import { describe, expect, it } from 'vitest';
import {
  MENTION_HISTORY_MAX,
  formatChannelHistoryPrompt,
  parseMentionHistoryRequest,
} from './discord-mention-history.js';

describe('parseMentionHistoryRequest', () => {
  it('reads only the previous message when the mention body is empty', () => {
    expect(parseMentionHistoryRequest('')).toEqual({ historyCount: 1, prompt: '' });
    expect(parseMentionHistoryRequest('   ')).toEqual({ historyCount: 1, prompt: '' });
  });

  it('treats a leading integer as the history window', () => {
    expect(parseMentionHistoryRequest('5')).toEqual({ historyCount: 5, prompt: '' });
    expect(parseMentionHistoryRequest('5 summarize this')).toEqual({
      historyCount: 5,
      prompt: 'summarize this',
    });
  });

  it('clamps history count to the allowed range', () => {
    expect(parseMentionHistoryRequest('0')).toEqual({ historyCount: 1, prompt: '' });
    expect(parseMentionHistoryRequest(String(MENTION_HISTORY_MAX + 10))).toEqual({
      historyCount: MENTION_HISTORY_MAX,
      prompt: '',
    });
  });

  it('leaves normal prompts alone without fetching history', () => {
    expect(parseMentionHistoryRequest('fix the flaky test')).toEqual({
      historyCount: null,
      prompt: 'fix the flaky test',
    });
    expect(parseMentionHistoryRequest('5summarize')).toEqual({
      historyCount: null,
      prompt: '5summarize',
    });
  });
});

describe('formatChannelHistoryPrompt', () => {
  const messages = [
    { author: { username: 'bob' }, content: 'newest' },
    { author: { global_name: 'Alice', username: 'alice' }, content: 'oldest' },
  ];

  it('renders chronological history and appends an empty-body instruction', () => {
    expect(formatChannelHistoryPrompt({ messages })).toBe(
      [
        'Recent channel messages:',
        'Alice: oldest',
        'bob: newest',
        '',
        'Respond to the conversation above.',
      ].join('\n'),
    );
  });

  it('appends the user request when provided', () => {
    expect(formatChannelHistoryPrompt({ messages, userPrompt: 'summarize' })).toBe(
      [
        'Recent channel messages:',
        'Alice: oldest',
        'bob: newest',
        '',
        'User request:',
        'summarize',
      ].join('\n'),
    );
  });

  it('notes attachments when the message body is empty', () => {
    expect(
      formatChannelHistoryPrompt({
        messages: [{ author: { username: 'bob' }, content: '', attachments: [{ id: '1' }] }],
      }),
    ).toContain('bob: [1 attachment]');
  });
});
