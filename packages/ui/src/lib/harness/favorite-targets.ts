import type { ExecutionTarget } from '@/types/harness';
import { isClaudeEffort, isClaudePermissionMode, isExecutionTarget, isHarnessId } from '@/types/harness';

export const CLAUDE_FAVORITE_PROVIDER_ID = 'claude-code';

export type LegacyModelRef = { providerID: string; modelID: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function executionTargetIdentityKey(target: ExecutionTarget): string {
  if (target.harnessId === 'claude-code') {
    return `claude-code:${target.modelRef}`;
  }
  return `opencode:${target.providerId}/${target.modelId}`;
}

export function executionTargetsMatchIdentity(a: ExecutionTarget, b: ExecutionTarget): boolean {
  return executionTargetIdentityKey(a) === executionTargetIdentityKey(b);
}

export function normalizeFavoriteTarget(target: ExecutionTarget): ExecutionTarget {
  if (target.harnessId === 'claude-code') {
    return { harnessId: 'claude-code', modelRef: target.modelRef };
  }
  return {
    harnessId: 'opencode',
    providerId: target.providerId,
    modelId: target.modelId,
  };
}

export function favoriteRefFromExecutionTarget(target: ExecutionTarget): LegacyModelRef {
  if (target.harnessId === 'claude-code') {
    return { providerID: CLAUDE_FAVORITE_PROVIDER_ID, modelID: target.modelRef };
  }
  return { providerID: target.providerId, modelID: target.modelId };
}

export function executionTargetFromFavoriteRef(ref: LegacyModelRef): ExecutionTarget | null {
  const providerID = typeof ref.providerID === 'string' ? ref.providerID.trim() : '';
  const modelID = typeof ref.modelID === 'string' ? ref.modelID.trim() : '';
  if (!providerID || !modelID) return null;
  if (providerID === CLAUDE_FAVORITE_PROVIDER_ID) {
    return { harnessId: 'claude-code', modelRef: modelID };
  }
  return {
    harnessId: 'opencode',
    providerId: providerID,
    modelId: modelID,
  };
}

function parseFavoriteTargetEntry(value: unknown): ExecutionTarget | null {
  if (!isRecord(value)) return null;

  if (isExecutionTarget(value)) {
    return normalizeFavoriteTarget(value);
  }

  if (value.harnessId === 'opencode' || value.harnessId === undefined) {
    const providerId = typeof value.providerId === 'string'
      ? value.providerId.trim()
      : typeof value.providerID === 'string'
        ? value.providerID.trim()
        : '';
    const modelId = typeof value.modelId === 'string'
      ? value.modelId.trim()
      : typeof value.modelID === 'string'
        ? value.modelID.trim()
        : '';
    if (providerId && modelId) {
      if (providerId === CLAUDE_FAVORITE_PROVIDER_ID) {
        return { harnessId: 'claude-code', modelRef: modelId };
      }
      return { harnessId: 'opencode', providerId, modelId };
    }
  }

  if (value.harnessId === 'claude-code') {
    const modelRef = typeof value.modelRef === 'string'
      ? value.modelRef.trim()
      : typeof value.modelID === 'string'
        ? value.modelID.trim()
        : typeof value.modelId === 'string'
          ? value.modelId.trim()
          : '';
    if (!modelRef) return null;
    const permissionMode = value.permissionMode;
    if (permissionMode !== undefined && !isClaudePermissionMode(permissionMode)) {
      return null;
    }
    if (value.effort !== undefined && !isClaudeEffort(value.effort)) {
      return null;
    }
    return { harnessId: 'claude-code', modelRef };
  }

  if (isHarnessId(value.harnessId)) {
    return null;
  }

  return executionTargetFromFavoriteRef({
    providerID: typeof value.providerID === 'string' ? value.providerID : '',
    modelID: typeof value.modelID === 'string' ? value.modelID : '',
  });
}

export function sanitizeFavoriteTargets(
  value: unknown,
  limit: number,
): ExecutionTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const result: ExecutionTarget[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const target = parseFavoriteTargetEntry(entry);
    if (!target) continue;
    const key = executionTargetIdentityKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
    if (result.length >= limit) break;
  }

  return result;
}

export function favoriteTargetsToLegacyRefs(targets: ExecutionTarget[]): LegacyModelRef[] {
  return targets.map(favoriteRefFromExecutionTarget);
}

export function legacyRefsToFavoriteTargets(refs: LegacyModelRef[]): ExecutionTarget[] {
  const result: ExecutionTarget[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const target = executionTargetFromFavoriteRef(ref);
    if (!target) continue;
    const key = executionTargetIdentityKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}
