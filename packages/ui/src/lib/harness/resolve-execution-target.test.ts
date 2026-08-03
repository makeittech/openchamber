import { beforeEach, describe, expect, test } from 'bun:test';
import { useSelectionStore } from '@/sync/selection-store';
import {
  buildOpenCodeExecutionTarget,
  persistSessionExecutionTarget,
  resolveExecutionTarget,
} from './resolve-execution-target';

beforeEach(() => {
  useSelectionStore.setState({
    sessionTargets: new Map(),
    pendingHandoffTargets: new Map(),
    lastUsedTarget: null,
  });
});

describe('resolveExecutionTarget', () => {
  test('prefers sticky session target over last-used', () => {
    persistSessionExecutionTarget('ses_a', { harnessId: 'claude-code', modelRef: 'opus' });
    useSelectionStore.getState().saveLastUsedTarget({
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt',
    });

    expect(resolveExecutionTarget({
      sessionId: 'ses_a',
      providerID: 'openai',
      modelID: 'gpt',
    })).toEqual({ harnessId: 'claude-code', modelRef: 'opus' });
  });

  test('falls back to last-used when session has no target', () => {
    useSelectionStore.getState().saveLastUsedTarget({
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });

    expect(resolveExecutionTarget({
      sessionId: 'ses_new',
      providerID: 'openai',
      modelID: 'gpt',
    })).toEqual({ harnessId: 'claude-code', modelRef: 'sonnet' });
  });

  test('defaults to OpenCode from provider/model args', () => {
    expect(resolveExecutionTarget({
      sessionId: 'ses_b',
      providerID: 'anthropic',
      modelID: 'claude-3',
      agent: 'build',
      variant: 'high',
    })).toEqual(buildOpenCodeExecutionTarget({
      providerID: 'anthropic',
      modelID: 'claude-3',
      agent: 'build',
      variant: 'high',
    }));
  });
});
