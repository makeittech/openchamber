import { describe, expect, test } from 'bun:test';

import {
  buildHandoffContextText,
  parseHandoffContextText,
} from './handoff-context';

describe('buildHandoffContextText', () => {
  test('duplicate mode wraps the body with markers and background instruction', () => {
    const text = buildHandoffContextText({
      sourceLabel: 'OpenCode',
      mode: 'duplicate',
      body: 'User:\nhello',
      targetHarnessId: 'opencode',
    });
    expect(text).toContain('--- BEGIN SESSION CONTEXT (transferred from OpenCode) ---');
    expect(text).toContain('User:\nhello');
    expect(text).toContain('--- END SESSION CONTEXT ---');
    expect(text).toContain('Use the context above as background');
    expect(text).not.toContain('Acknowledge it');
  });

  test('summarize mode labels the header as a summary', () => {
    const text = buildHandoffContextText({
      sourceLabel: 'Claude Code',
      mode: 'summarize',
      body: 'summary body',
      targetHarnessId: 'opencode',
    });
    expect(text).toContain('--- BEGIN SESSION CONTEXT (summary of previous Claude Code session) ---');
  });

  test('claude target asks for a brief acknowledgment', () => {
    const text = buildHandoffContextText({
      sourceLabel: 'OpenCode',
      mode: 'duplicate',
      body: 'body',
      targetHarnessId: 'claude-code',
    });
    expect(text).toContain('Acknowledge it in one short sentence');
  });
});

describe('parseHandoffContextText', () => {
  test('round-trips a built message', () => {
    const built = buildHandoffContextText({
      sourceLabel: 'OpenCode',
      mode: 'duplicate',
      body: 'line one\nline two',
      targetHarnessId: 'opencode',
    });
    const parsed = parseHandoffContextText(built);
    expect(parsed).not.toBeNull();
    expect(parsed?.header).toBe('transferred from OpenCode');
    expect(parsed?.body).toBe('line one\nline two');
  });

  test('rejects regular user text', () => {
    expect(parseHandoffContextText('hello world')).toBeNull();
  });

  test('rejects marker-like text without the end marker', () => {
    expect(parseHandoffContextText('--- BEGIN SESSION CONTEXT (x) ---\nbody')).toBeNull();
  });
});
