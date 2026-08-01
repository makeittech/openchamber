import { beforeEach, describe, expect, mock, test } from 'bun:test';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const runtimeFetchMock = mock(async () => jsonResponse({}));

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: runtimeFetchMock }));

const {
  harnessAbort,
  harnessPermissionReply,
  harnessPrompt,
  listClaudeImportCandidates,
  importClaudeSessions,
  harnessSessionBinding,
  harnessClaudeAgents,
  HarnessClientError,
} = await import(`./client?cache-test=${Date.now()}`);

const promptParams = (overrides = {}) => ({
  sessionId: 'ses_1',
  directory: '/project',
  target: { harnessId: 'claude-code', modelRef: 'sonnet' },
  text: 'hello',
  ...overrides,
});

const requestBody = () => JSON.parse(String(runtimeFetchMock.mock.calls[0][1].body));

async function expectClientError(promise, expected) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HarnessClientError);
  expect(caught).toMatchObject(expected);
}

beforeEach(() => {
  runtimeFetchMock.mockReset();
  runtimeFetchMock.mockImplementation(async () => jsonResponse({ ok: true, status: 'started' }, 202));
});

describe('harness prompt payload', () => {
  test('shapes the full prompt body', async () => {
    await harnessPrompt(promptParams({
      files: [{ mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'a.png' }],
      messageId: 'msg_1',
      seedFromSessionId: ' ses_source ',
      agentsMode: 'opencode',
      agent: ' build ',
      claudeAgent: ' reviewer ',
      systemPromptAppend: ' prompt ',
      command: { name: ' pr-review ', arguments: ' 2480 ' },
    }));
    expect(requestBody()).toEqual({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      text: 'hello',
      files: [{ mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'a.png' }],
      messageId: 'msg_1',
      seedFromSessionId: 'ses_source',
      agentsMode: 'opencode',
      agent: 'build',
      claudeAgent: 'reviewer',
      systemPromptAppend: 'prompt',
      command: { name: 'pr-review', arguments: '2480' },
    });
  });

  test.each([
    ['agent', { agent: '   ' }],
    ['claudeAgent', { claudeAgent: '   ' }],
    ['command', { command: { name: '   ' } }],
  ])('omits blank %s', async (key, value) => {
    await harnessPrompt(promptParams(value));
    expect(requestBody()).not.toHaveProperty(key);
  });

  test('omits blank command arguments', async () => {
    await harnessPrompt(promptParams({
      command: { name: 'changelog', arguments: '  ' },
    }));
    expect(requestBody().command).toEqual({ name: 'changelog' });
  });

  test('rejects OpenCode targets', async () => {
    await expect(harnessPrompt(promptParams({
      target: { harnessId: 'opencode', providerId: 'anthropic', modelId: 'claude' },
    }))).rejects.toBeInstanceOf(HarnessClientError);
  });
});

describe('harness HTTP client', () => {
  test('posts prompts through runtimeFetch without credentials', async () => {
    await harnessPrompt(promptParams({ target: { harnessId: 'claude-code', modelRef: 'opus' } }));
    const [path, init] = runtimeFetchMock.mock.calls[0];
    expect(path).toBe('/api/harness/prompt');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'ses_1',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'opus' },
      text: 'hello',
    });
    expect(String(init.body)).not.toContain('authorization');
    expect(String(init.body)).not.toContain('token');
  });

  test.each([
    ['abort', () => harnessAbort({ sessionId: 'ses_1', directory: '/project' }),
      '/api/harness/abort', { sessionId: 'ses_1', directory: '/project' }],
    ['permission reply', () => harnessPermissionReply({
      sessionId: 'ses_1', requestId: 'perm_1', reply: 'once', directory: '/project',
    }), '/api/harness/permission/reply', {
      sessionId: 'ses_1', requestId: 'perm_1', reply: 'once', directory: '/project',
    }],
  ])('posts %s requests', async (_name, call, path, body) => {
    await call();
    expect(runtimeFetchMock.mock.calls[0][0]).toBe(path);
    expect(JSON.parse(String(runtimeFetchMock.mock.calls[0][1].body))).toEqual(body);
  });

  test('preserves structured server errors', async () => {
    runtimeFetchMock.mockImplementation(async () => jsonResponse({
      error: 'Claude Code is not ready', code: 'CLAUDE_NOT_READY', status: 'needs-login',
    }, 503));
    await expectClientError(harnessPrompt(promptParams()), {
      code: 'CLAUDE_NOT_READY', statusCode: 503, status: 'needs-login',
    });
  });
});

