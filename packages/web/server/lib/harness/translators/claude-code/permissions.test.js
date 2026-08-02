import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildAlwaysPatterns,
  createCanUseTool,
  createSubagentPermissionRuntime,
  getPendingPermissionCount,
  rejectPendingForSession,
  replyPermission,
  resetPendingPermissions,
  extractPermissionPatterns,
  isOpenChamberInjectedTool,
} from './permissions.js';
import { resetPendingQuestions, replyQuestion } from './questions.js';

afterEach(() => {
  resetPendingPermissions();
  resetPendingQuestions();
});

describe('isOpenChamberInjectedTool', () => {
  it('recognizes the Claude SDK MCP openchamber tool name', () => {
    expect(isOpenChamberInjectedTool('mcp__openchamber__openchamber')).toBe(true);
    expect(isOpenChamberInjectedTool('openchamber')).toBe(true);
    expect(isOpenChamberInjectedTool('Bash')).toBe(false);
  });
});

describe('extractPermissionPatterns', () => {
  it('pulls command and path-like fields', () => {
    expect(extractPermissionPatterns(
      { command: 'ls -la', path: '/tmp/a' },
      { blockedPath: '/tmp/b' },
    )).toEqual(['ls -la', '/tmp/a', '/tmp/b']);
  });
});

describe('buildAlwaysPatterns', () => {
  it('uses concrete patterns when present', () => {
    expect(buildAlwaysPatterns(['echo hi'], 'Bash')).toEqual(['echo hi']);
  });

  it('falls back to tool name so Always Allow stays available', () => {
    expect(buildAlwaysPatterns([], 'Edit')).toEqual(['Edit']);
  });
});

