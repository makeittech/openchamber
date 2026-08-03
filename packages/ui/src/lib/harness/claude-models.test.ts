import { describe, expect, test } from 'bun:test';
import {
  buildClaudeModelMetadata,
  buildClaudeModelMetadataMap,
  CLAUDE_EFFORT_LEVELS,
  isClaudeEffort,
  resolveClaudeCatalogModel,
} from './claude-models';

describe('claude-models', () => {
  test('recognizes Claude effort levels', () => {
    expect(CLAUDE_EFFORT_LEVELS).toContain('high');
    expect(isClaudeEffort('xhigh')).toBe(true);
    expect(isClaudeEffort('turbo')).toBe(false);
  });

  test('builds subscription metadata without API cost pricing', () => {
    const metadata = buildClaudeModelMetadata({
      id: 'sonnet',
      name: 'Sonnet',
      supportsImages: true,
      supportsDocuments: true,
      reasoning: true,
      toolCall: true,
      limit: { context: 200_000, output: 64_000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
    });

    expect(metadata.providerId).toBe('claude-code');
    expect(metadata.name).toBe('Sonnet');
    expect(metadata.tool_call).toBe(true);
    expect(metadata.reasoning).toBe(true);
    expect(metadata.limit?.context).toBe(200_000);
    expect(metadata.cost).toEqual(undefined);
    expect(metadata.modalities?.input).toEqual(['text', 'image']);
  });

  test('maps catalog models for picker metadata lookups', () => {
    const map = buildClaudeModelMetadataMap([
      { id: 'haiku', name: 'Haiku', supportsImages: true },
    ]);
    expect(map.get('claude-code/haiku')?.name).toBe('Haiku');
  });

  test('resolves unknown model refs with Claude defaults', () => {
    const model = resolveClaudeCatalogModel([], 'custom-ref');
    expect(model.id).toBe('custom-ref');
    expect(model.limit?.context).toBe(200_000);
  });
});