describe('harnessClaudeAgents', () => {
  test('sanitizes agents and roots', async () => {
    runtimeFetchMock.mockImplementation(async () => jsonResponse({
      agents: [
        { name: 'Reviewer', description: 'Reviews code', model: 'sonnet', source: 'project' },
        { name: 'reviewer', source: 'user' },
        { name: '   ' },
        { name: 'Builder', source: 'unknown' },
      ],
      roots: { user: '   ', project: 42 },
    }));
    expect(await harnessClaudeAgents('/tmp/app')).toEqual({
      agents: [
        { name: 'Reviewer', description: 'Reviews code', model: 'sonnet', source: 'project' },
        { name: 'Builder', description: '', model: '', source: 'builtin' },
      ],
      roots: { user: null, project: null },
    });
    expect(runtimeFetchMock.mock.calls[0][1].query).toEqual({ directory: '/tmp/app' });
  });

  test('defaults absent roots to null', async () => {
    runtimeFetchMock.mockImplementation(async () => jsonResponse({ agents: [] }));
    expect((await harnessClaudeAgents()).roots).toEqual({ user: null, project: null });
  });

  test.each([
    ['server', async () => jsonResponse({ error: 'not ready', code: 'CLAUDE_MISSING_CLI' }, 503),
      { code: 'CLAUDE_MISSING_CLI', statusCode: 503 }],
    ['network', async () => { throw new Error('offline'); }, { code: 'HARNESS_NETWORK' }],
  ])('surfaces %s failures', async (_name, implementation, expected) => {
    runtimeFetchMock.mockImplementation(implementation);
    await expectClientError(harnessClaudeAgents('/tmp/app'), expected);
  });
});

describe('Claude import client', () => {
  test('lists candidates', async () => {
    runtimeFetchMock.mockImplementation(async () => jsonResponse({
      projects: [{ sessions: [{ foreignSessionId: 'foreign', updatedAt: 1 }] }],
    }));
    const result = await listClaudeImportCandidates();
    expect(runtimeFetchMock.mock.calls[0][0]).toBe('/api/harness/claude-code/import/candidates');
    expect(result.projects[0].sessions[0].foreignSessionId).toBe('foreign');
  });

  test('imports selected sessions', async () => {
    runtimeFetchMock.mockImplementation(async () => jsonResponse({
      results: [{ ok: true, foreignSessionId: 'foreign', sessionId: 'ses_1' }],
      summary: { imported: 1, skipped: 0, failed: 0 },
    }));
    const result = await importClaudeSessions([{ foreignSessionId: 'foreign', directory: '/tmp/app' }]);
    expect(runtimeFetchMock.mock.calls[0][0]).toBe('/api/harness/claude-code/import');
    expect(result).toMatchObject({ summary: { imported: 1 }, results: [{ sessionId: 'ses_1' }] });
  });
});

describe('harnessSessionBinding', () => {
  test('parses Claude bindings', async () => {
    runtimeFetchMock.mockImplementation(async () => jsonResponse({ binding: {
      sessionId: 'ses_1',
      harnessId: 'claude-code',
      target: { harnessId: 'claude-code', modelRef: 'opus', permissionMode: 'acceptEdits', effort: 'high' },
    } }));
    expect(await harnessSessionBinding('ses_1')).toMatchObject({
      harnessId: 'claude-code',
      target: { harnessId: 'claude-code', modelRef: 'opus', permissionMode: 'acceptEdits', effort: 'high' },
    });
  });

  test.each([
    ['404', async () => jsonResponse({}, 404)],
    ['network failure', async () => { throw new Error('offline'); }],
    ['invalid payload', async () => jsonResponse({ binding: { sessionId: 'ses_1' } })],
  ])('returns null for %s', async (_name, implementation) => {
    runtimeFetchMock.mockImplementation(implementation);
    expect(await harnessSessionBinding('ses_1')).toBeNull();
  });
});
