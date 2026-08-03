/**
 * Claude Code model metadata + effort helpers for picker/tooltips.
 */

import type { ModelMetadata } from '@/types';
import type {
  ClaudeEffort,
  ClaudePermissionMode,
  HarnessCatalog,
  HarnessCatalogModel,
  ExecutionTarget,
} from '@/types/harness';
import { CLAUDE_EFFORT_LEVELS, isClaudeEffort } from '@/types/harness';
import type { EditPermissionMode } from '@/stores/types/sessionTypes';
import { CLAUDE_FAVORITE_PROVIDER_ID } from '@/lib/harness/favorite-targets';

export { CLAUDE_EFFORT_LEVELS, isClaudeEffort };
export type { ClaudeEffort };

/** Claude's default model when a target carries no usable ref. */
const DEFAULT_CLAUDE_MODEL_REF = 'sonnet';

/**
 * Map OpenCode agent edit permission → Claude Agent SDK permissionMode.
 *
 * Claude modes are coarser than per-tool OpenCode rules; edit is the closest
 * shared control surface (composer agent chip / agent settings). This is the
 * only producer of `ClaudePermissionMode` — see the type for why there is no
 * standalone control and no bypass mode.
 */
export function claudePermissionModeFromEditPermission(
  editPermission: EditPermissionMode | undefined,
): ClaudePermissionMode {
  if (editPermission === 'allow') return 'acceptEdits';
  if (editPermission === 'deny') return 'plan';
  return 'default';
}

/** Fallback limits when catalog entry omits them (unknown / older Claude refs). */
const DEFAULT_CLAUDE_LIMIT = {
  context: 200_000,
  output: 64_000,
} as const;

export function buildClaudeModelMetadata(
  model: Pick<HarnessCatalogModel, 'id' | 'name' | 'supportsImages' | 'supportsDocuments' | 'reasoning' | 'toolCall' | 'limit' | 'modalities'>,
): ModelMetadata {
  const supportsImages = model.supportsImages !== false;
  const inputModalities = model.modalities?.input?.length
    ? [...model.modalities.input]
    : supportsImages
      ? ['text', 'image']
      : ['text'];
  const outputModalities = model.modalities?.output?.length
    ? [...model.modalities.output]
    : ['text'];

  return {
    id: model.id,
    providerId: CLAUDE_FAVORITE_PROVIDER_ID,
    name: model.name || model.id,
    tool_call: model.toolCall !== false,
    reasoning: model.reasoning !== false,
    attachment: Boolean(model.supportsImages || model.supportsDocuments),
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
    // Subscription path — omit API unit costs (do not show OpenCode provider pricing).
    limit: {
      context: model.limit?.context ?? DEFAULT_CLAUDE_LIMIT.context,
      output: model.limit?.output ?? DEFAULT_CLAUDE_LIMIT.output,
    },
  };
}

export function buildClaudeModelMetadataMap(
  models: readonly HarnessCatalogModel[] | undefined,
): Map<string, ModelMetadata> {
  const map = new Map<string, ModelMetadata>();
  for (const model of models ?? []) {
    map.set(`${CLAUDE_FAVORITE_PROVIDER_ID}/${model.id}`, buildClaudeModelMetadata(model));
  }
  return map;
}

export function resolveClaudeCatalogModel(
  models: readonly HarnessCatalogModel[] | undefined,
  modelRef: string,
): HarnessCatalogModel {
  const match = models?.find((entry) => entry.id === modelRef);
  if (match) return match;
  return {
    id: modelRef,
    name: modelRef,
    supportsImages: true,
    supportsDocuments: true,
    reasoning: true,
    toolCall: true,
    limit: { ...DEFAULT_CLAUDE_LIMIT },
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
  };
}

/**
 * Model ref + metadata for a Claude execution target, flattening the catalog.
 * Shared by every composer surface that must describe the active Claude model.
 */
export function resolveActiveClaudeModel(
  target: Extract<ExecutionTarget, { harnessId: 'claude-code' }>,
  catalog: HarnessCatalog | null | undefined,
): { modelRef: string; metadata: ModelMetadata } {
  const modelRef = typeof target.modelRef === 'string' && target.modelRef.trim()
    ? target.modelRef.trim()
    : DEFAULT_CLAUDE_MODEL_REF;
  const models = catalog?.sections.flatMap((section) => section.models) ?? [];
  return { modelRef, metadata: buildClaudeModelMetadata(resolveClaudeCatalogModel(models, modelRef)) };
}
