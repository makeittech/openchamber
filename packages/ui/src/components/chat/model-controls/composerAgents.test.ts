import { describe, expect, test } from 'bun:test';
import {
    filterComposerAgents,
    resolveActiveComposerAgentName,
    resolveComposerAgents,
    resolveComposerDefaultAgentName,
    type ComposerAgentOption,
} from './composerAgents';
import type { Agent } from '@opencode-ai/sdk/v2';
import type { ClaudeAgent } from '@/lib/harness/client';

/** Builds a partial OpenCode agent fixture with only the fields the module reads. */
const ocAgent = (name: string, mode?: string, description?: string) => ({
    name,
    mode,
    description,
} as unknown as Agent);

/** Builds a partial Claude agent fixture with only the fields the module reads. */
const claudeAgent = (name: string, description: string) => ({
    name,
    description,
    model: 'sonnet',
    source: 'project',
} as unknown as ClaudeAgent);

describe('resolveComposerAgents', () => {
    test('Claude mode returns the Claude list in the given order, mapping empty description to undefined', () => {
        const claudeAgents = [claudeAgent('reviewer', 'reviews things'), claudeAgent('writer', '')];
        const result = resolveComposerAgents({
            claudeNativeAgentsActive: true,
            claudeAgents,
            openCodeAgents: [],
        });
        expect(result).toEqual([
            { name: 'reviewer', description: 'reviews things' },
            { name: 'writer', description: undefined },
        ]);
    });

    test('OpenCode mode includes primary, all, and undefined-mode agents but excludes subagents', () => {
        const openCodeAgents = [
            ocAgent('primary-agent', 'primary'),
            ocAgent('all-agent', 'all'),
            ocAgent('sub-agent', 'subagent'),
            ocAgent('undefined-mode-agent', undefined),
        ];
        const result = resolveComposerAgents({
            claudeNativeAgentsActive: false,
            claudeAgents: [],
            openCodeAgents,
        });
        expect(result.map((agent) => agent.name)).toEqual([
            'primary-agent',
            'all-agent',
            'undefined-mode-agent',
        ]);
    });

    test('OpenCode mode maps an empty-string description to undefined', () => {
        const result = resolveComposerAgents({
            claudeNativeAgentsActive: false,
            claudeAgents: [],
            openCodeAgents: [ocAgent('build', 'primary', '')],
        });
        expect(result).toEqual([{ name: 'build', description: undefined }]);
    });

    test('Claude mode with an empty Claude list returns [] even when OpenCode agents exist', () => {
        const result = resolveComposerAgents({
            claudeNativeAgentsActive: true,
            claudeAgents: [],
            openCodeAgents: [ocAgent('build', 'primary')],
        });
        expect(result).toEqual([]);
    });

    test('OpenCode mode with an empty OpenCode list returns [] even when Claude agents exist', () => {
        const result = resolveComposerAgents({
            claudeNativeAgentsActive: false,
            claudeAgents: [claudeAgent('reviewer', 'reviews things')],
            openCodeAgents: [],
        });
        expect(result).toEqual([]);
    });
});

describe('resolveComposerDefaultAgentName', () => {
    const agents: ComposerAgentOption[] = [
        { name: 'build', description: 'default build agent' },
        { name: 'plan', description: 'plan agent' },
    ];

    test('Claude mode always returns undefined, even when the Claude list is non-empty', () => {
        const result = resolveComposerDefaultAgentName({
            claudeNativeAgentsActive: true,
            agents,
            settingsDefaultAgent: 'plan',
        });
        expect(result).toBe(undefined);
    });

    test('OpenCode mode prefers settingsDefaultAgent when it is present in the list', () => {
        const result = resolveComposerDefaultAgentName({
            claudeNativeAgentsActive: false,
            agents,
            settingsDefaultAgent: 'plan',
        });
        expect(result).toBe('plan');
    });

    test('falls back to build when settingsDefaultAgent is absent', () => {
        const result = resolveComposerDefaultAgentName({
            claudeNativeAgentsActive: false,
            agents,
            settingsDefaultAgent: undefined,
        });
        expect(result).toBe('build');
    });

    test('falls back to build when settingsDefaultAgent is blank/whitespace', () => {
        const result = resolveComposerDefaultAgentName({
            claudeNativeAgentsActive: false,
            agents,
            settingsDefaultAgent: '   ',
        });
        expect(result).toBe('build');
    });

    test('falls back to build when settingsDefaultAgent names an agent not in the list', () => {
        const result = resolveComposerDefaultAgentName({
            claudeNativeAgentsActive: false,
            agents,
            settingsDefaultAgent: 'nonexistent',
        });
        expect(result).toBe('build');
    });

    test('falls back to the first entry when there is no build agent', () => {
        const result = resolveComposerDefaultAgentName({
            claudeNativeAgentsActive: false,
            agents: [{ name: 'plan', description: 'plan agent' }, { name: 'explore', description: 'explore agent' }],
            settingsDefaultAgent: undefined,
        });
        expect(result).toBe('plan');
    });

    test('returns undefined for an empty list', () => {
        const result = resolveComposerDefaultAgentName({
            claudeNativeAgentsActive: false,
            agents: [],
            settingsDefaultAgent: undefined,
        });
        expect(result).toBe(undefined);
    });
});

