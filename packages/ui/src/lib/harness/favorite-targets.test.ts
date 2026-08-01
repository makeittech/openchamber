import { describe, expect, test } from 'bun:test';
import {
  CLAUDE_FAVORITE_PROVIDER_ID,
  executionTargetFromFavoriteRef,
  executionTargetsMatchIdentity,
  favoriteRefFromExecutionTarget,
  favoriteTargetsToLegacyRefs,
  legacyRefsToFavoriteTargets,
  normalizeFavoriteTarget,
  sanitizeFavoriteTargets,
} from './favorite-targets';

describe('favorite-targets sanitize', () => {
  test('accepts legacy OpenCode {providerID,modelID} refs', () => {
    const result = sanitizeFavoriteTargets([
      { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      { providerID: 'openai', modelID: 'gpt-4.1' },
    ], 64);
    expect(result).toEqual([
      { harnessId: 'opencode', providerId: 'anthropic', modelId: 'claude-sonnet-4' },
      { harnessId: 'opencode', providerId: 'openai', modelId: 'gpt-4.1' },
    ]);
  });

  test('accepts Claude ExecutionTarget entries and strips permissionMode/effort', () => {
    const result = sanitizeFavoriteTargets([
      { harnessId: 'claude-code', modelRef: 'opus', permissionMode: 'acceptEdits', effort: 'high' },
      { harnessId: 'claude-code', modelRef: 'sonnet' },
    ], 64);
    expect(result).toEqual([
      { harnessId: 'claude-code', modelRef: 'opus' },
      { harnessId: 'claude-code', modelRef: 'sonnet' },
    ]);
  });

  test('treats providerID claude-code sentinel as Claude target', () => {
    const result = sanitizeFavoriteTargets([
      { providerID: CLAUDE_FAVORITE_PROVIDER_ID, modelID: 'haiku' },
    ], 64);
    expect(result).toEqual([{ harnessId: 'claude-code', modelRef: 'haiku' }]);
  });

  test('dedupes by identity and drops malformed entries', () => {
    const result = sanitizeFavoriteTargets([
      { providerID: 'anthropic', modelID: 'sonnet' },
      { harnessId: 'opencode', providerId: 'anthropic', modelId: 'sonnet' },
      { harnessId: 'claude-code' },
      null,
      { providerID: '', modelID: 'x' },
      { harnessId: 'claude-code', modelRef: 'opus', permissionMode: 'not-a-mode' },
    ], 64);
    expect(result).toEqual([
      { harnessId: 'opencode', providerId: 'anthropic', modelId: 'sonnet' },
    ]);
  });

  test('returns undefined for non-arrays', () => {
    expect(sanitizeFavoriteTargets(undefined, 64)).toBe(undefined);
    expect(sanitizeFavoriteTargets({}, 64)).toBe(undefined);
  });

  test('round-trips through legacy refs', () => {
    const targets = [
      { harnessId: 'opencode' as const, providerId: 'anthropic', modelId: 'sonnet' },
      { harnessId: 'claude-code' as const, modelRef: 'opus' },
    ];
    const legacy = favoriteTargetsToLegacyRefs(targets);
    expect(legacy).toEqual([
      { providerID: 'anthropic', modelID: 'sonnet' },
      { providerID: CLAUDE_FAVORITE_PROVIDER_ID, modelID: 'opus' },
    ]);
    expect(legacyRefsToFavoriteTargets(legacy)).toEqual([
      { harnessId: 'opencode', providerId: 'anthropic', modelId: 'sonnet' },
      { harnessId: 'claude-code', modelRef: 'opus' },
    ]);
  });

  test('normalizes OpenCode camelCase entries', () => {
    expect(sanitizeFavoriteTargets([{
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt',
      agentName: 'build',
      variant: 'high',
    }], 64)).toEqual([{ harnessId: 'opencode', providerId: 'openai', modelId: 'gpt' }]);
  });

  test('identity helpers ignore permissionMode and effort', () => {
    const a = {
      harnessId: 'claude-code' as const,
      modelRef: 'sonnet',
      permissionMode: 'plan' as const,
      effort: 'max' as const,
    };
    const b = { harnessId: 'claude-code' as const, modelRef: 'sonnet' };
    expect(executionTargetsMatchIdentity(normalizeFavoriteTarget(a), b)).toBe(true);
    expect(executionTargetFromFavoriteRef(favoriteRefFromExecutionTarget(a))).toEqual(b);
  });

  test('rejects Claude favorites with unknown effort', () => {
    const result = sanitizeFavoriteTargets([
      { harnessId: 'claude-code', modelRef: 'opus', effort: 'turbo' },
    ], 64);
    expect(result).toEqual([]);
  });
});
