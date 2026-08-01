import { describe, expect, test } from 'bun:test';
import {
  HARNESS_SETTINGS_DEFAULTS,
  sanitizeHarnessSettings,
  withHarnessSettingsDefaults,
} from './settings';

describe('sanitizeHarnessSettings', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['valid fields', {
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeEnabled: true,
      harnessClaudeCodeAgentsMode: 'claude',
    }, {
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeEnabled: true,
      harnessClaudeCodeAgentsMode: 'claude',
    }],
    ['invalid enums', {
      harnessDefaultId: 'codex-cli',
      harnessClaudeCodeAgentsMode: 'cursor',
    }, {
      harnessDefaultId: 'opencode',
      harnessClaudeCodeAgentsMode: 'opencode',
    }],
    ['wrong-typed booleans', {
      harnessWarnOnSwitch: 'yes',
      harnessClaudeCodeEnabled: 1,
    }, {}],
    ['missing fields', {}, {}],
    ['legacy fields', {
      enginesDefaultHarnessId: 'claude-code',
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
      enginesClaudeCodeEnabled: false,
      enginesClaudeCodeAgentsMode: 'claude',
    }, {
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeEnabled: false,
      harnessClaudeCodeAgentsMode: 'claude',
    }],
    ['new fields over legacy fields', {
      harnessWarnOnSwitch: true,
      enginesClaudeCodeWarnOnOpenCodeHandoff: false,
    }, { harnessWarnOnSwitch: true }],
  ];
  for (const [name, input, expected] of cases) {
    test(`sanitizes ${name}`, () => {
      expect(sanitizeHarnessSettings(input)).toEqual(expected);
    });
  }
});

describe('withHarnessSettingsDefaults', () => {
  for (const partial of [undefined, {}]) {
    test(`applies defaults to ${String(partial)}`, () => {
      expect(withHarnessSettingsDefaults(partial)).toEqual(HARNESS_SETTINGS_DEFAULTS);
    });
  }

  test('preserves overrides', () => {
    expect(withHarnessSettingsDefaults({
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeAgentsMode: 'claude',
    })).toEqual({
      ...HARNESS_SETTINGS_DEFAULTS,
      harnessDefaultId: 'claude-code',
      harnessWarnOnSwitch: false,
      harnessClaudeCodeAgentsMode: 'claude',
    });
  });
});