describe('createCanUseTool / replyPermission', () => {
  it('auto-allows the injected OpenChamber MCP tool without prompting', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_1',
      directory: '/repo',
      getBroadcast: () => (event) => events.push(event),
    });
    const result = await canUseTool('mcp__openchamber__openchamber', {
      action: 'projects.list',
      parameters: {},
    });
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { action: 'projects.list', parameters: {} },
    });
    expect(events).toEqual([]);
  });

  it('honors an inherited OpenCode agent policy without prompting', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_1',
      directory: '/repo',
      getBroadcast: () => (event) => events.push(event),
      policySourceLabel: 'build',
      resolveToolPolicy: (toolName) => {
        if (toolName === 'Bash') return 'allow';
        if (toolName === 'WebFetch') return 'deny';
        return 'ask';
      },
    });

    await expect(canUseTool('Bash', { command: 'git status' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git status' },
    });
    await expect(canUseTool('WebFetch', { url: 'https://example.com' })).resolves.toEqual({
      behavior: 'deny',
      message: 'Denied by OpenCode agent "build" permission rules',
    });

    // Neither decision involved the user, so nothing was broadcast and no
    // request is left pending.
    expect(events).toEqual([]);
    expect(getPendingPermissionCount()).toBe(0);

    // `ask` still reaches the PermissionCard bridge.
    const pending = canUseTool('Edit', { file_path: '/repo/a.ts' });
    expect(getPendingPermissionCount()).toBe(1);
    expect(events[0]?.type).toBe('permission.asked');
    const requestId = events[0].properties.id;
    replyPermission({ sessionId: 'ses_1', requestId, reply: 'reject' });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('falls back to asking when the inherited policy throws', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_1',
      directory: '/repo',
      getBroadcast: () => (event) => events.push(event),
      resolveToolPolicy: () => { throw new Error('broken policy'); },
    });

    const pending = canUseTool('Bash', { command: 'git status' });
    expect(getPendingPermissionCount()).toBe(1);
    const requestId = events[0].properties.id;
    replyPermission({ sessionId: 'ses_1', requestId, reply: 'reject' });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('never lets an inherited policy override the AskUserQuestion bridge', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_1',
      directory: '/repo',
      getBroadcast: () => (event) => events.push(event),
      resolveToolPolicy: () => 'allow',
    });

    const pending = canUseTool('AskUserQuestion', {
      questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
    });
    expect(events[0]?.type).toBe('question.asked');
    replyQuestion({ sessionId: 'ses_1', requestId: events[0].properties.id, reject: true });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('allows once and emits asked + replied events with always patterns + tool linkage', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_1',
      directory: '/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_fixed',
      timeoutMs: 5_000,
      assistantMessageId: 'msg_assistant',
    });

    const pending = canUseTool('Bash', { command: 'echo hi' }, {
      toolUseID: 'tool_1',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    });

    expect(getPendingPermissionCount()).toBe(1);
    expect(events[0]?.type).toBe('permission.asked');
    expect(events[0]?.properties).toMatchObject({
      id: 'perm_fixed',
      sessionID: 'ses_1',
      permission: 'Bash',
      patterns: ['echo hi'],
      always: ['echo hi'],
      tool: {
        messageID: 'msg_assistant',
        callID: 'tool_1',
      },
    });

    const reply = replyPermission({
      sessionId: 'ses_1',
      requestId: 'perm_fixed',
      reply: 'once',
    });
    expect(reply.ok).toBe(true);

    const result = await pending;
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'echo hi' },
    });
    expect(events.some((event) => event.type === 'permission.replied')).toBe(true);
    expect(getPendingPermissionCount()).toBe(0);
  });

  it('maps always to allow with updatedPermissions when suggestions exist', async () => {
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_2',
      directory: '/project',
      getBroadcast: () => () => {},
      createId: () => 'perm_always',
    });

    const pending = canUseTool('Edit', { file_path: '/a.ts' }, { suggestions });
    replyPermission({ sessionId: 'ses_2', requestId: 'perm_always', reply: 'always' });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/a.ts' },
      updatedPermissions: suggestions,
    });
  });

  it('routes AskUserQuestion to the question bridge instead of a permission prompt', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_q',
      directory: '/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'qst_canuse',
      assistantMessageId: 'msg_assistant',
    });

    const input = {
      questions: [{
        question: 'Pick one',
        header: 'Choice',
        options: [{ label: 'A', description: 'Option A' }],
        multiSelect: false,
      }],
    };
    const pending = canUseTool('AskUserQuestion', input, { toolUseID: 'toolu_q' });

    expect(events[0]?.type).toBe('question.asked');
    expect(events[0]?.properties).toMatchObject({
      id: 'qst_canuse',
      sessionID: 'ses_q',
      tool: { messageID: 'msg_assistant', callID: 'toolu_q' },
    });

    replyQuestion({
      sessionId: 'ses_q',
      requestId: 'qst_canuse',
      answers: [['A']],
    });

    const result = await pending;
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Pick one': 'A' } },
    });
  });

  it('maps reject to deny', async () => {
    const canUseTool = createCanUseTool({
      sessionId: 'ses_3',
      directory: '/project',
      getBroadcast: () => () => {},
      createId: () => 'perm_deny',
    });

    const pending = canUseTool('Bash', { command: 'rm -rf /' }, {});
    replyPermission({ sessionId: 'ses_3', requestId: 'perm_deny', reply: 'reject' });
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'Permission denied by user',
    });
  });

  it('fail-closed timeouts deny the tool', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_4',
      directory: '/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_timeout',
      timeoutMs: 20,
    });

    const result = await canUseTool('Bash', { command: 'sleep 1' }, {});
    expect(result).toEqual({
      behavior: 'deny',
      message: 'Permission denied by user',
    });
    expect(events.some((event) => (
      event.type === 'permission.replied'
      && event.properties?.requestID === 'perm_timeout'
    ))).toBe(true);
    expect(getPendingPermissionCount()).toBe(0);
  });

  it('rejects reply for unknown or mismatched session', () => {
    const canUseTool = createCanUseTool({
      sessionId: 'ses_5',
      directory: '/project',
      getBroadcast: () => () => {},
      createId: () => 'perm_mismatch',
    });
    void canUseTool('Bash', { command: 'pwd' }, {});

    expect(() => replyPermission({
      sessionId: 'ses_other',
      requestId: 'perm_mismatch',
      reply: 'once',
    })).toThrow(/does not belong/);

    expect(() => replyPermission({
      sessionId: 'ses_5',
      requestId: 'missing',
      reply: 'once',
    })).toThrow(/not found/);
  });
});

