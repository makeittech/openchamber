import { describe, expect, test } from 'bun:test';

import { buildRetryStatusLabel, getRetryCountdownSeconds } from './retryStatus';

const messages = {
  'chat.statusRow.retrying': 'Retrying when capacity is available',
  'chat.statusRow.retryingIn': 'Retrying in {countdown}',
  'chat.statusRow.retryAttempt': '(attempt {attempt})',
  'chat.statusRow.recoveryBlocked': 'Automatic recovery is blocked. Stop this session to cancel recovery.',
} as const;

const t = (key: keyof typeof messages, params?: Record<string, string | number>) => {
  let value: string = messages[key];
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
};

describe('retry status presentation', () => {
  test('counts down from an absolute millisecond deadline', () => {
    expect(getRetryCountdownSeconds(1_800_000_010_500, 1_800_000_009_001)).toBe(2);
    expect(getRetryCountdownSeconds(1_800_000_010_500, 1_800_000_010_500)).toBe(0);
  });

  test('does not reinterpret a relative or seconds-based deadline', () => {
    expect(getRetryCountdownSeconds(30, 10_000)).toBeNull();
  });

  test('shows an attempt suffix only after attempt one', () => {
    expect(buildRetryStatusLabel({ attempt: 1, next: 1_800_000_070_000 }, t, 1_800_000_010_000)).toBe('Retrying in 1m');
    expect(buildRetryStatusLabel({ attempt: 2, next: 1_800_000_070_000 }, t, 1_800_000_010_000)).toBe('Retrying in 1m (attempt 2)');
  });

  test('uses honest unknown-deadline copy', () => {
    expect(buildRetryStatusLabel({ attempt: 1 }, t, 10_000)).toBe('Retrying when capacity is available');
  });

  test('maps blocked recovery to a stable cancellable message without a countdown', () => {
    expect(buildRetryStatusLabel({
      attempt: 3,
      message: 'claude-recovery-blocked',
      next: 999_999_999_999,
    }, t, 10_000)).toBe('Automatic recovery is blocked. Stop this session to cancel recovery.');
  });
});
