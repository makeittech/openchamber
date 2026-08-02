import { describe, expect, test } from 'bun:test';
import { resolveActiveModelLimits } from './active-model-limits';
import type { HarnessCatalog } from '@/types/harness';
import { STATIC_HARNESS_CAPABILITIES } from './capabilities';

const claudeCatalog: HarnessCatalog = {
  descriptor: {
    id: 'claude-code',
    displayName: 'Claude Code',
    shortName: 'Claude',
    auth: { mode: 'subscription-cli' },
    capabilities: STATIC_HARNESS_CAPABILITIES['claude-code'],
    install: { binaryNames: ['claude'], docsUrl: 'https://example.com' },
  },
  status: 'ready',
  sections: [{
    id: 'models',
    name: 'Models',
    kind: 'models',
    models: [{
      id: 'sonnet',
      name: 'Sonnet',
      limit: { context: 200_000, output: 64_000 },
    }],
  }],
};

const resolve = (target: Parameters<typeof resolveActiveModelLimits>[0]) => resolveActiveModelLimits({
  claudeCatalog,
  openCodeContext: 128_000,
  openCodeOutput: 8_000,
  openCodeModelName: 'Big Pickle',
  ...target,
});

describe('resolveActiveModelLimits', () => {
  test('uses Claude catalog limits when session target is Claude', () => {
    expect(resolve({
      sessionId: 'ses_claude',
      sessionTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
    })).toEqual({
      context: 200_000,
      output: 64_000,
      modelName: 'Sonnet',
      source: 'claude-code',
    });
  });

  test('keeps OpenCode limits when engine is OpenCode', () => {
    expect(resolve({
      sessionId: 'ses_oc',
      sessionTarget: {
        harnessId: 'opencode',
        providerId: 'opencode',
        modelId: 'big-pickle',
      },
    })).toEqual({
      context: 128_000,
      output: 8_000,
      modelName: 'Big Pickle',
      source: 'opencode',
    });
  });

  test('uses last-used Claude target for drafts without a session', () => {
    expect(resolve({
      sessionId: null,
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
    })).toEqual({
      context: 200_000,
      output: 64_000,
      modelName: 'Sonnet',
      source: 'claude-code',
    });
  });
});
