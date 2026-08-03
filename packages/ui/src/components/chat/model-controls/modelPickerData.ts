/**
 * Pure derivations for the composer model picker.
 *
 * Kept free of React so they can be tested directly; `useModelPickerData`
 * only memoizes calls into these.
 */

import type {
    ModelPickerHarnessOption,
    ModelPickerLabels,
    ModelPickerProvider,
} from '@/components/model-picker/ModelPickerList';
import type { HarnessCatalog, HarnessCatalogModel, HarnessId } from '@/types/harness';
import type { I18nContextValue } from '@/lib/i18n/react-context';

type Translate = I18nContextValue['t'];

export function buildModelPickerLabels(t: Translate): ModelPickerLabels {
    return {
        searchPlaceholder: t('chat.modelControls.searchModels'),
        noResults: t('chat.modelControls.noModelsFound'),
        favorites: t('chat.modelControls.favorites'),
        recent: t('chat.modelControls.recent'),
        keyboardHint: t('chat.modelControls.keyboardHintNavigate'),
        favorite: t('chat.modelControls.favoriteAria'),
        unfavorite: t('chat.modelControls.unfavoriteAria'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        context: t('chat.modelControls.context'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
        costInOutShort: t('chat.modelControls.costInOutShort'),
        modalityText: t('chat.modelControls.modality.text'),
        modalityImage: t('chat.modelControls.modality.image'),
        modalityVideo: t('chat.modelControls.modality.video'),
        modalityAudio: t('chat.modelControls.modality.audio'),
        modalityPdf: t('chat.modelControls.modality.pdf'),
        harnesses: t('chat.harness.section'),
    };
}

/**
 * Claude only appears when the harness is enabled in settings and detection
 * has either resolved to "ready" or is still loading. Any unusable state —
 * missing CLI, needs login, unsupported host, or error — drops the Claude
 * tab entirely so the harness switcher (rendered only above 2 tabs via
 * `HarnessTabs`) hides itself rather than advertising a broken engine.
 */
export function buildHarnessOptions(args: {
    t: Translate;
    pickerHarnessId: HarnessId;
    harnessClaudeCodeEnabled: boolean;
    claudeCatalog: HarnessCatalog | null | undefined;
}): ModelPickerHarnessOption[] {
    const { t, pickerHarnessId, harnessClaudeCodeEnabled, claudeCatalog } = args;
    const options: ModelPickerHarnessOption[] = [{
        id: 'opencode',
        name: t('chat.harness.opencode'),
        selected: pickerHarnessId === 'opencode',
    }];
    if (harnessClaudeCodeEnabled && (claudeCatalog == null || claudeCatalog.status === 'ready')) {
        options.push({
            id: 'claude-code',
            name: t('chat.harness.claudeCode'),
            statusLabel: claudeCatalog == null
                ? t('settings.harness.sidebar.status.loading')
                : undefined,
            selected: pickerHarnessId === 'claude-code',
        });
    }
    return options;
}

export function buildPickerProviders(args: {
    t: Translate;
    pickerHarnessId: HarnessId;
    claudePickerProviderId: string;
    claudeCatalogModels: readonly HarnessCatalogModel[];
    providers: unknown[];
}): ModelPickerProvider[] {
    const { t, pickerHarnessId, claudePickerProviderId, claudeCatalogModels, providers } = args;
    if (pickerHarnessId !== 'claude-code') {
        return providers as ModelPickerProvider[];
    }
    return [{
        id: claudePickerProviderId,
        name: t('chat.harness.claudeCode'),
        models: claudeCatalogModels.map((model) => ({
            id: model.id,
            name: model.name,
            limit: model.limit,
            modalities: model.modalities,
            reasoning: model.reasoning,
            tool_call: model.toolCall,
        })),
    }];
}

export function selectPickerModel(args: {
    pickerHarnessId: HarnessId;
    claudePickerProviderId: string;
    claudeModelRef: string;
    currentProviderId: string | null | undefined;
    currentModelId: string | null | undefined;
}): { providerID: string; modelID: string } | null {
    const { pickerHarnessId, claudePickerProviderId, claudeModelRef, currentProviderId, currentModelId } = args;
    if (pickerHarnessId === 'claude-code') {
        return { providerID: claudePickerProviderId, modelID: claudeModelRef };
    }
    return currentProviderId && currentModelId
        ? { providerID: currentProviderId, modelID: currentModelId }
        : null;
}
