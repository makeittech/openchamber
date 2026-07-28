import { describe, expect, test } from 'bun:test';
import {
    buildHarnessOptions,
    buildPickerProviders,
    selectPickerModel,
} from './modelPickerData';
import type { HarnessCatalog, HarnessCatalogModel } from '@/types/harness';

/** Echoes the key so assertions read against stable identifiers. */
const t = ((key: string) => key) as never;

const catalog = (status: HarnessCatalog['status']) => ({
    engine: { id: 'claude-code' },
    status,
    sections: [],
} as unknown as HarnessCatalog);

describe('buildHarnessOptions', () => {
    test('omits Claude entirely when the engine is disabled', () => {
        const options = buildHarnessOptions({
            t,
            pickerHarnessId: 'opencode',
            harnessClaudeCodeEnabled: false,
            claudeCatalog: catalog('ready'),
        });
        expect(options.map((o) => o.id)).toEqual(['opencode']);
    });

    test('marks the active engine as selected', () => {
        const options = buildHarnessOptions({
            t,
            pickerHarnessId: 'claude-code',
            harnessClaudeCodeEnabled: true,
            claudeCatalog: catalog('ready'),
        });
        expect(options.find((o) => o.id === 'claude-code')?.selected).toBe(true);
        expect(options.find((o) => o.id === 'opencode')?.selected).toBe(false);
    });

    test('shows loading rather than a ready status before detection answers', () => {
        const options = buildHarnessOptions({
            t,
            pickerHarnessId: 'opencode',
            harnessClaudeCodeEnabled: true,
            claudeCatalog: null,
        });
        expect(options[1]?.statusLabel).toBe('settings.harness.sidebar.status.loading');
    });

    test('maps a failed detect status through to the label', () => {
        const options = buildHarnessOptions({
            t,
            pickerHarnessId: 'opencode',
            harnessClaudeCodeEnabled: true,
            claudeCatalog: catalog('missing-cli'),
        });
        expect(options[1]?.statusLabel).toBe('settings.harness.sidebar.status.missingCli');
    });
});

describe('buildPickerProviders', () => {
    const models = [{
        id: 'sonnet',
        name: 'Sonnet',
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ['text'], output: ['text'] },
        reasoning: true,
        toolCall: true,
    }] as unknown as HarnessCatalogModel[];

    test('passes OpenCode providers through untouched', () => {
        const providers = [{ id: 'anthropic', name: 'Anthropic', models: [] }];
        expect(buildPickerProviders({
            t,
            pickerHarnessId: 'opencode',
            claudePickerProviderId: 'claude-code',
            claudeCatalogModels: models,
            providers,
        })).toBe(providers as never);
    });

    test('projects the Claude catalog into one synthetic provider', () => {
        const result = buildPickerProviders({
            t,
            pickerHarnessId: 'claude-code',
            claudePickerProviderId: 'claude-code',
            claudeCatalogModels: models,
            providers: [{ id: 'anthropic', models: [] }],
        });
        expect(result).toHaveLength(1);
        const claudeProvider = result[0];
        expect(claudeProvider?.id).toBe('claude-code');
        // toolCall is renamed to the picker's snake_case contract.
        const projected = (claudeProvider?.models ?? [])[0] as Record<string, unknown>;
        expect(projected.id).toBe('sonnet');
        expect(projected.tool_call).toBe(true);
        expect(projected.reasoning).toBe(true);
    });
});

describe('selectPickerModel', () => {
    test('selects the Claude model ref when Claude is active', () => {
        expect(selectPickerModel({
            pickerHarnessId: 'claude-code',
            claudePickerProviderId: 'claude-code',
            claudeModelRef: 'opus',
            currentProviderId: 'anthropic',
            currentModelId: 'claude-3',
        })).toEqual({ providerID: 'claude-code', modelID: 'opus' });
    });

    test('returns null when OpenCode has no resolved model', () => {
        expect(selectPickerModel({
            pickerHarnessId: 'opencode',
            claudePickerProviderId: 'claude-code',
            claudeModelRef: 'sonnet',
            currentProviderId: '',
            currentModelId: '',
        })).toBeNull();
    });
});