describe('resolveActiveComposerAgentName', () => {
    test('Claude mode returns the Claude selection', () => {
        const result = resolveActiveComposerAgentName({
            claudeNativeAgentsActive: true,
            claudeSelectedAgentName: 'reviewer',
            openCodeAgentName: 'build',
        });
        expect(result).toBe('reviewer');
    });

    test('Claude mode returns empty string when nothing is selected', () => {
        const result = resolveActiveComposerAgentName({
            claudeNativeAgentsActive: true,
            claudeSelectedAgentName: '',
            openCodeAgentName: 'build',
        });
        expect(result).toBe('');
    });

    test('Claude mode ignores the OpenCode agent name entirely', () => {
        const result = resolveActiveComposerAgentName({
            claudeNativeAgentsActive: true,
            claudeSelectedAgentName: 'reviewer',
            openCodeAgentName: 'some-other-opencode-agent',
        });
        expect(result).toBe('reviewer');
    });

    test('OpenCode mode returns the OpenCode name', () => {
        const result = resolveActiveComposerAgentName({
            claudeNativeAgentsActive: false,
            claudeSelectedAgentName: 'reviewer',
            openCodeAgentName: 'build',
        });
        expect(result).toBe('build');
    });

    test('OpenCode mode returns empty string for null', () => {
        const result = resolveActiveComposerAgentName({
            claudeNativeAgentsActive: false,
            claudeSelectedAgentName: 'reviewer',
            openCodeAgentName: null,
        });
        expect(result).toBe('');
    });

    test('OpenCode mode returns empty string for undefined', () => {
        const result = resolveActiveComposerAgentName({
            claudeNativeAgentsActive: false,
            claudeSelectedAgentName: 'reviewer',
            openCodeAgentName: undefined,
        });
        expect(result).toBe('');
    });
});

describe('filterComposerAgents', () => {
    const substringMatches = (value: string, query: string) => value.toLowerCase().includes(query.toLowerCase());

    test('a blank/whitespace query returns everything sorted by name', () => {
        const agents: ComposerAgentOption[] = [
            { name: 'zeta', description: 'last' },
            { name: 'alpha', description: 'first' },
            { name: 'mid', description: 'middle' },
        ];
        const result = filterComposerAgents(agents, '   ', substringMatches);
        expect(result.map((agent) => agent.name)).toEqual(['alpha', 'mid', 'zeta']);
    });

    test('does not mutate the input array', () => {
        const agents: ComposerAgentOption[] = [
            { name: 'zeta', description: 'last' },
            { name: 'alpha', description: 'first' },
        ];
        filterComposerAgents(agents, '', substringMatches);
        expect(agents.map((agent) => agent.name)).toEqual(['zeta', 'alpha']);
    });

    test('matches on name or description using the injected matcher', () => {
        const agents: ComposerAgentOption[] = [
            { name: 'reviewer', description: 'checks code' },
            { name: 'writer', description: 'drafts docs' },
            { name: 'planner', description: 'reviews plans' },
        ];
        const result = filterComposerAgents(agents, 'review', substringMatches);
        expect(result.map((agent) => agent.name)).toEqual(['planner', 'reviewer']);
    });

    test('an agent with description undefined does not throw and is excluded when only the description would match', () => {
        const agents: ComposerAgentOption[] = [
            { name: 'build', description: undefined },
            { name: 'reviewer', description: 'review helper' },
        ];
        const result = filterComposerAgents(agents, 'review', substringMatches);
        expect(result.map((agent) => agent.name)).toEqual(['reviewer']);
    });

    test('the injected matcher receives the trimmed query', () => {
        const received: string[] = [];
        const recordingMatcher = (value: string, query: string) => {
            received.push(query);
            return false;
        };
        filterComposerAgents([{ name: 'build', description: undefined }], '  hello  ', recordingMatcher);
        expect(received).toEqual(['hello']);
    });
});
