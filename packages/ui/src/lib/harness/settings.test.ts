import { describe, expect, test } from 'bun:test';

import {
  HARNESS_SETTINGS_DEFAULTS,
  sanitizeHarnessSettings,
  withHarnessSettingsDefaults,
} from './settings';

describe('sanitizeHarnessSettings', () => {
  test('keeps valid harness id, booleans, and agents mode', () => {
    expect(sanitizeHarnessSettings({
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeEnabled: true,
      harnessClaudeCodeAgentsMode: 'claude',
    })).toEqual({
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeEnabled: true,
      harnessClaudeCodeAgentsMode: 'claude',
    });
  });

  test('invalid harness id falls back to opencode', () => {
    expect(sanitizeHarnessSettings({
      harnessDefaultId: 'codex-cli',
    })).toEqual({
      harnessDefaultId: 'opencode',
    });
  });

  test('invalid agents mode falls back to opencode', () => {
    expect(sanitizeHarnessSettings({
      harnessClaudeCodeAgentsMode: 'cursor',
    })).toEqual({
      harnessClaudeCodeAgentsMode: 'opencode',
    });
  });

  test('omits wrong-typed boolean fields', () => {
    expect(sanitizeHarnessSettings({
      harnessWarnOnSwitch: 'yes',
      harnessClaudeCodeEnabled: 1,
    })).toEqual({});
  });

  test('omits missing fields', () => {
    expect(sanitizeHarnessSettings({})).toEqual({});
  });

  test('migrates legacy engines* keys when new keys are absent', () => {
    expect(sanitizeHarnessSettings({
      enginesDefaultHarnessId: 'claude-code',
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
      enginesClaudeCodeEnabled: false,
      enginesClaudeCodeAgentsMode: 'claude',
    })).toEqual({
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeEnabled: false,
      harnessClaudeCodeAgentsMode: 'claude',
    });
  });

  test('new keys win over legacy engines* keys', () => {
    expect(sanitizeHarnessSettings({
      harnessWarnOnSwitch: true,
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
    })).toEqual({
      harnessWarnOnSwitch: true,
    });
  });

  test('legacy invalid values fall back like new ones', () => {
    expect(sanitizeHarnessSettings({
      enginesDefaultHarnessId: 'codex-cli',
      enginesClaudeCodeAgentsMode: 'cursor',
    })).toEqual({
      harnessDefaultId: 'opencode',
      harnessClaudeCodeAgentsMode: 'opencode',
    });
  });
});

describe('withHarnessSettingsDefaults', () => {
  test('applies product defaults when empty', () => {
    expect(withHarnessSettingsDefaults(undefined)).toEqual(HARNESS_SETTINGS_DEFAULTS);
    expect(withHarnessSettingsDefaults({})).toEqual(HARNESS_SETTINGS_DEFAULTS);
  });

  test('preserves sanitized overrides', () => {
    expect(withHarnessSettingsDefaults({
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeAgentsMode: 'claude',
    })).toEqual({
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeEnabled: true,
      harnessClaudeCodeAgentsMode: 'claude',
    });
  });
});
