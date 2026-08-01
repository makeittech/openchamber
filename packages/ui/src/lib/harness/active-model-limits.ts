import type { HarnessCatalog } from '@/types/harness';
import { resolveActiveClaudeModel } from '@/lib/harness/claude-models';
import {
  resolveActiveHarnessTarget,
  type ActiveHarnessTargetArgs,
} from '@/lib/harness/resolve-execution-target';

export type ActiveModelLimits = {
  context: number;
  output: number;
  modelName: string;
  source: 'claude-code' | 'opencode';
};

export function resolveActiveModelLimits(args: ActiveHarnessTargetArgs & {
  claudeCatalog?: HarnessCatalog | null;
  openCodeContext?: number | null;
  openCodeOutput?: number | null;
  openCodeModelName?: string | null;
}): ActiveModelLimits {
  const target = resolveActiveHarnessTarget(args);

  if (target?.harnessId === 'claude-code') {
    const { modelRef, metadata } = resolveActiveClaudeModel(target, args.claudeCatalog);
    return {
      context: metadata.limit?.context ?? 200_000,
      output: metadata.limit?.output ?? 64_000,
      modelName: metadata.name ?? modelRef,
      source: 'claude-code',
    };
  }

  return {
    context: typeof args.openCodeContext === 'number' && Number.isFinite(args.openCodeContext)
      ? args.openCodeContext
      : 0,
    output: typeof args.openCodeOutput === 'number' && Number.isFinite(args.openCodeOutput)
      ? args.openCodeOutput
      : 0,
    modelName: typeof args.openCodeModelName === 'string' ? args.openCodeModelName : '',
    source: 'opencode',
  };
}