describe('createSubagentPermissionRuntime', () => {
  it('binds subagent starts to their Agent/Task tool_use ids', () => {
    const runtime = createSubagentPermissionRuntime();
    runtime.noteAgentToolCall('toolu_a', 'reviewer');
    runtime.noteAgentToolCall('toolu_b', 'reviewer');
    runtime.onSubagentStart({ agent_id: 'agent_1', agent_type: 'reviewer' });
    runtime.onSubagentStart({ agent_id: 'agent_2', agent_type: 'reviewer' });

    expect(runtime.resolveToolUseId('agent_1')).toBe('toolu_a');
    expect(runtime.resolveToolUseId('agent_2')).toBe('toolu_b');
    expect(runtime.agentType('agent_1')).toBe('reviewer');
    expect(runtime.agentType('unknown')).toBe('');
  });

  it('binds a SubagentStart that raced the parent tool call', () => {
    const runtime = createSubagentPermissionRuntime();
    runtime.onSubagentStart({ agent_id: 'agent_1', agent_type: 'writer' });
    expect(runtime.resolveToolUseId('agent_1')).toBeNull();
    expect(runtime.agentType('agent_1')).toBe('writer');

    // The parent Agent tool check arrives later; the earlier start binds to it.
    runtime.noteAgentToolCall('toolu_w', 'writer');
    expect(runtime.resolveToolUseId('agent_1')).toBe('toolu_w');

    // A second start of the same type must not steal the consumed call.
    runtime.onSubagentStart({ agent_id: 'agent_2', agent_type: 'writer' });
    expect(runtime.resolveToolUseId('agent_2')).toBeNull();
  });

  it('ignores calls without a tool_use id and starts without an agent id', () => {
    const runtime = createSubagentPermissionRuntime();
    runtime.noteAgentToolCall('', 'reviewer');
    runtime.onSubagentStart({ agent_id: '', agent_type: 'reviewer' });
    runtime.onSubagentStart({});
    expect(runtime.resolveToolUseId('agent_1')).toBeNull();
  });
});

