import { describe, expect, test } from 'bun:test';

import { resolveClaudeAgentsSendOptions } from './claude-agents-mode';

describe('resolveClaudeAgentsSendOptions', () => {
  test('opencode mode sets permissionMode and optional system prompt append', () => {
    const resolved = resolveClaudeAgentsSendOptions({
      target: { harnessId: 'claude-code', modelRef: 'sonnet', effort: 'high', permissionMode: 'plan' },
      agentsMode: 'opencode',
      agentName: undefined,
    });

    expect(resolved.agentsMode).toBe('opencode');
    expect(resolved.target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'sonnet',
      effort: 'high',
      // No agent → edit permission defaults to ask → Claude default
      permissionMode: 'default',
    });
    expect(resolved.systemPromptAppend).toBe(undefined);
  });

  test('claude mode strips inherited permissionMode and omits system prompt append', () => {
    const resolved = resolveClaudeAgentsSendOptions({
      target: {
        harnessId: 'claude-code',
        modelRef: 'opus',
        permissionMode: 'acceptEdits',
        effort: 'max',
      },
      agentsMode: 'claude',
      agentName: 'build',
    });

    expect(resolved).toEqual({
      agentsMode: 'claude',
      target: {
        harnessId: 'claude-code',
        modelRef: 'opus',
        effort: 'max',
      },
    });
  });

  test('opencode mode forwards the agent name for server-side resolution', () => {
    const resolved = resolveClaudeAgentsSendOptions({
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'opencode',
      agentName: '  build  ',
      // A Claude agent selection belongs to the other mode and must not leak.
      claudeAgentName: 'code-reviewer',
    });

    expect(resolved.agent).toBe('build');
    expect(resolved.claudeAgent).toBe(undefined);
  });

  test('claude mode forwards the native Claude agent and no OpenCode agent', () => {
    const resolved = resolveClaudeAgentsSendOptions({
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: '  code-reviewer  ',
    });

    expect(resolved.claudeAgent).toBe('code-reviewer');
    expect(resolved.agent).toBe(undefined);
  });

  test('blank agent names are omitted rather than sent as empty strings', () => {
    expect(resolveClaudeAgentsSendOptions({
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'opencode',
      agentName: '   ',
    }).agent).toBe(undefined);

    expect(resolveClaudeAgentsSendOptions({
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'claude',
      claudeAgentName: '   ',
    }).claudeAgent).toBe(undefined);
  });
});
