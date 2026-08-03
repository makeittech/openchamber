import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClaudeQuery } from './query.js';
import { buildRecoveryUserMessage, RECOVERY_MARKER } from './recovery-transcript.js';

/**
 * `queryImpl` mock that captures the raw `{ prompt, options }` the wrapper
 * passed into the SDK `query()` without consuming the prompt async-iterable.
 *
 * @param {{ options?: object, prompt?: unknown }} capture
 */
const captureQueryImpl = (capture) => ({ options, prompt }) => {
  capture.options = options;
  capture.prompt = prompt;
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: async () => {},
  };
};

describe('startClaudeQuery effort option', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('forwards effort to the Claude Agent SDK query options', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-effort-'));
    /** @type {unknown} */
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });

    expect(seenOptions).toMatchObject({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      cwd: tempDir,
      skills: 'all',
      forwardSubagentText: true,
      agentProgressSummaries: true,
      settingSources: ['user', 'project', 'local'],
    });
    await handle.close?.();
  });

  it('forwards mcpServers and allowedTools', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-mcp-'));
    /** @type {unknown} */
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      includePartialMessages: false,
      mcpServers: {
        fs: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
      allowedTools: ['Agent', 'mcp__fs__*'],
      queryImpl: ({ options }) => {
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });
    expect(seenOptions).toMatchObject({
      mcpServers: {
        fs: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
      allowedTools: ['Agent', 'mcp__fs__*'],
    });
    await handle.close?.();
  });
  it('forwards Claude Code preset systemPrompt with OpenCode agent append', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-sysprompt-'));
    /** @type {unknown} */
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Use OpenChamber build agent conventions.',
      },
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });

    expect(seenOptions).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Use OpenChamber build agent conventions.',
      },
    });
    await handle.close?.();
  });
});

describe('startClaudeQuery permissionMode allowlist', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  const runWith = async (permissionMode) => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-perm-'));
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      permissionMode,
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {} };
      },
    });
    await handle.close?.();
    return seenOptions;
  };

  for (const mode of ['default', 'acceptEdits', 'plan']) {
    it(`forwards the inherited mode "${mode}"`, async () => {
      expect((await runWith(mode)).permissionMode).toBe(mode);
    });
  }

  it('drops bypassPermissions so canUseTool cannot be defeated', async () => {
    expect(await runWith('bypassPermissions')).not.toHaveProperty('permissionMode');
  });

  it('drops unknown modes', async () => {
    expect(await runWith('totallyMadeUp')).not.toHaveProperty('permissionMode');
  });
});

describe('startClaudeQuery effort forwarding', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  const runWith = async (effort) => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-effort-'));
    let seenOptions;
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      effort,
      includePartialMessages: false,
      queryImpl: ({ options }) => {
        seenOptions = options;
        return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {} };
      },
    });
    await handle.close?.();
    return seenOptions;
  };

  // The SDK turns this into the CLI's `--effort <level>` flag, so the composer
  // control only has an effect if the level actually lands in options.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    it(`forwards the selected level "${level}"`, async () => {
      expect((await runWith(level)).effort).toBe(level);
    });
  }

  it('omits effort for the SDK default', async () => {
    expect(await runWith(undefined)).not.toHaveProperty('effort');
    expect(await runWith('  ')).not.toHaveProperty('effort');
  });

  it('drops an unknown level instead of failing the turn on an invalid flag', async () => {
    expect(await runWith('ultra')).not.toHaveProperty('effort');
  });
});

describe('startClaudeQuery internal hooks forwarding', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('forwards a non-empty hooks object to options.hooks unchanged', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-hooks-'));
    /** @type {{ options?: object, prompt?: unknown }} */
    const seen = {};
    // SDK hook shape: Partial<Record<HookEvent, HookCallbackMatcher[]>>.
    const hooks = {
      PreToolUse: [{ hooks: [async () => ({ continue: true })] }],
    };
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      hooks,
      includePartialMessages: false,
      queryImpl: captureQueryImpl(seen),
    });
    // Forwarded by reference, unchanged.
    expect(seen.options?.hooks).toBe(hooks);
    await handle.close?.();
  });

  it('omits options.hooks when hooks is absent', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-hooks-absent-'));
    const seen = {};
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      includePartialMessages: false,
      queryImpl: captureQueryImpl(seen),
    });
    expect(seen.options).not.toHaveProperty('hooks');
    await handle.close?.();
  });

  it('omits options.hooks when hooks is an empty object (no accidental empty object)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-hooks-empty-'));
    const seen = {};
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      hooks: {},
      includePartialMessages: false,
      queryImpl: captureQueryImpl(seen),
    });
    expect(seen.options).not.toHaveProperty('hooks');
    await handle.close?.();
  });

  it('does not read hooks from a client-body-shaped nested field', async () => {
    // The public prompt route supplies a client `body`; the wrapper must only
    // read the internal top-level `params.hooks`, never a nested client field.
    // This guards against a future regression opening a client-injection path.
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-hooks-body-'));
    const seen = {};
    const handle = await startClaudeQuery({
      prompt: 'hi',
      cwd: tempDir,
      body: { hooks: { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] } },
      includePartialMessages: false,
      queryImpl: captureQueryImpl(seen),
    });
    expect(seen.options).not.toHaveProperty('hooks');
    await handle.close?.();
  });
});

describe('startClaudeQuery synthetic recovery prompt passthrough', () => {
  /** @type {string | undefined} */
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('passes a synthetic SDKUserMessage async-iterable as prompt preserving uuid, isSynthetic, priority, and marker content', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-claude-recovery-prompt-'));
    /** @type {{ options?: object, prompt?: unknown }} */
    const seen = {};
    // Reuse the canonical recovery builder — do not reimplement it here.
    const recovery = buildRecoveryUserMessage('launch-uuid-123');
    const promptInput = (async function* streamRecovery() {
      yield recovery;
    })();
    const handle = await startClaudeQuery({
      prompt: promptInput,
      cwd: tempDir,
      includePartialMessages: false,
      queryImpl: ({ options, prompt }) => {
        seen.options = options;
        seen.prompt = prompt;
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt: async () => {},
        };
      },
    });
    // The same async-iterable reference is forwarded unchanged to the SDK query.
    expect(seen.prompt).toBe(promptInput);
    /** @type {object[]} */
    const collected = [];
    for await (const message of /** @type {AsyncIterable<object>} */ (seen.prompt)) {
      collected.push(message);
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: 'user',
      isSynthetic: true,
      priority: 'now',
      uuid: 'launch-uuid-123',
      parent_tool_use_id: null,
    });
    const text = collected[0]?.message?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    expect(/** @type {string} */ (text).startsWith(RECOVERY_MARKER)).toBe(true);
    await handle.close?.();
  });
});
