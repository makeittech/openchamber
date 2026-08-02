import { describe, expect, test } from 'bun:test';
import { resolveComposerAttachmentModel } from './composer-attachment-model';
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
      supportsImages: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    }],
  }],
};

const openCodeMetadata = {
  id: 'big-pickle',
  providerId: 'opencode',
  name: 'Big Pickle',
  modalities: { input: ['text'], output: ['text'] },
};

const resolve = (target: Parameters<typeof resolveComposerAttachmentModel>[0]) =>
  resolveComposerAttachmentModel({
    openCodeProviderId: 'opencode',
    openCodeModelId: 'big-pickle',
    openCodeMetadata,
    claudeCatalog,
    ...target,
  });

describe('resolveComposerAttachmentModel', () => {
  test('uses Claude catalog modalities when session target is Claude', () => {
    const resolved = resolve({
      sessionId: 'ses_claude',
      sessionTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });

    expect(resolved.modelKey).toBe('claude-code/sonnet');
    expect(resolved.modelName).toBe('Sonnet');
    expect(resolved.inputModalities).toEqual(['text', 'image']);
  });

  test('falls back to OpenCode metadata when engine is OpenCode', () => {
    const resolved = resolve({
      sessionId: 'ses_oc',
      sessionTarget: {
        harnessId: 'opencode',
        providerId: 'opencode',
        modelId: 'big-pickle',
      },
    });

    expect(resolved.modelKey).toBe('opencode/big-pickle');
    expect(resolved.modelName).toBe('Big Pickle');
    expect(resolved.inputModalities).toEqual(['text']);
  });

  test('uses last-used Claude target for drafts without a session', () => {
    const resolved = resolve({
      sessionId: null,
      lastUsedTarget: { harnessId: 'claude-code', modelRef: 'opus' },
      claudeCatalog: null,
    });

    expect(resolved.modelKey).toBe('claude-code/opus');
    expect(resolved.inputModalities).toContain('image');
  });
});