describe('createCanUseTool subagent policy routing', () => {
  it('applies the spawned subagent policy and stamps asks on the synthetic child session id', async () => {
    const events = [];
    const runtime = createSubagentPermissionRuntime();
    const canUseTool = createCanUseTool({
      sessionId: 'ses_parent',
      directory: '/repo',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_sub_1',
      resolveToolPolicy: () => 'ask',
      policySourceLabel: 'build',
      subagentRuntime: runtime,
      subagentPolicies: {
        reviewer: (toolName) => {
          if (toolName === 'Bash') return 'allow';
          if (toolName === 'WebFetch') return 'deny';
          return 'ask';
        },
      },
    });

    runtime.noteAgentToolCall('toolu_agent', 'reviewer');
    runtime.onSubagentStart({ agent_id: 'agent_1', agent_type: 'reviewer' });

    // Bash is allowed by the subagent's own ruleset, not the parent's ask.
    await expect(canUseTool('Bash', { command: 'git status' }, { agentID: 'agent_1' }))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'git status' } });

    // WebFetch is denied by the subagent's ruleset, labeled with its name.
    await expect(canUseTool('WebFetch', { url: 'https://example.com' }, { agentID: 'agent_1' }))
      .resolves.toEqual({
        behavior: 'deny',
        message: 'Denied by OpenCode agent "reviewer" permission rules',
      });

    // An ask inside the subagent is stamped on the child session id with the
    // real parent in metadata, and replies resolve through that child id.
    const pending = canUseTool('Edit', { file_path: '/repo/a.ts' }, {
      agentID: 'agent_1',
      toolUseID: 'toolu_edit',
    });
    expect(getPendingPermissionCount()).toBe(1);
    const asked = events.find((event) => event.type === 'permission.asked').properties;
    expect(asked.sessionID).toMatch(/^ses_claude_sub_/);
    expect(asked.sessionID).not.toBe('ses_parent');
    expect(asked.metadata.fromSubagent).toBe(true);
    expect(asked.metadata.parentSessionID).toBe('ses_parent');
    expect(asked.tool).toEqual({ messageID: '', callID: 'toolu_edit' });

    const reply = replyPermission({ sessionId: asked.sessionID, requestId: asked.id, reply: 'once' });
    expect(reply.ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
    expect(getPendingPermissionCount()).toBe(0);
  });

  it('falls back to the parent policy for uncorrelated agent ids', async () => {
    const events = [];
    const runtime = createSubagentPermissionRuntime();
    const canUseTool = createCanUseTool({
      sessionId: 'ses_parent',
      directory: '/repo',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_sub_2',
      resolveToolPolicy: (toolName) => (toolName === 'Bash' ? 'allow' : 'ask'),
      policySourceLabel: 'build',
      subagentRuntime: runtime,
      subagentPolicies: { reviewer: () => 'deny' },
    });

    // Unknown agent id: no subagent policy matched, parent policy decides.
    await expect(canUseTool('Bash', { command: 'pwd' }, { agentID: 'unknown_agent' }))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } });

    // The ask is still stamped as a subagent ask (the SDK said it is one).
    const pending = canUseTool('Edit', { file_path: '/repo/a.ts' }, { agentID: 'unknown_agent' });
    const asked = events.find((event) => event.type === 'permission.asked').properties;
    expect(asked.sessionID).toMatch(/^ses_claude_sub_/);
    expect(asked.metadata.fromSubagent).toBe(true);
    expect(asked.metadata.parentSessionID).toBe('ses_parent');
    replyPermission({ sessionId: asked.sessionID, requestId: asked.id, reply: 'reject' });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('rejects asks stamped on subagent child ids when the parent session is cleaned up', async () => {
    const events = [];
    const runtime = createSubagentPermissionRuntime();
    const canUseTool = createCanUseTool({
      sessionId: 'ses_parent',
      directory: '/repo',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_sub_3',
      subagentRuntime: runtime,
    });

    runtime.onSubagentStart({ agent_id: 'agent_1', agent_type: 'worker' });
    const pending = canUseTool('Bash', { command: 'ls' }, { agentID: 'agent_1' });
    expect(getPendingPermissionCount()).toBe(1);
    expect(events[0].properties.sessionID).not.toBe('ses_parent');

    // Abort/turn-end cleanup of the parent settles its subagent's asks too.
    expect(rejectPendingForSession('ses_parent')).toBe(1);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(getPendingPermissionCount()).toBe(0);
  });

  it('does not let unrelated session cleanup settle a subagent ask', async () => {
    const events = [];
    const runtime = createSubagentPermissionRuntime();
    const canUseTool = createCanUseTool({
      sessionId: 'ses_other',
      directory: '/repo',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_sub_4',
      subagentRuntime: runtime,
    });

    runtime.onSubagentStart({ agent_id: 'agent_2', agent_type: 'worker' });
    const pending = canUseTool('Bash', { command: 'ls' }, { agentID: 'agent_2' });
    expect(rejectPendingForSession('ses_unrelated')).toBe(0);
    expect(getPendingPermissionCount()).toBe(1);

    replyPermission({
      sessionId: events[0].properties.sessionID,
      requestId: events[0].properties.id,
      reply: 'reject',
    });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(getPendingPermissionCount()).toBe(0);
  });
});
