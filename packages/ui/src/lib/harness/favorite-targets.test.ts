import { describe, expect, test } from 'bun:test';
import {
  CLAUDE_FAVORITE_PROVIDER_ID,
  CURSOR_FAVORITE_PROVIDER_ID,
  executionTargetFromFavoriteRef,
  executionTargetIdentityKey,
  favoriteRefFromExecutionTarget,
  favoriteTargetsToLegacyRefs,
  legacyRefsToFavoriteTargets,
  normalizeFavoriteTarget,
  parseFavoriteTargetEntry,
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

  test('accepts Claude ExecutionTarget entries and strips permissionMode', () => {
    const result = sanitizeFavoriteTargets([
      { harnessId: 'claude-code', modelRef: 'opus', permissionMode: 'acceptEdits' },
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

  test('accepts Cursor ExecutionTarget entries and strips variant', () => {
    const result = sanitizeFavoriteTargets([
      { harnessId: 'cursor', modelRef: 'composer-1.5', variant: 'high' },
      { harnessId: 'cursor', modelRef: 'gpt-5.2' },
    ], 64);
    expect(result).toEqual([
      { harnessId: 'cursor', modelRef: 'composer-1.5' },
      { harnessId: 'cursor', modelRef: 'gpt-5.2' },
    ]);
  });

  test('treats providerID cursor sentinel as Cursor target', () => {
    const result = sanitizeFavoriteTargets([
      { providerID: CURSOR_FAVORITE_PROVIDER_ID, modelID: 'composer-1.5' },
    ], 64);
    expect(result).toEqual([{ harnessId: 'cursor', modelRef: 'composer-1.5' }]);
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
      { harnessId: 'cursor' as const, modelRef: 'composer-1.5' },
    ];
    const legacy = favoriteTargetsToLegacyRefs(targets);
    expect(legacy).toEqual([
      { providerID: 'anthropic', modelID: 'sonnet' },
      { providerID: CLAUDE_FAVORITE_PROVIDER_ID, modelID: 'opus' },
      { providerID: CURSOR_FAVORITE_PROVIDER_ID, modelID: 'composer-1.5' },
    ]);
    expect(legacyRefsToFavoriteTargets(legacy)).toEqual([
      { harnessId: 'opencode', providerId: 'anthropic', modelId: 'sonnet' },
      { harnessId: 'claude-code', modelRef: 'opus' },
      { harnessId: 'cursor', modelRef: 'composer-1.5' },
    ]);
  });

  test('parseFavoriteTargetEntry normalizes OpenCode camelCase', () => {
    expect(parseFavoriteTargetEntry({
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt',
      agentName: 'build',
      variant: 'high',
    })).toEqual({ harnessId: 'opencode', providerId: 'openai', modelId: 'gpt' });
  });

  test('identity helpers ignore permissionMode', () => {
    const a = { harnessId: 'claude-code' as const, modelRef: 'sonnet', permissionMode: 'plan' as const };
    const b = { harnessId: 'claude-code' as const, modelRef: 'sonnet' };
    expect(executionTargetIdentityKey(normalizeFavoriteTarget(a))).toBe(executionTargetIdentityKey(b));
    expect(executionTargetFromFavoriteRef(favoriteRefFromExecutionTarget(a))).toEqual(b);
  });

  test('identity helpers ignore cursor variant', () => {
    const a = { harnessId: 'cursor' as const, modelRef: 'gpt-5.2', variant: 'high' };
    const b = { harnessId: 'cursor' as const, modelRef: 'gpt-5.2' };
    expect(executionTargetIdentityKey(normalizeFavoriteTarget(a))).toBe('cursor:gpt-5.2');
    expect(executionTargetIdentityKey(normalizeFavoriteTarget(a))).toBe(executionTargetIdentityKey(b));
  });
});
