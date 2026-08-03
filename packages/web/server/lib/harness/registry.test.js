import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_CODE_MODELS,
  getHarnessCapabilities,
  getHarnessDescriptor,
  HARNESS_CAPABILITIES,
  HARNESS_IDS,
  isKnownHarnessId,
  listHarnessDescriptors,
} from './registry.js';

describe('harness registry', () => {
  it('lists both harness descriptors with full capabilities', () => {
    expect([...HARNESS_IDS]).toEqual(['opencode', 'claude-code']);
    expect(listHarnessDescriptors().map(({ id }) => id)).toEqual([...HARNESS_IDS]);
    for (const id of HARNESS_IDS) {
      expect(Object.keys(getHarnessCapabilities(id))).toEqual([...HARNESS_CAPABILITIES]);
      expect(Object.values(getHarnessCapabilities(id)).every((level) => level === 'full')).toBe(true);
    }
  });

  it('describes each harness authentication path', () => {
    expect(getHarnessDescriptor('opencode').auth.mode).toBe('opencode-providers');
    expect(getHarnessDescriptor('claude-code')).toMatchObject({
      displayName: 'Claude Code',
      auth: { mode: 'subscription-cli' },
      install: { binaryNames: ['claude'] },
    });
  });

  it('publishes current Claude aliases and non-duplicate pinned models', () => {
    const byId = Object.fromEntries(CLAUDE_CODE_MODELS.map((model) => [model.id, model]));
    const expected = [
      ['fable', 'Fable 5', 1_000_000],
      ['opus', 'Opus 5', 1_000_000],
      ['sonnet', 'Sonnet 5', 1_000_000],
      ['haiku', 'Haiku 4.5', 200_000],
      ['claude-opus-4-8', 'Opus 4.8', 1_000_000],
      ['claude-sonnet-4-6', 'Sonnet 4.6', 1_000_000],
    ];
    for (const [id, name, context] of expected) {
      expect(byId[id]).toMatchObject({ name, limit: { context }, reasoning: true, toolCall: true });
    }
    expect(byId.haiku.resolvedId).toBe('claude-haiku-4-5');
    expect(byId['claude-haiku-4-5']).toBeUndefined();
    expect(new Set(CLAUDE_CODE_MODELS.map(({ name }) => name)).size).toBe(CLAUDE_CODE_MODELS.length);
  });

  it('rejects unknown harness ids', () => {
    expect(isKnownHarnessId('codex-cli')).toBe(false);
    expect(getHarnessDescriptor('nope')).toBeNull();
    expect(getHarnessCapabilities('nope')).toBeNull();
  });
});
