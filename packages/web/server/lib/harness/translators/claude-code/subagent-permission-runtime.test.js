import { describe, expect, it } from 'bun:test';
import { createSubagentPermissionRuntime } from './subagent-permission-runtime.js';

describe('createSubagentPermissionRuntime', () => {
  it('correlates Agent tool_use + SubagentStart to a child session and policy', () => {
    const policy = () => 'deny';
    const runtime = createSubagentPermissionRuntime({
      parentSessionId: 'ses_parent_abcdefghijkl',
      childSessionIdFor: (toolUseId) => `ses_claude_sub_child_${toolUseId}`,
      policiesByAgentType: { 'doc-writer': policy },
    });

    runtime.noteAgentTool('toolu_agent', 'doc-writer');
    runtime.bindAgentId('agent_abc', 'doc-writer');

    const resolved = runtime.resolve('agent_abc');
    expect(resolved).toMatchObject({
      agentType: 'doc-writer',
      toolUseId: 'toolu_agent',
      childSessionId: 'ses_claude_sub_child_toolu_agent',
    });
    expect(resolved.resolveToolPolicy).toBe(policy);
  });

  it('falls back to the newest unbound Agent tool when types do not match', () => {
    const runtime = createSubagentPermissionRuntime({
      parentSessionId: 'ses_parent',
      childSessionIdFor: (id) => `child_${id}`,
      policiesByAgentType: {},
    });
    runtime.noteAgentTool('first', 'explore');
    runtime.noteAgentTool('second', 'doc-writer');
    runtime.bindAgentId('agent_1', 'unknown-type');
    expect(runtime.resolve('agent_1')?.toolUseId).toBe('second');
  });
});
