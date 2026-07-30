import { beforeEach, describe, expect, mock, test } from 'bun:test';

const runtimeFetchMock = mock(async () => new Response('{}'));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const {
  buildHarnessPromptBody,
  harnessAbort,
  harnessPermissionReply,
  harnessPrompt,
  listClaudeImportCandidates,
  importClaudeSessions,
  harnessSessionBinding,
  harnessClaudeAgents,
  HarnessClientError,
} = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  runtimeFetchMock.mockReset();
  runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, status: 'started' }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  }));
});

describe('buildHarnessPromptBody', () => {
  test('shapes prompt body with files and messageId', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet', permissionMode: 'default' },
      text: 'hello',
      files: [{ mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'a.png' }],
      messageId: 'msg_1',
    });

    expect(body).toEqual({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet', permissionMode: 'default' },
      text: 'hello',
      files: [{ mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'a.png' }],
      messageId: 'msg_1',
    });
  });

  test('includes seedFromSessionId for handoff prompts', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_new',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hello',
      seedFromSessionId: 'ses_source',
    });
    expect(body.seedFromSessionId).toBe('ses_source');
  });

  test('carries an OpenCode command reference without its template', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: '',
      command: { name: ' pr-review ', arguments: ' 2480 ' },
    });
    expect(body.command).toEqual({ name: 'pr-review', arguments: '2480' });
  });

  test('omits empty command arguments and unnamed commands', () => {
    const withoutArgs = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: '',
      command: { name: 'changelog', arguments: '  ' },
    });
    expect(withoutArgs.command).toEqual({ name: 'changelog' });

    const unnamed = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hi',
      command: { name: '   ' },
    });
    expect(unnamed.command).toBeUndefined();
  });

  test('rejects opencode targets', () => {
    expect(() => buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'opencode', providerId: 'anthropic', modelId: 'claude' },
      text: 'hi',
    })).toThrow(HarnessClientError);
  });

  test('includes a trimmed agent when present', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hi',
      agent: '  build  ',
    });
    expect(body.agent).toBe('build');
  });

  test('omits a blank agent entirely', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hi',
      agent: '   ',
    });
    expect(Object.prototype.hasOwnProperty.call(body, 'agent')).toBe(false);
  });

  test('includes a trimmed claudeAgent when present and omits it when blank', () => {
    const withAgent = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hi',
      claudeAgent: 'code-reviewer',
    });
    expect(withAgent.claudeAgent).toBe('code-reviewer');

    const blank = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hi',
      claudeAgent: '   ',
    });
    expect(Object.prototype.hasOwnProperty.call(blank, 'claudeAgent')).toBe(false);
  });

  test('omits agent and claudeAgent when the params do not include them', () => {
    const body = buildHarnessPromptBody({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hi',
    });
    expect(Object.prototype.hasOwnProperty.call(body, 'agent')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'claudeAgent')).toBe(false);
  });
});

describe('harnessClaudeAgents', () => {
  test('sanitizes agents: drops unnamed entries, dedupes case-insensitively, and defaults source/description/model', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      agents: [
        { name: 'Reviewer', description: 'Reviews code', model: 'sonnet', source: 'project' },
        { name: 'reviewer', description: 'duplicate, should be dropped', model: 'opus', source: 'user' },
        { name: '   ' },
        { description: 'no name field at all' },
        { name: 'Builder', source: 'weird-value' },
      ],
      roots: { user: '/home/u/.claude/agents', project: '/tmp/app/.claude/agents' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await harnessClaudeAgents('/tmp/app');

    expect(result.agents).toEqual([
      { name: 'Reviewer', description: 'Reviews code', model: 'sonnet', source: 'project' },
      { name: 'Builder', description: '', model: '', source: 'builtin' },
    ]);
  });

  test('normalizes roots.user/project to null when absent, blank, or non-string', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      agents: [],
      roots: { user: '   ', project: 42 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await harnessClaudeAgents('/tmp/app');
    expect(result.roots).toEqual({ user: null, project: null });

    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      agents: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const withoutRoots = await harnessClaudeAgents('/tmp/app');
    expect(withoutRoots.roots).toEqual({ user: null, project: null });
  });

  test('forwards directory as a runtimeFetch query param', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      agents: [],
      roots: { user: null, project: null },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await harnessClaudeAgents('/tmp/app');
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/claude-code/agents');
    expect(init.query).toEqual({ directory: '/tmp/app' });
  });

  test('non-ok response throws HarnessClientError with the payload code/status and does not resolve to an empty agent list', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      error: 'Claude Code is not ready',
      code: 'CLAUDE_MISSING_CLI',
    }), { status: 503 }));

    let caught = null;
    let resolved;
    try {
      resolved = await harnessClaudeAgents('/tmp/app');
    } catch (error) {
      caught = error;
    }

    // Failure must surface as a thrown error, never as a silently-empty agent list.
    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(HarnessClientError);
    expect(caught.code).toBe('CLAUDE_MISSING_CLI');
    expect(caught.statusCode).toBe(503);
  });

  test('a network throw becomes a HarnessClientError with code HARNESS_NETWORK', async () => {
    runtimeFetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });

    let caught = null;
    try {
      await harnessClaudeAgents('/tmp/app');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HarnessClientError);
    expect(caught.code).toBe('HARNESS_NETWORK');
  });
});

