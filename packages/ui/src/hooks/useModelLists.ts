import React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useHarnessStore } from '@/stores/useHarnessStore';
import {
  CLAUDE_FAVORITE_PROVIDER_ID,
  executionTargetIdentityKey,
  favoriteRefFromExecutionTarget,
  legacyRefsToFavoriteTargets,
} from '@/lib/harness/favorite-targets';
import { buildClaudeModelMetadata } from '@/lib/harness/claude-models';
import type { HarnessCatalogModel, ExecutionTarget } from '@/types/harness';
import type { Provider } from '@opencode-ai/sdk/v2';

type ProviderModel = Provider['models'][string];
type ProviderWithModelList = Omit<Provider, 'models'> & { models: ProviderModel[] };

export interface ModelListItem {
  provider: ProviderWithModelList;
  model: ProviderModel;
  providerID: string;
  modelID: string;
  target: ExecutionTarget;
}

const buildClaudeProvider = (name: string, models: ProviderModel[]): ProviderWithModelList => ({
  id: CLAUDE_FAVORITE_PROVIDER_ID,
  name,
  source: 'custom',
  options: {},
  env: [],
  models,
});

const asProviderModel = (catalogModel: HarnessCatalogModel): ProviderModel => {
  const metadata = buildClaudeModelMetadata(catalogModel);
  const input = metadata.modalities?.input ?? ['text'];
  const output = metadata.modalities?.output ?? ['text'];
  return {
    id: catalogModel.id,
    name: catalogModel.name,
    providerID: CLAUDE_FAVORITE_PROVIDER_ID,
    api: { npm: '', id: catalogModel.id },
    capabilities: {
      temperature: false,
      reasoning: Boolean(metadata.reasoning),
      attachment: Boolean(metadata.attachment),
      toolcall: Boolean(metadata.tool_call),
      input: {
        text: input.includes('text'),
        audio: input.includes('audio'),
        image: input.includes('image'),
        video: input.includes('video'),
        pdf: input.includes('pdf'),
      },
      output: {
        text: output.includes('text'),
        audio: output.includes('audio'),
        image: output.includes('image'),
        video: output.includes('video'),
        pdf: output.includes('pdf'),
      },
      interleaved: false,
    },
    // Subscription engine — leave costs unset rather than fake OpenCode API pricing.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: metadata.limit?.context ?? 0,
      output: metadata.limit?.output ?? 0,
    },
    status: 'active',
  } as ProviderModel;
};

export const useModelLists = () => {
  const providers = useConfigStore((state) => state.providers);
  const favoriteTargets = useUIStore((state) => state.favoriteTargets);
  const recentTargets = useUIStore((state) => state.recentTargets);
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const recentModels = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const claudeCatalog = useHarnessStore((state) => state.catalogsById['claude-code']);

  const isHidden = React.useCallback((providerID: string, modelID: string) => {
    return hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID);
  }, [hiddenModels]);

  const resolveTargetList = React.useCallback((
    targets: ExecutionTarget[] | undefined,
    legacy: Array<{ providerID: string; modelID: string }>,
  ): ModelListItem[] => {
    const source = targets && targets.length > 0
      ? targets
      : legacyRefsToFavoriteTargets(legacy);

    const items: ModelListItem[] = [];
    for (const target of source) {
      if (target.harnessId === 'claude-code') {
        const model = claudeCatalog?.sections
          .flatMap((section) => section.models)
          .find((entry) => entry.id === target.modelRef);
        if (!model) continue;
        const ref = favoriteRefFromExecutionTarget(target);
        if (isHidden(ref.providerID, ref.modelID)) continue;
        const providerModel = asProviderModel(model);
        const provider = buildClaudeProvider(
          claudeCatalog?.descriptor.displayName || 'Claude Code',
          [providerModel],
        );
        items.push({
          provider,
          model: providerModel,
          providerID: ref.providerID,
          modelID: ref.modelID,
          target,
        });
        continue;
      }

      const provider = providers.find((p) => p.id === target.providerId);
      if (!provider) continue;
      const providerModels = Array.isArray(provider.models) ? provider.models : [];
      const model = providerModels.find((m: ProviderModel) => m.id === target.modelId);
      if (!model) continue;
      if (isHidden(target.providerId, target.modelId)) continue;
      items.push({
        provider,
        model,
        providerID: target.providerId,
        modelID: target.modelId,
        target,
      });
    }
    return items;
  }, [claudeCatalog, isHidden, providers]);

  const favoriteModelsList = React.useMemo(
    () => resolveTargetList(favoriteTargets, favoriteModels),
    [favoriteModels, favoriteTargets, resolveTargetList],
  );

  const favoriteKeys = React.useMemo(
    () => new Set(favoriteModelsList.map((item) => executionTargetIdentityKey(item.target))),
    [favoriteModelsList],
  );

  const recentModelsList = React.useMemo(
    () => resolveTargetList(recentTargets, recentModels)
      .filter((item) => !favoriteKeys.has(executionTargetIdentityKey(item.target))),
    [favoriteKeys, recentModels, recentTargets, resolveTargetList],
  );

  return { favoriteModelsList, recentModelsList };
};
