/**
 * Resolve which model metadata the composer should use for attachment
 * modality warnings. Must follow the active ExecutionTarget (Claude vs OpenCode),
 * not only OpenCode config-store currentProvider/currentModel.
 */

import type { ModelMetadata } from '@/types';
import type { HarnessCatalog } from '@/types/harness';
import { resolveActiveClaudeModel } from '@/lib/harness/claude-models';
import {
  resolveActiveHarnessTarget,
  type ActiveHarnessTargetArgs,
} from '@/lib/harness/resolve-execution-target';

export type ComposerAttachmentModel = {
  modelKey: string;
  modelName: string;
  inputModalities: string[] | undefined;
};

export function resolveComposerAttachmentModel(args: ActiveHarnessTargetArgs & {
  openCodeProviderId?: string | null;
  openCodeModelId?: string | null;
  openCodeMetadata?: ModelMetadata | null;
  claudeCatalog?: HarnessCatalog | null;
}): ComposerAttachmentModel {
  const target = resolveActiveHarnessTarget(args);

  if (target?.harnessId === 'claude-code') {
    const { modelRef, metadata } = resolveActiveClaudeModel(target, args.claudeCatalog);
    return {
      modelKey: `claude-code/${modelRef}`,
      modelName: metadata.name ?? modelRef,
      inputModalities: metadata.modalities?.input,
    };
  }

  const providerId = typeof args.openCodeProviderId === 'string' ? args.openCodeProviderId : '';
  const modelId = typeof args.openCodeModelId === 'string' ? args.openCodeModelId : '';
  const metadata = args.openCodeMetadata ?? undefined;
  return {
    modelKey: `${providerId}/${modelId}`,
    modelName: metadata?.name ?? modelId,
    inputModalities: metadata?.modalities?.input,
  };
}