describe('harnessPrompt', () => {
  test('posts to /api/harness/prompt via runtimeFetch', async () => {
    await harnessPrompt({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'opus' },
      text: 'ping',
      messageId: 'msg_user',
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/prompt');
    expect(init.method).toBe('POST');
    const parsed = JSON.parse(String(init.body));
    expect(parsed.sessionId).toBe('ses_1');
    expect(parsed.directory).toBe('/project');
    expect(parsed.target).toEqual({ harnessId: 'claude-code', modelRef: 'opus' });
    expect(parsed.text).toBe('ping');
    expect(parsed.messageId).toBe('msg_user');
    expect(Object.prototype.hasOwnProperty.call(parsed, 'token')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'authorization')).toBe(false);
  });

  test('throws typed HarnessClientError on non-OK response', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      error: 'Claude Code is not ready',
      code: 'CLAUDE_NOT_READY',
      status: 'needs-login',
    }), { status: 503 }));

    let caught = null;
    try {
      await harnessPrompt({
        sessionId: 'ses_1',
        directory: '/project',
        target: { harnessId: 'claude-code', modelRef: 'sonnet' },
        text: 'hi',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HarnessClientError);
    expect(caught.code).toBe('CLAUDE_NOT_READY');
    expect(caught.statusCode).toBe(503);
    expect(caught.status).toBe('needs-login');
  });
});

describe('harnessAbort', () => {
  test('posts sessionId to /api/harness/abort', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await harnessAbort({ sessionId: 'ses_1', directory: '/project' });
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/abort');
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: 'ses_1', directory: '/project' });
  });
});

describe('harnessPermissionReply', () => {
  test('posts to /api/harness/permission/reply via runtimeFetch', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await harnessPermissionReply({
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
      directory: '/project',
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
    });
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/permission/reply');
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'ses_1',
      requestId: 'perm_1',
      reply: 'once',
      directory: '/project',
    });
  });
});

describe('claude import client', () => {
  test('lists candidates via runtimeFetch', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      configDir: '/tmp/.claude',
      projectsRoot: '/tmp/.claude/projects',
      projects: [{
        projectKey: '-tmp-app',
        directory: '/tmp/app',
        directoryMissing: false,
        sessionCount: 1,
        sessions: [{
          foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Hello',
          directory: '/tmp/app',
          updatedAt: 1,
          alreadyImported: false,
          directoryMissing: false,
        }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await listClaudeImportCandidates();
    expect(runtimeFetchMock.mock.calls[0][0]).toBe('/api/harness/claude-code/import/candidates');
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].sessions[0].foreignSessionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  test('posts selected sessions for import', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      results: [{
        ok: true,
        foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: 'ses_1',
        directory: '/tmp/app',
        status: 'imported',
      }],
      summary: { imported: 1, skipped: 0, failed: 0 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await importClaudeSessions([{
      foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      directory: '/tmp/app',
      title: 'Hello',
    }]);

    expect(runtimeFetchMock.mock.calls[0][0]).toBe('/api/harness/claude-code/import');
    expect(result.summary.imported).toBe(1);
    expect(result.results[0].sessionId).toBe('ses_1');
  });
});

describe('harnessSessionBinding', () => {
  test('parses a Claude binding with effort target', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      binding: {
        sessionId: 'ses_1',
        harnessId: 'claude-code',
        directory: '/tmp/app',
        target: { harnessId: 'claude-code', modelRef: 'opus', permissionMode: 'acceptEdits', effort: 'high' },
        foreignSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const binding = await harnessSessionBinding('ses_1');
    expect(runtimeFetchMock.mock.calls[0][0]).toBe('/api/harness/sessions/ses_1');
    expect(binding?.harnessId).toBe('claude-code');
    expect(binding?.target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'opus',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });
  });

  test('returns null for 404 and network failures', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    expect(await harnessSessionBinding('ses_plain')).toBeNull();

    runtimeFetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });
    expect(await harnessSessionBinding('ses_plain')).toBeNull();
  });

  test('drops invalid binding payloads', async () => {
    runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({
      binding: { sessionId: 'ses_1' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(await harnessSessionBinding('ses_1')).toBeNull();
  });
});
