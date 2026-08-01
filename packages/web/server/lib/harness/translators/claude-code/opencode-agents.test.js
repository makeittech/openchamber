import { describe, expect, it } from 'bun:test';
import {
  buildClaudeAgentDefinitions,
  buildOpenCodeAgentInheritance,
  claudePermissionModeFromEditAction,
  createOpenCodeAgentResolver,
  createOpenCodeToolPolicy,
  fetchOpenCodeAgents,
  matchesPermissionPattern,
  normalizePermissionRuleset,
  resolveToolPermissionTarget,
} from './opencode-agents.js';

const buildOpenCodeUrl = (path) => `http://127.0.0.1:4096${path}`;

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

describe('matchesPermissionPattern', () => {
  it('matches anything for wildcard-ish patterns, even an empty candidate', () => {
    for (const pattern of ['*', '**', '', '   ']) {
      expect(matchesPermissionPattern(pattern, '')).toBe(true);
      expect(matchesPermissionPattern(pattern, 'anything at all')).toBe(true);
    }
  });

  it('fails closed when a concrete pattern has no candidate to check', () => {
    expect(matchesPermissionPattern('git *', '')).toBe(false);
  });

  it('applies glob semantics: * runs, ? is exactly one char', () => {
    expect(matchesPermissionPattern('git *', 'git status')).toBe(true);
    expect(matchesPermissionPattern('git *', 'npm test')).toBe(false);
    expect(matchesPermissionPattern('a?c', 'abc')).toBe(true);
    expect(matchesPermissionPattern('a?c', 'ac')).toBe(false);
    expect(matchesPermissionPattern('a?c', 'abbc')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literal text', () => {
    expect(matchesPermissionPattern('a.b', 'axb')).toBe(false);
    expect(matchesPermissionPattern('a.b', 'a.b')).toBe(true);
  });

  it('matches across newlines in a multi-line candidate', () => {
    expect(matchesPermissionPattern('git *', 'git commit -m "line one\nline two"')).toBe(true);
  });
});

describe('resolveToolPermissionTarget', () => {
  it('maps known Claude tool names to their OpenCode permission key', () => {
    const cases = {
      Bash: 'bash', BashOutput: 'bash', Edit: 'edit', Write: 'edit', MultiEdit: 'edit',
      NotebookEdit: 'edit', Read: 'read', Glob: 'glob', Grep: 'grep', WebFetch: 'webfetch',
      WebSearch: 'websearch', Task: 'task', Agent: 'task', TodoWrite: 'todowrite', Skill: 'skill',
    };
    for (const [tool, permission] of Object.entries(cases)) {
      expect(resolveToolPermissionTarget(tool, {}).key).toBe(permission);
    }
  });

  it('falls back to the lowercased tool name for an unknown tool', () => {
    expect(resolveToolPermissionTarget('SomeNewTool', {}).key).toBe('somenewtool');
  });

  it('keeps the full lowercased name for an MCP tool', () => {
    expect(resolveToolPermissionTarget('mcp__foo__bar', {}).key).toBe('mcp__foo__bar');
  });

  it('extracts the candidate value from the right input field per tool', () => {
    expect(resolveToolPermissionTarget('Bash', { command: 'git status' }).candidate).toBe('git status');
    expect(resolveToolPermissionTarget('Edit', { file_path: '/a/b.ts' }).candidate).toBe('/a/b.ts');
    expect(resolveToolPermissionTarget('WebFetch', { url: 'https://example.com' }).candidate).toBe('https://example.com');
  });

  it('returns an empty candidate when the key has no pattern field table', () => {
    expect(resolveToolPermissionTarget('mcp__foo__bar', { anything: 'x' }).candidate).toBe('');
  });

  it('returns an empty candidate when the input is missing every listed field', () => {
    expect(resolveToolPermissionTarget('Bash', { unrelated: 'value' }).candidate).toBe('');
  });
});

describe('normalizePermissionRuleset', () => {
  it('returns an empty array for non-array input', () => {
    for (const value of [null, undefined, 'bash', { permission: 'bash', action: 'allow' }]) {
      expect(normalizePermissionRuleset(value)).toEqual([]);
    }
  });

  it('drops entries missing a permission or with an unknown action', () => {
    const result = normalizePermissionRuleset([
      { action: 'allow', pattern: '*' },
      { permission: '', action: 'allow' },
      { permission: 'bash', action: 'maybe' },
      { permission: 'bash' },
    ]);
    expect(result).toEqual([]);
  });

  it('defaults a missing or blank pattern to *', () => {
    expect(normalizePermissionRuleset([{ permission: 'bash', action: 'allow' }]))
      .toEqual([{ permission: 'bash', pattern: '*', action: 'allow' }]);
    expect(normalizePermissionRuleset([{ permission: 'bash', pattern: '   ', action: 'allow' }]))
      .toEqual([{ permission: 'bash', pattern: '*', action: 'allow' }]);
  });

  it('lowercases permission and action', () => {
    expect(normalizePermissionRuleset([{ permission: 'BASH', pattern: 'git *', action: 'ALLOW' }]))
      .toEqual([{ permission: 'bash', pattern: 'git *', action: 'allow' }]);
  });
});

describe('createOpenCodeToolPolicy', () => {
  it('always asks when the ruleset is empty or absent', () => {
    expect(createOpenCodeToolPolicy(null)('Bash', { command: 'git status' })).toBe('ask');
    expect(createOpenCodeToolPolicy([])('Bash', { command: 'git status' })).toBe('ask');
  });

  it('prefers an exact-permission rule over a global * rule regardless of order', () => {
    const policy = createOpenCodeToolPolicy([
      { permission: 'bash', pattern: '*', action: 'allow' },
      { permission: '*', pattern: '*', action: 'deny' },
    ]);
    expect(policy('Bash', { command: 'git status' })).toBe('allow');
    expect(policy('Read', { file_path: '/a' })).toBe('deny');
  });

  it('lets the last matching rule for the same permission key win', () => {
    const policy = createOpenCodeToolPolicy([
      { permission: 'bash', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'deny' },
    ]);
    expect(policy('Bash', { command: 'git status' })).toBe('deny');
  });

  it('falls through to the * rule (or ask) when a concrete pattern does not match', () => {
    const withGlobalFallback = createOpenCodeToolPolicy([
      { permission: 'bash', pattern: 'git *', action: 'allow' },
      { permission: '*', pattern: '*', action: 'deny' },
    ]);
    expect(withGlobalFallback('Bash', { command: 'git status' })).toBe('allow');
    expect(withGlobalFallback('Bash', { command: 'rm -rf /' })).toBe('deny');

    const withoutGlobalFallback = createOpenCodeToolPolicy([
      { permission: 'bash', pattern: 'git *', action: 'allow' },
    ]);
    expect(withoutGlobalFallback('Bash', { command: 'git status' })).toBe('allow');
    expect(withoutGlobalFallback('Bash', { command: 'rm -rf /' })).toBe('ask');
  });

  it('resolves a deny rule to deny', () => {
    const policy = createOpenCodeToolPolicy([{ permission: 'bash', pattern: '*', action: 'deny' }]);
    expect(policy('Bash', { command: 'git status' })).toBe('deny');
  });

  it('lets a concrete pattern beat a later catch-all rule for the same key', () => {
    // Shape taken from a live OpenCode `build` agent: narrow built-in rules
    // come first, broad config rules are appended after them. Pure last-wins
    // would auto-approve reading `.env`, which OpenCode itself still asks for.
    const policy = createOpenCodeToolPolicy([
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: '*.env', action: 'ask' },
      { permission: 'read', pattern: '*.env.*', action: 'ask' },
      { permission: 'read', pattern: '*.env.example', action: 'allow' },
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
    expect(policy('Read', { file_path: '/repo/src/a.ts' })).toBe('allow');
    expect(policy('Read', { file_path: '/repo/.env' })).toBe('ask');
    expect(policy('Read', { file_path: '/repo/.env.local' })).toBe('ask');
    // Two concrete patterns match — the later one wins.
    expect(policy('Read', { file_path: '/repo/.env.example' })).toBe('allow');
  });

  it('resolves the real-world all-allow ruleset shape', () => {
    const policy = createOpenCodeToolPolicy([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'webfetch', pattern: '*', action: 'allow' },
      { permission: 'task', pattern: '*', action: 'allow' },
    ]);
    expect(policy('Bash', { command: 'git status' })).toBe('allow');
    expect(policy('Edit', { file_path: '/a' })).toBe('allow');
    expect(policy('WebFetch', { url: 'https://example.com' })).toBe('allow');
    expect(policy('Task', { subagent_type: 'general' })).toBe('allow');
    expect(policy('mcp__unknown__tool', {})).toBe('allow');
  });
});

describe('claudePermissionModeFromEditAction', () => {
  it('maps an inherited edit decision onto an allowlisted Claude permission mode', () => {
    const cases = { allow: 'acceptEdits', deny: 'plan', ask: 'default' };
    for (const [action, mode] of Object.entries(cases)) {
      expect(claudePermissionModeFromEditAction(action)).toBe(mode);
    }
  });

  it('derives the mode from the agent ruleset, not from a client-supplied value', () => {
    // `acceptEdits` makes the SDK auto-accept edits without calling canUseTool,
    // so an agent whose edit rule is `ask` must never resolve to it.
    const asks = buildOpenCodeAgentInheritance([
      { name: 'careful', permission: [{ permission: 'edit', pattern: '*', action: 'ask' }] },
    ], 'careful');
    expect(claudePermissionModeFromEditAction(asks.resolveToolPolicy('Edit', {}))).toBe('default');

    const allows = buildOpenCodeAgentInheritance([
      { name: 'loose', permission: [{ permission: 'edit', pattern: '*', action: 'allow' }] },
    ], 'loose');
    expect(claudePermissionModeFromEditAction(allows.resolveToolPolicy('Edit', {}))).toBe('acceptEdits');
  });
});

describe('buildClaudeAgentDefinitions', () => {
  it('returns an empty object for non-array input', () => {
    expect(buildClaudeAgentDefinitions(null)).toEqual({});
    expect(buildClaudeAgentDefinitions(undefined)).toEqual({});
    expect(buildClaudeAgentDefinitions('agent')).toEqual({});
  });

  it('excludes OpenCode-shipped agents even with a prompt and subagent mode', () => {
    // The live `/agent` payload uses `native`; the SDK type documents
    // `builtIn`. Both must exclude, or every OpenCode built-in would be
    // registered as a Claude subagent with a one-line config prompt.
    expect(buildClaudeAgentDefinitions([
      { name: 'build', builtIn: true, mode: 'subagent', prompt: 'You build things.' },
      { name: 'explore', native: true, mode: 'subagent', prompt: 'Web search: load a skill.' },
    ])).toEqual({});
  });

  it('excludes hidden internal agents', () => {
    expect(buildClaudeAgentDefinitions([
      { name: 'title', hidden: true, mode: 'subagent', prompt: 'Generate a title.' },
    ])).toEqual({});
  });

  it('includes subagent and all modes, excludes primary mode', () => {
    const result = buildClaudeAgentDefinitions([
      { name: 'sub-agent', mode: 'subagent', prompt: 'Sub prompt' },
      { name: 'all-agent', mode: 'all', prompt: 'All prompt' },
      { name: 'primary-agent', mode: 'primary', prompt: 'Primary prompt' },
    ]);
    expect(Object.keys(result).sort()).toEqual(['all-agent', 'sub-agent']);
  });

  it('excludes an agent with no prompt or a whitespace-only prompt', () => {
    const result = buildClaudeAgentDefinitions([
      { name: 'no-prompt', mode: 'subagent' },
      { name: 'blank-prompt', mode: 'subagent', prompt: '   ' },
    ]);
    expect(result).toEqual({});
  });

  it('maps description (with fallback) and prompt', () => {
    const result = buildClaudeAgentDefinitions([
      { name: 'reviewer', mode: 'subagent', prompt: 'Review code.', description: 'Reviews code' },
      { name: 'nameless', mode: 'subagent', prompt: 'Do a thing.' },
    ]);
    expect(result.reviewer).toMatchObject({ description: 'Reviews code', prompt: 'Review code.' });
    expect(result.nameless).toMatchObject({ description: 'OpenCode agent "nameless"', prompt: 'Do a thing.' });
  });

  it('omits the tools key for an all-true tools record and builds an allowlist otherwise', () => {
    const result = buildClaudeAgentDefinitions([
      {
        name: 'all-true',
        mode: 'subagent',
        prompt: 'Prompt',
        tools: { bash: true, edit: true },
      },
      {
        name: 'some-false',
        mode: 'subagent',
        prompt: 'Prompt',
        tools: { bash: true, edit: false, read: true },
      },
    ]);
    expect(result['all-true'].tools).toBeUndefined();
    expect(result['some-false'].tools).toEqual(['bash', 'read']);
  });

  it('forwards a Claude-recognizable modelID and omits others', () => {
    const result = buildClaudeAgentDefinitions([
      {
        name: 'claude-model',
        mode: 'subagent',
        prompt: 'Prompt',
        model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' },
      },
      {
        name: 'other-model',
        mode: 'subagent',
        prompt: 'Prompt',
        model: { modelID: 'gpt-4o' },
      },
    ]);
    expect(result['claude-model'].model).toBe('claude-sonnet-4');
    expect(result['other-model'].model).toBeUndefined();
  });

  it('enforces the 50-definition cap', () => {
    const agents = Array.from({ length: 60 }, (_, i) => ({
      name: `agent-${i}`,
      mode: 'subagent',
      prompt: `Prompt ${i}`,
    }));
    const result = buildClaudeAgentDefinitions(agents);
    expect(Object.keys(result).length).toBe(50);
  });
});

describe('fetchOpenCodeAgents', () => {
  it('rejects when buildOpenCodeUrl is missing', async () => {
    const caught = await fetchOpenCodeAgents({ directory: '/repo' }).catch((error) => error);
    expect(caught.code).toBe('AGENT_UNAVAILABLE');
    expect(caught.statusCode).toBe(503);
  });

  it('rejects when fetchImpl throws', async () => {
    const caught = await fetchOpenCodeAgents({
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }).catch((error) => error);
    expect(caught.code).toBe('AGENT_LOOKUP_FAILED');
    expect(caught.statusCode).toBe(502);
  });

  it('rejects on a non-ok response', async () => {
    const caught = await fetchOpenCodeAgents({
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse({ error: 'boom' }, 500),
    }).catch((error) => error);
    expect(caught.code).toBe('AGENT_LOOKUP_FAILED');
    expect(caught.statusCode).toBe(502);
  });

  it('rejects when the JSON body is not an array', async () => {
    const caught = await fetchOpenCodeAgents({
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse({ not: 'an array' }),
    }).catch((error) => error);
    expect(caught.code).toBe('AGENT_LOOKUP_FAILED');
    expect(caught.statusCode).toBe(502);
  });

  it('returns the array on success and URL-encodes the directory query param', async () => {
    let requestedUrl = '';
    const agents = await fetchOpenCodeAgents({
      directory: '/repo/a b',
      buildOpenCodeUrl,
      fetchImpl: async (url) => {
        requestedUrl = url;
        return jsonResponse([{ name: 'reviewer' }]);
      },
    });
    expect(agents).toEqual([{ name: 'reviewer' }]);
    expect(requestedUrl).toBe('http://127.0.0.1:4096/agent?directory=%2Frepo%2Fa%20b');
  });
});

describe('buildOpenCodeAgentInheritance', () => {
  const agents = [
    {
      name: 'reviewer',
      mode: 'subagent',
      prompt: 'You review code.',
      permission: [{ permission: 'bash', pattern: '*', action: 'allow' }],
    },
    {
      name: 'writer',
      mode: 'subagent',
      prompt: 'You write code.',
    },
  ];

  it('matches an agent by name case-insensitively and inherits its prompt and policy', () => {
    const result = buildOpenCodeAgentInheritance(agents, 'REVIEWER');
    expect(result.agentName).toBe('reviewer');
    expect(result.systemPromptAppend).toBe('You review code.');
    expect(result.resolveToolPolicy('Bash', { command: 'git status' })).toBe('allow');
    expect(result.resolveToolPolicy('Read', { file_path: '/a' })).toBe('ask');
  });

  it('fails closed to ask-for-everything when no agent matches or no name is given', () => {
    const noName = buildOpenCodeAgentInheritance(agents);
    expect(noName.agentName).toBe('');
    expect(noName.systemPromptAppend).toBe('');
    expect(noName.resolveToolPolicy('Bash', { command: 'git status' })).toBe('ask');
    expect(noName.resolveToolPolicy('Read', { file_path: '/a' })).toBe('ask');

    const unknownName = buildOpenCodeAgentInheritance(agents, 'does-not-exist');
    expect(unknownName.agentName).toBe('');
    expect(unknownName.systemPromptAppend).toBe('');
    expect(unknownName.resolveToolPolicy('Bash', { command: 'git status' })).toBe('ask');
  });

  it('builds agentDefinitions from the whole agent list, not just the selected one', () => {
    const result = buildOpenCodeAgentInheritance(agents, 'reviewer');
    expect(Object.keys(result.agentDefinitions).sort()).toEqual(['reviewer', 'writer']);
  });
});

describe('createOpenCodeAgentResolver', () => {
  it('returns null when buildOpenCodeUrl is not a function', () => {
    expect(createOpenCodeAgentResolver({})).toBeNull();
    expect(createOpenCodeAgentResolver({ buildOpenCodeUrl: null })).toBeNull();
  });

  it('fetches agents and produces the inheritance shape', async () => {
    const resolve = createOpenCodeAgentResolver({
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse([
        {
          name: 'reviewer',
          mode: 'subagent',
          prompt: 'You review code.',
          permission: [{ permission: 'bash', pattern: '*', action: 'allow' }],
        },
      ]),
    });
    expect(typeof resolve).toBe('function');
    const result = await resolve({ directory: '/repo', agentName: 'reviewer' });
    expect(result.agentName).toBe('reviewer');
    expect(result.systemPromptAppend).toBe('You review code.');
    expect(result.resolveToolPolicy('Bash', { command: 'git status' })).toBe('allow');
    expect(Object.keys(result.agentDefinitions)).toEqual(['reviewer']);
  });
});
