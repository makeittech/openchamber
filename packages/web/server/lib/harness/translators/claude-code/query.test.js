import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClaudeQuery } from './query.js';
import { buildRecoveryUserMessage, RECOVERY_MARKER } from './recovery-transcript.js';

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-query-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const captureQueryImpl = (capture) => ({ options, prompt }) => {
  capture.options = options;
  capture.prompt = prompt;
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: async () => {},
  };
};

async function runQuery(params = {}) {
  const capture = {};
  const handle = await startClaudeQuery({
    prompt: 'hi',
    cwd: tempDir,
    includePartialMessages: false,
    queryImpl: captureQueryImpl(capture),
    ...params,
  });
  handle.close();
  return capture;
}

describe('startClaudeQuery options', () => {
  it('forwards standard options and defaults', async () => {
    const { options } = await runQuery({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
    });

    expect(options).toMatchObject({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      cwd: tempDir,
      skills: 'all',
      forwardSubagentText: true,
      agentProgressSummaries: true,
      settingSources: ['user', 'project', 'local'],
    });
  });

  it('forwards MCP servers and allowed tools', async () => {
    const mcpServers = { fs: { type: 'stdio', command: 'node', args: ['server.js'] } };
    const allowedTools = ['Agent', 'mcp__fs__*'];
    const { options } = await runQuery({ mcpServers, allowedTools });
    expect(options).toMatchObject({ mcpServers, allowedTools });
  });

  it('forwards the Claude Code preset with an OpenCode agent append', async () => {
    const systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: 'Use OpenChamber build agent conventions.',
    };
    expect((await runQuery({ systemPrompt })).options.systemPrompt).toEqual(systemPrompt);
  });

  it('only forwards allowlisted permission modes', async () => {
    for (const permissionMode of ['default', 'acceptEdits', 'plan']) {
      expect((await runQuery({ permissionMode })).options.permissionMode).toBe(permissionMode);
    }
    for (const permissionMode of ['bypassPermissions', 'totallyMadeUp']) {
      expect((await runQuery({ permissionMode })).options).not.toHaveProperty('permissionMode');
    }
  });

  it('only forwards recognized effort levels', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect((await runQuery({ effort })).options.effort).toBe(effort);
    }
    for (const effort of [undefined, '  ', 'ultra']) {
      expect((await runQuery({ effort })).options).not.toHaveProperty('effort');
    }
  });
});

describe('startClaudeQuery internal hooks', () => {
  it('forwards a non-empty hooks object unchanged', async () => {
    const hooks = { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] };
    expect((await runQuery({ hooks })).options.hooks).toBe(hooks);
  });

  it('omits absent and empty hooks', async () => {
    expect((await runQuery()).options).not.toHaveProperty('hooks');
    expect((await runQuery({ hooks: {} })).options).not.toHaveProperty('hooks');
  });

  it('does not read hooks from a client-body-shaped nested field', async () => {
    const body = { hooks: { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] } };
    expect((await runQuery({ body })).options).not.toHaveProperty('hooks');
  });
});

describe('startClaudeQuery synthetic recovery prompt', () => {
  it('passes the async iterable through with its recovery metadata intact', async () => {
    const recovery = buildRecoveryUserMessage('launch-uuid-123');
    const prompt = (async function* recoveryPrompt() { yield recovery; })();
    const capture = await runQuery({ prompt });

    expect(capture.prompt).toBe(prompt);
    const collected = [];
    for await (const message of capture.prompt) collected.push(message);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: 'user',
      isSynthetic: true,
      priority: 'now',
      uuid: 'launch-uuid-123',
      parent_tool_use_id: null,
    });
    expect(collected[0].message.content[0].text.startsWith(RECOVERY_MARKER)).toBe(true);
  });
});
