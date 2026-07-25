import { beforeEach, describe, expect, test } from 'bun:test';
import type { EngineCatalog, HarnessId } from '@/types/harness';
import { useSelectionStore } from '@/sync/selection-store';
import { useHarnessStore } from '@/stores/useHarnessStore';
import {
  getHarnessCapabilityLevel,
  resolveSessionHarnessId,
  sessionSupports,
  STATIC_HARNESS_CAPABILITIES,
} from './capabilities';

beforeEach(() => {
  useSelectionStore.setState({
    sessionTargets: new Map(),
    pendingHandoffTargets: new Map(),
    lastUsedTarget: null,
  });
  useHarnessStore.setState({
    catalogs: [],
    catalogsById: {},
    loadState: 'idle',
    error: null,
    selectedHarnessId: 'opencode',
    isDetecting: {},
    scopeKey: null,
  });
});

describe('sessionSupports', () => {
  test('defaults to OpenCode capabilities when no target is known', () => {
    expect(resolveSessionHarnessId(null)).toBe('opencode');
    expect(sessionSupports(null, 'goal')).toBe(true);
    expect(sessionSupports(null, 'multirun')).toBe(true);
  });

  test('returns false for Claude sessions on goal/multirun', () => {
    useSelectionStore.getState().saveSessionTarget('ses_claude', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });
    expect(sessionSupports('ses_claude', 'goal')).toBe(false);
    expect(sessionSupports('ses_claude', 'multirun')).toBe(false);
    expect(sessionSupports('ses_claude', 'prompt')).toBe(true);
    expect(sessionSupports('ses_claude', 'abort')).toBe(true);
  });

  test('returns Cursor static capabilities for cursor sessions', () => {
    useSelectionStore.getState().saveSessionTarget('ses_cursor', {
      harnessId: 'cursor',
      modelRef: 'composer-1.5',
    });
    expect(sessionSupports('ses_cursor', 'prompt')).toBe(true);
    expect(sessionSupports('ses_cursor', 'abort')).toBe(true);
    expect(sessionSupports('ses_cursor', 'resume')).toBe(true);
    expect(sessionSupports('ses_cursor', 'shell')).toBe(false);
    expect(sessionSupports('ses_cursor', 'slash-commands')).toBe(false);
    expect(sessionSupports('ses_cursor', 'images')).toBe(false);
    expect(sessionSupports('ses_cursor', 'goal')).toBe(false);
    expect(STATIC_HARNESS_CAPABILITIES.cursor.resume).toBe('partial');
    expect(STATIC_HARNESS_CAPABILITIES.cursor['streaming-tools']).toBe('none');
  });

  test('prefers sticky session target over last-used', () => {
    useSelectionStore.setState({
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'opus' },
    });
    useSelectionStore.getState().saveSessionTarget('ses_oc', {
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'sonnet',
    });
    expect(sessionSupports('ses_oc', 'goal')).toBe(true);
  });

  test('uses pending handoff when sticky target is absent', () => {
    useSelectionStore.getState().setPendingHandoffTarget('ses_new', {
      harnessId: 'claude-code',
      modelRef: 'haiku',
    });
    expect(sessionSupports('ses_new', 'goal')).toBe(false);
  });

  test('falls back to last-used target for drafts', () => {
    useSelectionStore.setState({
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    expect(sessionSupports(null, 'goal')).toBe(false);
  });

  test('prefers catalog capability levels when present', () => {
    const catalog: EngineCatalog = {
      engine: {
        id: 'claude-code',
        displayName: 'Claude Code',
        shortName: 'Claude',
        auth: { mode: 'subscription-cli' },
        capabilities: {
          ...STATIC_HARNESS_CAPABILITIES['claude-code'],
          prompt: 'none',
        },
        install: { binaryNames: ['claude'], docsUrl: 'https://example.com' },
      },
      status: 'ready',
      sections: [],
    };
    useHarnessStore.setState({
      catalogs: [catalog],
      catalogsById: { 'claude-code': catalog } as Partial<Record<HarnessId, EngineCatalog>>,
      loadState: 'ready',
      error: null,
    });
    expect(getHarnessCapabilityLevel('claude-code', 'prompt')).toBe('none');
    expect(getHarnessCapabilityLevel('claude-code', 'goal')).toBe('none');
  });
});
