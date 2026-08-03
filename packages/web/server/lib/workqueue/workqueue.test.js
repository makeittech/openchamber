import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataDir;
let previousCursorEnv;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-workqueue-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  previousCursorEnv = {
    apiKey: process.env.OPENCHAMBER_CURSOR_API_KEY,
    apiVersion: process.env.OPENCHAMBER_CURSOR_API_VERSION,
    requestTimeout: process.env.OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS,
  };
  // Keep the tests isolated from any credentials or deployment-level settings
  // present in the environment running Vitest.
  delete process.env.OPENCHAMBER_CURSOR_API_KEY;
  delete process.env.OPENCHAMBER_CURSOR_API_VERSION;
  delete process.env.OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.OPENCHAMBER_DATA_DIR;
  for (const [name, value] of [
    ['OPENCHAMBER_CURSOR_API_KEY', previousCursorEnv.apiKey],
    ['OPENCHAMBER_CURSOR_API_VERSION', previousCursorEnv.apiVersion],
    ['OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS', previousCursorEnv.requestTimeout],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const createFakeApp = () => {
  const handlers = new Map();
  const register = (method) => (route, handler) => handlers.set(`${method} ${route}`, handler);
  return {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    patch: register('PATCH'),
    delete: register('DELETE'),
    handler: (method, route) => handlers.get(`${method} ${route}`),
  };
};

const createFakeRes = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

describe('store upsert/merge semantics', () => {
  it('adds new items and preserves user-set fields on re-sync', async () => {
    const { upsertSyncedItems, listItems, patchItem } = await import('./store.js');

    const first = upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'Old title', labels: ['bug'] },
    ]);
    expect(first).toEqual({ added: 1, updated: 0 });

    const items = listItems();
    expect(items).toHaveLength(1);
    const patched = patchItem(items[0].id, { status: 'in_progress', assignee: 'me' });
    expect(patched.status).toBe('in_progress');

    // Analysis is set out-of-band by the analysis pass, not by sync.
    patchItem(items[0].id, { aiAnalysis: { summary: 'x', analyzedAt: Date.now() } });

    const second = upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'New title', labels: ['bug', 'p1'] },
    ]);
    expect(second).toEqual({ added: 0, updated: 1 });

    const after = listItems();
    expect(after).toHaveLength(1);
    expect(after[0].title).toBe('New title');
    expect(after[0].labels).toEqual(['bug', 'p1']);
    // Re-sync must not clobber status/assignee/analysis set after the first sync.
    expect(after[0].status).toBe('in_progress');
    expect(after[0].assignee).toBe('me');
    expect(after[0].aiAnalysis?.summary).toBe('x');
  });

  it('stores the source description and refreshes it on re-sync', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'T', body: 'First body' },
    ]);
    expect(listItems()[0].body).toBe('First body');

    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'T', body: 'Edited body' },
    ]);
    expect(listItems()[0].body).toBe('Edited body');
  });

  it('does not erase previously synced PR review comments when a later fetch returns none', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([
      {
        source: 'github',
        sourceId: 'acme/repo#9',
        repo: 'acme/repo',
        type: 'pr',
        title: 'A PR',
        reviewComments: [{ body: 'Review says LGTM', url: 'https://x', author: 'openchamber-bot[bot]', createdAt: 1 }],
      },
    ]);
    expect(listItems()[0].reviewComments).toHaveLength(1);

    // A later sync whose comment fetch failed sends an empty array; the
    // already-known review must survive.
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#9', repo: 'acme/repo', type: 'pr', title: 'A PR', reviewComments: [] },
    ]);
    expect(listItems()[0].reviewComments).toHaveLength(1);
  });

  it('keeps one failed source from erasing the other', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'GH issue' },
    ]);
    // Simulate a Linear sync that found nothing (e.g. disconnected) — an
    // empty incoming batch must not remove already-known GitHub items.
    upsertSyncedItems([]);
    expect(listItems()).toHaveLength(1);
  });

  it('persists the item file as 0600', async () => {
    const { upsertSyncedItems, WORKQUEUE_ITEMS_FILE } = await import('./store.js');
    upsertSyncedItems([{ source: 'linear', sourceId: 'issue-1', type: 'issue', title: 'T' }]);
    const mode = fs.statSync(WORKQUEUE_ITEMS_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('analysis JSON parsing', () => {
  it('stores a valid analysis result', async () => {
    const { analyzeItem } = await import('./analysis.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#2', repo: 'acme/repo', type: 'issue', title: 'Bug' }]);
    const [item] = listItems();

    const generateSmallModelText = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        summary: 'Root cause is X',
        complexity: 'easy',
        priority: 'high',
        confidence: 90,
        estimateMinutes: 15,
        needsHeadless: true,
        needsBrowser: false,
        needsDocker: false,
        generatedPrompt: 'Fix X',
      }),
    });

    const updated = await analyzeItem(item, { generateSmallModelText });
    expect(updated.aiAnalysis?.summary).toBe('Root cause is X');
    expect(updated.aiAnalysis?.complexity).toBe('easy');
    expect(updated.aiAnalysisError).toBeNull();
    expect(generateSmallModelText).toHaveBeenCalledTimes(1);
  });

  it('retries once on malformed output, then records an error instead of guessing', async () => {
    const { analyzeItem } = await import('./analysis.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#3', repo: 'acme/repo', type: 'issue', title: 'Bug' }]);
    const [item] = listItems();

    const generateSmallModelText = vi.fn().mockResolvedValue({ text: 'not json at all' });
    const updated = await analyzeItem(item, { generateSmallModelText });

    expect(generateSmallModelText).toHaveBeenCalledTimes(2);
    expect(updated.aiAnalysis).toBeNull();
    expect(updated.aiAnalysisError).toBe('Model did not return valid analysis JSON');
  });
});

describe('cursor auth storage', () => {
  it('persists the API key file as 0600', async () => {
    const { setCursorApiKey, getCursorApiKey, CURSOR_AUTH_FILE } = await import('./cursor/auth.js');
    setCursorApiKey('cursor-key-abc');
    expect(getCursorApiKey()).toBe('cursor-key-abc');
    const mode = fs.statSync(CURSOR_AUTH_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('cursor API version settings', () => {
  it('defaults to v0 when the stored version is missing or invalid', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ cursorApiVersion: 'v2' }),
      'utf8',
    );

    const { getCursorApiVersion } = await import('./settings.js');

    expect(getCursorApiVersion()).toBe('v0');
  });

  it('persists v1 and can replace it with v0', async () => {
    const { getCursorApiVersion, setCursorApiVersion } = await import('./settings.js');

    expect(getCursorApiVersion()).toBe('v0');
    setCursorApiVersion('v1');
    expect(getCursorApiVersion()).toBe('v1');

    setCursorApiVersion('v0');
    expect(getCursorApiVersion()).toBe('v0');
    expect(() => setCursorApiVersion('v2')).toThrow();
  });

  it('uses v0 and keeps env control for an invalid env version', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ cursorApiVersion: 'v1' }),
      'utf8',
    );
    process.env.OPENCHAMBER_CURSOR_API_VERSION = 'v2';

    const { getCursorApiVersion, isCursorApiVersionConfiguredViaEnv } = await import('./settings.js');

    expect(getCursorApiVersion()).toBe('v0');
    expect(isCursorApiVersionConfiguredViaEnv()).toBe(true);
  });

  it.each([
    ['an array', '[]'],
    ['a string', JSON.stringify('not-settings')],
  ])('treats persisted %s as empty settings', async (_shape, contents) => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), contents, 'utf8');

    const { getTrackedRepos, getCursorApiVersion, setCursorApiVersion } = await import('./settings.js');

    expect(getTrackedRepos()).toEqual([]);
    expect(getCursorApiVersion()).toBe('v0');

    setCursorApiVersion('v1');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')))
      .toEqual({ cursorApiVersion: 'v1' });
  });

  it('preserves unrelated settings when changing the Cursor API version', async () => {
    const settingsFile = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      workqueueRepos: ['acme/repo'],
      unrelated: { enabled: true },
    }), 'utf8');

    const { setCursorApiVersion } = await import('./settings.js');
    setCursorApiVersion('v1');

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual({
      workqueueRepos: ['acme/repo'],
      unrelated: { enabled: true },
      cursorApiVersion: 'v1',
    });
  });

  it('writes settings.json with mode 0600', async () => {
    const { setCursorApiVersion } = await import('./settings.js');
    setCursorApiVersion('v1');

    expect(fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777).toBe(0o600);
  });
});

describe('cursor request timeout resolution', () => {
  it('uses the default for missing and invalid values', async () => {
    const { resolveCursorRequestTimeoutMs } = await import('./cursor/client.js');

    expect(resolveCursorRequestTimeoutMs()).toBe(60_000);

    process.env.OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS = 'not-a-number';
    expect(resolveCursorRequestTimeoutMs()).toBe(60_000);
  });

  it('clamps request timeouts to the minimum and maximum', async () => {
    const { resolveCursorRequestTimeoutMs } = await import('./cursor/client.js');

    process.env.OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS = '500';
    expect(resolveCursorRequestTimeoutMs()).toBe(1_000);

    process.env.OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS = '500000';
    expect(resolveCursorRequestTimeoutMs()).toBe(300_000);
  });
});

describe('analysis', () => {
  const smallModelReturning = (text) => vi.fn().mockResolvedValue({ text });
  const VALID_ANALYSIS = JSON.stringify({
    summary: 'A summary of the task.',
    complexity: 'easy',
    priority: 'high',
    confidence: 80,
    estimateMinutes: 30,
    needsHeadless: true,
    needsBrowser: false,
    needsDocker: false,
    generatedPrompt: 'Do the thing',
  });

  it('refuses to analyze a pull request', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    const { analyzeItem } = await import('./analysis.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#7', repo: 'acme/repo', type: 'pr', title: 'A PR' },
    ]);
    const [pr] = listItems();

    const generateSmallModelText = smallModelReturning(VALID_ANALYSIS);
    await expect(analyzeItem(pr, { generateSmallModelText }))
      .rejects.toMatchObject({ code: 'ANALYSIS_NOT_APPLICABLE' });
    expect(generateSmallModelText).not.toHaveBeenCalled();
  });

  it('includes the synced description in the analysis prompt', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    const { analyzeItem } = await import('./analysis.js');
    upsertSyncedItems([
      {
        source: 'github',
        sourceId: 'acme/repo#1',
        repo: 'acme/repo',
        type: 'issue',
        title: 'Crash on save',
        body: 'Steps to reproduce: click save twice.',
      },
    ]);
    const [issue] = listItems();

    const generateSmallModelText = smallModelReturning(VALID_ANALYSIS);
    await analyzeItem(issue, { generateSmallModelText });

    const { prompt } = generateSmallModelText.mock.calls[0][0];
    expect(prompt).toContain('Steps to reproduce: click save twice.');
  });

  it('retries with a bigger output budget when a reasoning model returns no answer', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    const { analyzeItem } = await import('./analysis.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'Reasoning model case' },
    ]);
    const [issue] = listItems();

    const generateSmallModelText = vi.fn()
      .mockRejectedValueOnce(new Error('OpenCode Go spent the output budget on reasoning and returned no answer (finish_reason: length)'))
      .mockResolvedValueOnce({ text: VALID_ANALYSIS });

    const updated = await analyzeItem(issue, { generateSmallModelText });

    expect(generateSmallModelText).toHaveBeenCalledTimes(2);
    const firstBudget = generateSmallModelText.mock.calls[0][0].maxOutputTokens;
    const retryBudget = generateSmallModelText.mock.calls[1][0].maxOutputTokens;
    expect(retryBudget).toBeGreaterThan(firstBudget);
    expect(updated.aiAnalysis?.priority).toBe('high');
    expect(updated.aiAnalysisError).toBeNull();
  });

  it('reports a non-retryable model failure without a second attempt', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    const { analyzeItem } = await import('./analysis.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#2', repo: 'acme/repo', type: 'issue', title: 'Auth failure case' },
    ]);
    const [issue] = listItems();

    const generateSmallModelText = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    const updated = await analyzeItem(issue, { generateSmallModelText });

    expect(generateSmallModelText).toHaveBeenCalledTimes(1);
    expect(updated.aiAnalysis).toBeNull();
    expect(updated.aiAnalysisError).toContain('401 Unauthorized');
  });

  it('bulk analysis skips PRs and already-analyzed issues, and one failure does not stop the rest', async () => {
    const { upsertSyncedItems, listItems, patchItem } = await import('./store.js');
    const { analyzeAllPending } = await import('./analysis.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'One' },
      { source: 'github', sourceId: 'acme/repo#2', repo: 'acme/repo', type: 'issue', title: 'Two' },
      { source: 'github', sourceId: 'acme/repo#3', repo: 'acme/repo', type: 'pr', title: 'A PR' },
      { source: 'github', sourceId: 'acme/repo#4', repo: 'acme/repo', type: 'issue', title: 'Already done' },
    ]);
    const already = listItems().find((item) => item.title === 'Already done');
    patchItem(already.id, { aiAnalysis: { summary: 'existing', analyzedAt: Date.now() } });

    const generateSmallModelText = vi.fn()
      .mockResolvedValueOnce({ text: VALID_ANALYSIS })
      .mockRejectedValue(new Error('model unavailable'));

    const result = await analyzeAllPending({ generateSmallModelText, concurrency: 1 });

    // Only the two un-analyzed issues are attempted; the PR and the
    // already-analyzed issue are skipped entirely.
    expect(result.total).toBe(2);
    expect(result.done).toBe(1);
    expect(result.failed).toBe(1);
    expect(listItems().find((item) => item.title === 'Already done').aiAnalysis.summary).toBe('existing');
  });
});

describe('cursor client', () => {
  it('sends the API key with Basic auth and the expected v0 launch payload', async () => {
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('cursor-key-abc');
    const { launchCursorAgent } = await import('./cursor/client.js');

    let seenAuth;
    let seenBody;
    const fetchImpl = async (url, init) => {
      seenAuth = init.headers.authorization;
      seenBody = JSON.parse(init.body);
      expect(url).toBe('https://api.cursor.com/v0/agents');
      return new Response(JSON.stringify({ id: 'agent-1', status: 'CREATING' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await launchCursorAgent({
      prompt: 'Fix the bug',
      repoUrl: 'https://github.com/acme/repo',
      fetchImpl,
    });

    expect(seenAuth).toBe(`Basic ${Buffer.from('cursor-key-abc:').toString('base64')}`);
    expect(seenBody).toEqual({
      prompt: { text: 'Fix the bug' },
      source: { repository: 'https://github.com/acme/repo' },
      model: 'default',
    });
    expect(result.id).toBe('agent-1');
  });

  it('sends a caller-chosen model instead of the default', async () => {
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('cursor-key-abc');
    const { launchCursorAgent } = await import('./cursor/client.js');

    let seenBody;
    const fetchImpl = async (_url, init) => {
      seenBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'agent-2', status: 'CREATING' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await launchCursorAgent({
      prompt: 'Fix it',
      repoUrl: 'https://github.com/acme/repo',
      model: 'claude-4.5-sonnet',
      fetchImpl,
    });

    expect(seenBody.model).toBe('claude-4.5-sonnet');
  });

  it('normalizes a v0 agent response into the persisted cloud agent shape', async () => {
    const { normalizeCursorAgent } = await import('./cursor/client.js');
    const normalized = normalizeCursorAgent({
      id: 'bc-adc62ef4',
      status: 'CREATING',
      source: { repository: 'https://github.com/acme/repo', ref: 'main' },
      target: { branchName: 'feat/harness-854c', url: 'https://cursor.com/agents/bc-adc62ef4' },
      name: 'Harness switch',
      createdAt: '2026-07-30T09:40:17.848Z',
    });

    expect(normalized).toMatchObject({
      agentId: 'bc-adc62ef4',
      status: 'CREATING',
      url: 'https://cursor.com/agents/bc-adc62ef4',
      branchName: 'feat/harness-854c',
      name: 'Harness switch',
    });
    expect(normalized.createdAt).toBe(Date.parse('2026-07-30T09:40:17.848Z'));
  });

  it('uses the v1 endpoint and payload, then normalizes separate agent and run records', async () => {
    process.env.OPENCHAMBER_CURSOR_API_VERSION = 'v1';
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('test-only-cursor-key');
    const { launchCursorAgent, normalizeCursorAgent } = await import('./cursor/client.js');

    let seenUrl;
    let seenBody;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        agent: {
          id: 'agent-v1',
          name: 'Version one agent',
          createdAt: '2026-07-30T09:40:17.848Z',
          url: 'https://cursor.com/agents/agent-v1',
        },
        run: {
          id: 'run-v1',
          status: 'CREATING',
          git: { branches: [{ repoUrl: 'github.com/acme/repo', branch: 'feature/v1' }] },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await launchCursorAgent({
      prompt: 'Fix the v1 bug',
      repoUrl: 'https://github.com/acme/repo',
      model: 'claude-4.5-sonnet',
      fetchImpl,
    });

    expect(seenUrl).toBe('https://api.cursor.com/v1/agents');
    expect(seenBody).toEqual({
      prompt: { text: 'Fix the v1 bug' },
      repos: [{ url: 'https://github.com/acme/repo' }],
      model: { id: 'claude-4.5-sonnet' },
    });

    expect(normalizeCursorAgent(response)).toMatchObject({
      agentId: 'agent-v1',
      runId: 'run-v1',
      status: 'CREATING',
      url: 'https://cursor.com/agents/agent-v1',
      branchName: 'feature/v1',
      name: 'Version one agent',
      apiVersion: 'v1',
      createdAt: Date.parse('2026-07-30T09:40:17.848Z'),
    });
  });

  it('does not send the legacy webhook field to the v1 API', async () => {
    process.env.OPENCHAMBER_CURSOR_API_VERSION = 'v1';
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('test-only-cursor-key');
    const { launchCursorAgent } = await import('./cursor/client.js');

    let seenBody;
    const fetchImpl = async (_url, init) => {
      seenBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        agent: { id: 'agent-v1-webhook' },
        run: { id: 'run-v1-webhook', status: 'CREATING' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await launchCursorAgent({
      prompt: 'Fix it',
      repoUrl: 'https://github.com/acme/repo',
      webhookUrl: 'https://example.com/callback',
      fetchImpl,
    });

    expect(seenBody.webhook).toBeUndefined();
  });

  it('does not classify an unrelated abort as a request timeout', async () => {
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('test-only-cursor-key');
    const { CursorApiError, launchCursorAgent } = await import('./cursor/client.js');
    const fetchImpl = vi.fn(async () => {
      const error = new Error('transport aborted before the request was sent');
      error.name = 'AbortError';
      throw error;
    });

    let thrown;
    try {
      await launchCursorAgent({
        prompt: 'Fix it',
        repoUrl: 'https://github.com/acme/repo',
        fetchImpl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CursorApiError);
    expect(thrown.code).not.toBe('CURSOR_API_TIMEOUT');
    expect(thrown.message).toContain('transport aborted before the request was sent');
  });

  it('redacts encoded credentials from transport errors', async () => {
    const apiKey = 'test-only-cursor-key';
    const encodedCredentials = Buffer.from(`${apiKey}:`).toString('base64');
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey(apiKey);
    const { launchCursorAgent } = await import('./cursor/client.js');
    const fetchImpl = vi.fn(async () => {
      throw new Error(`request failed with Authorization: Basic ${encodedCredentials}`);
    });

    let thrown;
    try {
      await launchCursorAgent({
        prompt: 'Fix it',
        repoUrl: 'https://github.com/acme/repo',
        fetchImpl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown.message).not.toContain(apiKey);
    expect(thrown.message).not.toContain(encodedCredentials);
  });

  it('does not treat a malformed successful response as an empty agent', async () => {
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('test-only-cursor-key');
    const { CursorApiError, launchCursorAgent } = await import('./cursor/client.js');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid JSON from Cursor');
      },
    }));

    let thrown;
    try {
      await launchCursorAgent({
        prompt: 'Fix it',
        repoUrl: 'https://github.com/acme/repo',
        fetchImpl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CursorApiError);
    expect(thrown.code).not.toBe('CURSOR_API_TIMEOUT');
    expect(thrown.message).toContain('invalid JSON from Cursor');
  });

  it('classifies a timeout without retrying the request', async () => {
    process.env.OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS = '12345';
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('test-only-cursor-key');
    const { CursorApiError, launchCursorAgent } = await import('./cursor/client.js');
    const fetchImpl = vi.fn(async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });

    let thrown;
    try {
      await launchCursorAgent({
        prompt: 'Fix the slow-start bug',
        repoUrl: 'https://github.com/acme/repo',
        fetchImpl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CursorApiError);
    expect(thrown).toMatchObject({ code: 'CURSOR_API_TIMEOUT' });
    expect(thrown.message).toContain('12345');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the stored v1 run id and merges run status and branch data', async () => {
    const { setCursorApiKey } = await import('./cursor/auth.js');
    setCursorApiKey('test-only-cursor-key');
    const { getCursorAgent } = await import('./cursor/client.js');

    const agentResponse = {
      id: 'agent-v1',
      name: 'Run-aware agent',
      status: 'CREATING',
      latestRunId: 'latest-run',
      createdAt: '2026-07-30T09:40:17.848Z',
      url: 'https://cursor.com/agents/agent-v1',
    };
    const runResponse = {
      id: 'run-7',
      status: 'RUNNING',
      git: {
        branches: [
          { repoUrl: 'github.com/acme/repo', branch: 'feature/run-aware' },
          { repoUrl: 'github.com/acme/repo', branch: 'main' },
        ],
      },
    };
    const seenUrls = [];
    const fetchImpl = vi.fn(async (url) => {
      seenUrls.push(url);
      const payload = url.endsWith('/runs/run-7') ? runResponse : agentResponse;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await getCursorAgent('agent-v1', {
      apiVersion: 'v1',
      runId: 'run-7',
      fetchImpl,
    });

    expect(seenUrls).toEqual([
      'https://api.cursor.com/v1/agents/agent-v1',
      'https://api.cursor.com/v1/agents/agent-v1/runs/run-7',
    ]);
    expect(result).toMatchObject({
      name: 'Run-aware agent',
      status: 'RUNNING',
      target: {
        url: 'https://cursor.com/agents/agent-v1',
        branchName: 'feature/run-aware',
      },
    });
  });

  it('defaults a persisted cloud-agent record without apiVersion to v0', async () => {
    fs.writeFileSync(path.join(dataDir, 'workqueue-items.json'), JSON.stringify({
      items: [{
        id: 'legacy-item',
        source: 'github',
        sourceId: 'acme/repo#42',
        repo: 'acme/repo',
        type: 'issue',
        title: 'Legacy cloud agent',
        cloudAgent: {
          agentId: 'legacy-agent',
          runId: 'legacy-agent',
          status: 'RUNNING',
          url: 'https://cursor.com/agents/legacy-agent',
          branchName: 'main',
          name: 'Legacy agent',
          model: 'default',
          createdAt: 1,
        },
      }],
    }), 'utf8');

    const { listItems } = await import('./store.js');
    const [item] = listItems();

    expect(item.cloudAgent).toMatchObject({
      agentId: 'legacy-agent',
      apiVersion: 'v0',
    });
  });

  it('rejects when no API key is stored', async () => {
    const { launchCursorAgent } = await import('./cursor/client.js');
    await expect(launchCursorAgent({ prompt: 'x', repoUrl: 'https://github.com/a/b' }))
      .rejects.toMatchObject({ code: 'CURSOR_NOT_CONNECTED' });
  });
});

describe('linear identifier reference extraction', () => {
  it('finds a keyword reference regardless of the team key or case', async () => {
    const { extractLinearRef } = await import('./dedup.js');
    expect(extractLinearRef('Closes OPE-123')).toBe('OPE-123');
    expect(extractLinearRef('this fixes eng-42 for real')).toBe('ENG-42');
    expect(extractLinearRef('Resolved: Design-7')).toBe('DESIGN-7');
  });

  it('finds a linear.app issue URL when no keyword is present', async () => {
    const { extractLinearRef } = await import('./dedup.js');
    expect(extractLinearRef('See https://linear.app/acme/issue/OPE-99/some-title for context'))
      .toBe('OPE-99');
  });

  it('returns null when there is no reference', async () => {
    const { extractLinearRef } = await import('./dedup.js');
    expect(extractLinearRef('Just a regular bug report with no ticket link')).toBeNull();
    expect(extractLinearRef('')).toBeNull();
    expect(extractLinearRef(null)).toBeNull();
  });
});

describe('board column <-> Linear state-type mapping', () => {
  it('maps every Linear state type to one of the four columns', async () => {
    const { mapLinearStateTypeToColumn } = await import('./columns.js');
    expect(mapLinearStateTypeToColumn('triage')).toBe('backlog');
    expect(mapLinearStateTypeToColumn('backlog')).toBe('backlog');
    expect(mapLinearStateTypeToColumn('unstarted')).toBe('todo');
    expect(mapLinearStateTypeToColumn('started')).toBe('in_progress');
    expect(mapLinearStateTypeToColumn('completed')).toBe('done');
    expect(mapLinearStateTypeToColumn('canceled')).toBe('done');
    expect(mapLinearStateTypeToColumn('unknown-type')).toBe('backlog');
  });

  it('maps each column back to the Linear state type used to move an issue', async () => {
    const { columnToLinearStateType } = await import('./columns.js');
    expect(columnToLinearStateType('backlog')).toBe('backlog');
    expect(columnToLinearStateType('todo')).toBe('unstarted');
    expect(columnToLinearStateType('in_progress')).toBe('started');
    expect(columnToLinearStateType('done')).toBe('completed');
  });
});

describe('status model', () => {
  it('new items default to backlog, not todo', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'New' },
    ]);
    expect(listItems()[0].status).toBe('backlog');
  });

  it('backfills identifier on re-sync for items synced before dedup existed', async () => {
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'linear', sourceId: 'issue-1', team: 'team-1', type: 'issue', title: 'T' }]);
    expect(listItems()[0].identifier).toBe('');

    upsertSyncedItems([
      { source: 'linear', sourceId: 'issue-1', team: 'team-1', type: 'issue', title: 'T', identifier: 'OPE-5' },
    ]);
    expect(listItems()[0].identifier).toBe('OPE-5');
  });
});

describe('work queue Cursor settings routes', () => {
  it('returns and updates the selected Cursor API version', async () => {
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });

    const getRes = createFakeRes();
    await app.handler('GET', '/api/workqueue/settings/cursor-auth')({ query: {} }, getRes);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toMatchObject({
      apiVersion: 'v0',
      versionConfiguredViaEnv: false,
    });

    const putRes = createFakeRes();
    await app.handler('PUT', '/api/workqueue/settings/cursor-version')({ body: { apiVersion: 'v1' } }, putRes);
    expect(putRes.statusCode).toBe(200);
    expect(putRes.body).toMatchObject({ apiVersion: 'v1' });
  });

  it('rejects an invalid Cursor API version without changing the setting', async () => {
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });

    const res = createFakeRes();
    await app.handler('PUT', '/api/workqueue/settings/cursor-version')({ body: { apiVersion: 'v2' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('v0');
  });
});

describe('finish orchestration', () => {
  it('archives once the GitHub side succeeds even if Linear is not involved', async () => {
    vi.doMock('../github/octokit.js', () => ({
      getOctokitOrNull: () => ({
        rest: { issues: { update: vi.fn().mockResolvedValue({}) } },
      }),
    }));
    const { finishItem } = await import('./finish.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#4', repo: 'acme/repo', type: 'issue', title: 'Bug' }]);
    const [item] = listItems();

    const result = await finishItem(item, {});
    expect(result.issueClosedGitHub).toBe(true);
    expect(result.archived).toBe(true);
  });

  it('reports a failed Linear move without archiving, instead of guessing success', async () => {
    vi.doMock('../linear/client.js', () => ({
      moveIssueToStateType: vi.fn().mockRejectedValue(new Error('Linear down')),
    }));
    const { finishItem } = await import('./finish.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    // A Linear-sourced item with a team set but a failing move.
    upsertSyncedItems([{ source: 'linear', sourceId: 'issue-9', team: 'team-1', type: 'issue', title: 'T' }]);
    const [item] = listItems();

    const result = await finishItem(item, {});
    expect(result.linearMoved).toBe(false);
    expect(result.archived).toBe(false);
  });
});

describe('assignee sync on take', () => {
  it('self-assigns a GitHub item when it is first moved to in_progress', async () => {
    const addAssignees = vi.fn().mockResolvedValue({});
    vi.doMock('../github/auth.js', () => ({ getGitHubAuth: () => ({ user: { login: 'octocat' } }) }));
    vi.doMock('../github/octokit.js', () => ({
      getOctokitOrNull: () => ({ rest: { issues: { addAssignees } } }),
    }));
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#4', repo: 'acme/repo', type: 'issue', title: 'Bug', status: 'backlog' }]);
    const [item] = listItems();

    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });
    const res = createFakeRes();
    await app.handler('PATCH', '/api/workqueue/items/:id')({ params: { id: item.id }, body: { status: 'in_progress' } }, res);

    expect(res.statusCode).toBe(200);
    expect(addAssignees).toHaveBeenCalledWith({ owner: 'acme', repo: 'repo', issue_number: 4, assignees: ['octocat'] });
    expect(res.body.item.assignee).toBe('octocat');
    expect(res.body.assigneeSyncWarning).toBeUndefined();
  });

  it('self-assigns a Linear item when it is first moved to in_progress', async () => {
    const assignIssueToViewer = vi.fn().mockResolvedValue({ changed: true, assigneeName: 'Ada Lovelace' });
    vi.doMock('../linear/client.js', () => ({
      moveIssueToStateType: vi.fn().mockResolvedValue({ changed: true, stateName: 'In Progress' }),
      assignIssueToViewer,
    }));
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'linear', sourceId: 'issue-9', team: 'team-1', type: 'issue', title: 'T', status: 'backlog' }]);
    const [item] = listItems();

    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });
    const res = createFakeRes();
    await app.handler('PATCH', '/api/workqueue/items/:id')({ params: { id: item.id }, body: { status: 'in_progress' } }, res);

    expect(res.statusCode).toBe(200);
    expect(assignIssueToViewer).toHaveBeenCalledWith({ issueId: 'issue-9' });
    expect(res.body.item.assignee).toBe('Ada Lovelace');
  });

  it('surfaces a non-blocking warning and keeps the status change when self-assign fails', async () => {
    vi.doMock('../linear/client.js', () => ({
      moveIssueToStateType: vi.fn().mockResolvedValue({ changed: true, stateName: 'In Progress' }),
      assignIssueToViewer: vi.fn().mockResolvedValue({ changed: false, reason: 'update-failed' }),
    }));
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'linear', sourceId: 'issue-10', team: 'team-1', type: 'issue', title: 'T2', status: 'backlog' }]);
    const [item] = listItems();

    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });
    const res = createFakeRes();
    await app.handler('PATCH', '/api/workqueue/items/:id')({ params: { id: item.id }, body: { status: 'in_progress' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.item.status).toBe('in_progress');
    expect(res.body.item.assignee).toBe('');
    expect(res.body.assigneeSyncWarning).toBe('assignee-not-set');
  });

  it('does not re-assign an item that already has an assignee', async () => {
    const assignIssueToViewer = vi.fn();
    vi.doMock('../linear/client.js', () => ({
      moveIssueToStateType: vi.fn().mockResolvedValue({ changed: true, stateName: 'In Progress' }),
      assignIssueToViewer,
    }));
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const { upsertSyncedItems, listItems, patchItem } = await import('./store.js');
    upsertSyncedItems([{ source: 'linear', sourceId: 'issue-11', team: 'team-1', type: 'issue', title: 'T3', status: 'backlog' }]);
    const [item] = listItems();
    patchItem(item.id, { assignee: 'Existing Person' });

    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });
    const res = createFakeRes();
    await app.handler('PATCH', '/api/workqueue/items/:id')({ params: { id: item.id }, body: { status: 'in_progress' } }, res);

    expect(res.statusCode).toBe(200);
    expect(assignIssueToViewer).not.toHaveBeenCalled();
    expect(res.body.item.assignee).toBe('Existing Person');
  });
});

describe('staleness check', () => {
  it('reports matching commits and days open when the repo has a matching commit', async () => {
    vi.doMock('../git/service.js', () => ({
      searchCommitsByReference: vi.fn().mockResolvedValue([
        { hash: 'abc123', date: '2026-07-01 12:00:00 +0000', message: 'Fix acme/repo#4' },
      ]),
    }));
    const { checkItemStaleness } = await import('./staleness.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{
      source: 'github',
      sourceId: 'acme/repo#4',
      repo: 'acme/repo',
      type: 'issue',
      title: 'Bug',
      createdAt: Date.parse('2026-06-01T00:00:00.000Z'),
    }]);
    const [item] = listItems();

    const result = await checkItemStaleness(item, '/repo');
    expect(result.checked).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].hash).toBe('abc123');
    expect(result.daysOpen).toBeGreaterThan(0);
  });

  it('reports not stale when nothing matches, and skips the search entirely without a directory', async () => {
    const searchCommitsByReference = vi.fn().mockResolvedValue([]);
    vi.doMock('../git/service.js', () => ({ searchCommitsByReference }));
    const { checkItemStaleness } = await import('./staleness.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#5', repo: 'acme/repo', type: 'issue', title: 'Bug2' }]);
    const [item] = listItems();

    const result = await checkItemStaleness(item, '/repo');
    expect(result.checked).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.matches).toEqual([]);

    const withoutDirectory = await checkItemStaleness(item, '');
    expect(withoutDirectory.checked).toBe(false);
    expect(searchCommitsByReference).toHaveBeenCalledTimes(1);
  });

  it('deduplicates commits matched by both sourceId and identifier', async () => {
    vi.doMock('../git/service.js', () => ({
      searchCommitsByReference: vi.fn((_directory, reference) => Promise.resolve(
        reference === 'acme/repo#6' || reference === 'OPE-6'
          ? [{ hash: 'shared-hash', date: '2026-07-10 00:00:00 +0000', message: 'Closes acme/repo#6 / OPE-6' }]
          : [],
      )),
    }));
    const { checkItemStaleness } = await import('./staleness.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{
      source: 'github',
      sourceId: 'acme/repo#6',
      repo: 'acme/repo',
      type: 'issue',
      title: 'Bug3',
      identifier: 'OPE-6',
    }]);
    const [item] = listItems();

    const result = await checkItemStaleness(item, '/repo');
    expect(result.matches).toHaveLength(1);
  });
});

describe('AI similar-commit search in the staleness check', () => {
  const mockGitService = ({ searchResult = [], logEntries = [] } = {}) => {
    vi.doMock('../git/service.js', () => ({
      searchCommitsByReference: vi.fn().mockResolvedValue(searchResult),
      getLog: vi.fn().mockResolvedValue({ all: logEntries }),
    }));
  };

  it('asks the model to pick likely-fix commits from the recent log and grounds picks against real hashes', async () => {
    mockGitService({
      logEntries: [
        { hash: 'simhash', date: '2026-07-10 00:00:00 +0000', message: 'Fix crash on save' },
        { hash: 'unrelated', date: '2026-07-09 00:00:00 +0000', message: 'Bump deps' },
      ],
    });
    const generateSmallModelText = vi.fn().mockResolvedValue({
      text: JSON.stringify({ hashes: ['simhash', 'invented-hash'] }),
    });
    const { checkItemStaleness } = await import('./staleness.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{
      source: 'github',
      sourceId: 'acme/repo#7',
      repo: 'acme/repo',
      type: 'issue',
      title: 'Crash on save',
      createdAt: Date.parse('2026-06-01T00:00:00.000Z'),
    }]);
    const [item] = listItems();

    const result = await checkItemStaleness(item, '/repo', { generateSmallModelText });

    expect(result.checked).toBe(true);
    expect(result.stale).toBe(true);
    // Only the real hash survives; the invented one is dropped.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].hash).toBe('simhash');
    expect(result.matches[0].message).toBe('Fix crash on save');
    expect(generateSmallModelText).toHaveBeenCalledTimes(1);
  });

  it('returns no similar matches when the model errors or returns garbage', async () => {
    mockGitService({
      logEntries: [{ hash: 'simhash', date: '2026-07-10 00:00:00 +0000', message: 'Fix crash on save' }],
    });
    const { checkItemStaleness } = await import('./staleness.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{
      source: 'github',
      sourceId: 'acme/repo#8',
      repo: 'acme/repo',
      type: 'issue',
      title: 'Crash',
      // Before the log commit so the age filter lets it through to the model.
      createdAt: Date.parse('2026-06-01T00:00:00.000Z'),
    }]);
    const [item] = listItems();

    const failed = await checkItemStaleness(item, '/repo', {
      generateSmallModelText: vi.fn().mockRejectedValue(new Error('model unavailable')),
    });
    expect(failed.checked).toBe(true);
    expect(failed.stale).toBe(false);
    expect(failed.matches).toEqual([]);

    const garbage = await checkItemStaleness(item, '/repo', {
      generateSmallModelText: vi.fn().mockResolvedValue({ text: 'not json at all' }),
    });
    expect(garbage.matches).toEqual([]);
  });

  it('skips the AI search when a commit already references the item', async () => {
    const getLog = vi.fn();
    vi.doMock('../git/service.js', () => ({
      searchCommitsByReference: vi.fn().mockResolvedValue([
        { hash: 'refhash', date: '2026-07-10 00:00:00 +0000', message: 'Fix acme/repo#9' },
      ]),
      getLog,
    }));
    const generateSmallModelText = vi.fn();
    const { checkItemStaleness } = await import('./staleness.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#9', repo: 'acme/repo', type: 'issue', title: 'Bug' }]);
    const [item] = listItems();

    const result = await checkItemStaleness(item, '/repo', { generateSmallModelText });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].hash).toBe('refhash');
    expect(getLog).not.toHaveBeenCalled();
    expect(generateSmallModelText).not.toHaveBeenCalled();
  });

  it('folds model-found similar commits into the analysis evidence so alreadySolved grounds on them', async () => {
    mockGitService({
      logEntries: [{ hash: 'simhash', date: '2026-07-10 00:00:00 +0000', message: 'Fix crash on save' }],
    });
    const generateSmallModelText = vi.fn()
      // First call: the similarity search inside the staleness check.
      .mockResolvedValueOnce({ text: JSON.stringify({ hashes: ['simhash'] }) })
      // Second call: the analysis itself, referencing the similar commit.
      .mockResolvedValueOnce({
        text: JSON.stringify({
          summary: 'Summary',
          complexity: 'easy',
          priority: 'low',
          confidence: 50,
          estimateMinutes: 10,
          needsHeadless: false,
          needsBrowser: false,
          needsDocker: false,
          generatedPrompt: '',
          alreadySolved: true,
          alreadySolvedHash: 'simhash',
          duplicateOfId: null,
          duplicateReasoning: '',
        }),
      });
    const { analyzeItem } = await import('./analysis.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{
      source: 'github',
      sourceId: 'acme/repo#1',
      repo: 'acme/repo',
      type: 'issue',
      title: 'Crash',
      // Before the log commit so the age filter lets it through to the model.
      createdAt: Date.parse('2026-06-01T00:00:00.000Z'),
    }]);
    const [item] = listItems();

    const updated = await analyzeItem(item, { generateSmallModelText, directory: '/repo' });

    expect(updated.aiAnalysis.alreadySolved).toBe(true);
    expect(updated.aiAnalysis.alreadySolvedReference.hash).toBe('simhash');
    expect(updated.aiAnalysis.alreadySolvedReference.message).toBe('Fix crash on save');
  });
});

describe('duplicate candidate prefilter', () => {
  it('surfaces other open items with overlapping title words, ranked by similarity', async () => {
    const { findDuplicateCandidates } = await import('./dedup.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'Cards overlap on the work queue board' },
      { source: 'github', sourceId: 'acme/repo#2', repo: 'acme/repo', type: 'issue', title: 'Work queue board cards overlap each other' },
      { source: 'github', sourceId: 'acme/repo#3', repo: 'acme/repo', type: 'issue', title: 'Completely unrelated dark mode bug' },
      { source: 'github', sourceId: 'acme/repo#4', repo: 'acme/repo', type: 'pr', title: 'Cards overlap on the work queue board' },
    ]);
    const items = listItems();
    const target = items.find((item) => item.sourceId === 'acme/repo#1');

    const candidates = findDuplicateCandidates(target, items);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceId).toBe('acme/repo#2');
  });

  it('never returns the item itself, archived items, or PRs', async () => {
    const { findDuplicateCandidates } = await import('./dedup.js');
    const { upsertSyncedItems, listItems, patchItem } = await import('./store.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'Login button does nothing' },
      { source: 'github', sourceId: 'acme/repo#2', repo: 'acme/repo', type: 'issue', title: 'Login button does nothing at all' },
    ]);
    const items = listItems();
    const target = items.find((item) => item.sourceId === 'acme/repo#1');
    const other = items.find((item) => item.sourceId === 'acme/repo#2');
    patchItem(other.id, { archivedAt: Date.now() });

    expect(findDuplicateCandidates(target, [target, { ...other, archivedAt: Date.now() }])).toEqual([]);
  });
});

describe('AI analysis grounding for already-solved and duplicate claims', () => {
  const analysisWithClaims = (overrides) => JSON.stringify({
    summary: 'Summary',
    complexity: 'easy',
    priority: 'low',
    confidence: 50,
    estimateMinutes: 10,
    needsHeadless: false,
    needsBrowser: false,
    needsDocker: false,
    generatedPrompt: '',
    ...overrides,
  });

  it('only persists an already-solved commit that was actually offered as evidence', async () => {
    vi.doMock('../git/service.js', () => ({
      searchCommitsByReference: vi.fn().mockResolvedValue([
        { hash: 'realcommit', date: '2026-07-01 00:00:00 +0000', message: 'Fix the thing' },
      ]),
    }));
    const { analyzeItem } = await import('./analysis.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'Bug' }]);
    const [item] = listItems();

    // The model hallucinates a hash it was never shown.
    const generateSmallModelText = vi.fn().mockResolvedValue({
      text: analysisWithClaims({ alreadySolved: true, alreadySolvedHash: 'madeup', duplicateOfId: null, duplicateReasoning: '' }),
    });
    const hallucinated = await analyzeItem(item, { generateSmallModelText, directory: '/repo' });
    expect(hallucinated.aiAnalysis.alreadySolved).toBe(false);
    expect(hallucinated.aiAnalysis.alreadySolvedReference).toBeNull();

    // The model correctly references the real commit hash it was shown.
    generateSmallModelText.mockResolvedValue({
      text: analysisWithClaims({ alreadySolved: true, alreadySolvedHash: 'realcommit', duplicateOfId: null, duplicateReasoning: '' }),
    });
    const grounded = await analyzeItem(item, { generateSmallModelText, directory: '/repo' });
    expect(grounded.aiAnalysis.alreadySolved).toBe(true);
    expect(grounded.aiAnalysis.alreadySolvedReference.hash).toBe('realcommit');
    expect(grounded.aiAnalysis.alreadySolvedReference.message).toBe('Fix the thing');
  });

  it('only persists a duplicateOfId that was actually offered as a candidate, denormalizing its title/url', async () => {
    const { analyzeItem } = await import('./analysis.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([
      { source: 'github', sourceId: 'acme/repo#1', repo: 'acme/repo', type: 'issue', title: 'Board cards overlap' },
      { source: 'github', sourceId: 'acme/repo#2', repo: 'acme/repo', type: 'issue', title: 'Board cards overlap on the queue', url: 'https://github.com/acme/repo/issues/2' },
    ]);
    const items = listItems();
    const target = items.find((item) => item.sourceId === 'acme/repo#1');
    const candidate = items.find((item) => item.sourceId === 'acme/repo#2');

    const generateSmallModelText = vi.fn().mockResolvedValue({
      text: analysisWithClaims({ duplicateOfId: 'not-a-real-id', duplicateReasoning: 'hallucinated' }),
    });
    const hallucinated = await analyzeItem(target, { generateSmallModelText, allItems: items });
    expect(hallucinated.aiAnalysis.duplicateOfId).toBe('');
    expect(hallucinated.aiAnalysis.duplicateOfUrl).toBe('');

    generateSmallModelText.mockResolvedValue({
      text: analysisWithClaims({ duplicateOfId: candidate.id, duplicateReasoning: 'Same underlying overlap bug, reported first' }),
    });
    const grounded = await analyzeItem(target, { generateSmallModelText, allItems: items });
    expect(grounded.aiAnalysis.duplicateOfId).toBe(candidate.id);
    expect(grounded.aiAnalysis.duplicateOfTitle).toBe(candidate.title);
    expect(grounded.aiAnalysis.duplicateOfUrl).toBe(candidate.url);
    expect(grounded.aiAnalysis.duplicateReasoning).toBe('Same underlying overlap bug, reported first');
  });
});

describe('Linear sync filters out issues already mirrored from GitHub', () => {
  it('does not add a mirrored Linear issue as a second, separate card', async () => {
    vi.doMock('../linear/client.js', () => ({
      graphqlWithStoredAuth: vi.fn().mockResolvedValue({
        issues: {
          nodes: [
            { id: 'mirrored-issue', identifier: 'OPE-1', title: 'Mirrored', team: { id: 'team-1', key: 'OPE' } },
            { id: 'other-issue', identifier: 'OPE-2', title: 'Genuinely new', team: { id: 'team-1', key: 'OPE' } },
          ],
        },
      }),
      ISSUES_ASSIGNED_QUERY: 'query {}',
      fetchTeamsWithStoredAuth: vi.fn(),
    }));
    const { syncAll } = await import('./sources.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{
      source: 'github',
      sourceId: 'acme/repo#1',
      repo: 'acme/repo',
      type: 'issue',
      title: 'Bug',
      linkedLinearId: 'mirrored-issue',
    }]);

    await syncAll();

    const linearItems = listItems({ source: 'linear' });
    expect(linearItems).toHaveLength(1);
    expect(linearItems[0].sourceId).toBe('other-issue');
  });
});

describe('resolveDefaultLinearTeam', () => {
  it('prefers the team already used by synced Linear items over the connection\'s first team', async () => {
    const fetchTeamsWithStoredAuth = vi.fn().mockResolvedValue([{ id: 'unrelated-team' }]);
    vi.doMock('../linear/client.js', () => ({ fetchTeamsWithStoredAuth }));
    const { resolveDefaultLinearTeam } = await import('./sources.js');
    const { upsertSyncedItems } = await import('./store.js');
    upsertSyncedItems([
      { source: 'linear', sourceId: 'issue-1', team: 'team-used-twice', type: 'issue', title: 'A' },
      { source: 'linear', sourceId: 'issue-2', team: 'team-used-twice', type: 'issue', title: 'B' },
      { source: 'linear', sourceId: 'issue-3', team: 'team-used-once', type: 'issue', title: 'C' },
    ]);

    const teamId = await resolveDefaultLinearTeam();
    expect(teamId).toBe('team-used-twice');
    expect(fetchTeamsWithStoredAuth).not.toHaveBeenCalled();
  });

  it('falls back to the connection\'s first team when no Linear item has synced yet', async () => {
    const fetchTeamsWithStoredAuth = vi.fn().mockResolvedValue([{ id: 'first-team' }, { id: 'second-team' }]);
    vi.doMock('../linear/client.js', () => ({ fetchTeamsWithStoredAuth }));
    const { resolveDefaultLinearTeam } = await import('./sources.js');

    const teamId = await resolveDefaultLinearTeam();
    expect(teamId).toBe('first-team');
  });
});

describe('mirroring a GitHub item into Linear on first take-into-progress', () => {
  it('creates, assigns, and moves a new Linear issue, and links it on the item', async () => {
    const createIssue = vi.fn().mockResolvedValue({ id: 'linear-issue-1', identifier: 'OPE-9', url: 'https://linear.app/acme/issue/OPE-9' });
    const assignIssueToViewer = vi.fn().mockResolvedValue({ changed: true, assigneeName: 'Ada Lovelace' });
    const moveIssueToStateType = vi.fn().mockResolvedValue({ changed: true, stateName: 'In Progress' });
    vi.doMock('../linear/auth.js', () => ({ getLinearAuth: () => ({ accessToken: 'token' }) }));
    vi.doMock('../linear/client.js', () => ({ createIssue, assignIssueToViewer, moveIssueToStateType }));

    const { registerWorkQueueRoutes } = await import('./routes.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'linear', sourceId: 'existing-issue', team: 'team-42', type: 'issue', title: 'Existing' }]);
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#4', repo: 'acme/repo', type: 'issue', title: 'Bug', body: 'Steps', url: 'https://github.com/acme/repo/issues/4', status: 'backlog' }]);
    const item = listItems().find((entry) => entry.source === 'github');

    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });
    const res = createFakeRes();
    await app.handler('PATCH', '/api/workqueue/items/:id')({ params: { id: item.id }, body: { status: 'in_progress' } }, res);

    expect(res.statusCode).toBe(200);
    // The already-used team ("team-42", from the existing Linear item) is
    // preferred over an arbitrary pick.
    expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-42', title: 'Bug' }));
    expect(assignIssueToViewer).toHaveBeenCalledWith({ issueId: 'linear-issue-1' });
    expect(moveIssueToStateType).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'linear-issue-1', stateType: 'started' }));
    expect(res.body.item.linkedLinearId).toBe('linear-issue-1');
    expect(res.body.item.linkedLinearUrl).toBe('https://linear.app/acme/issue/OPE-9');
    expect(res.body.item.identifier).toBe('OPE-9');
    expect(res.body.linearCreateWarning).toBeUndefined();
  });

  it('is skipped silently (no warning) when Linear is not connected', async () => {
    vi.doMock('../linear/auth.js', () => ({ getLinearAuth: () => null }));
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#5', repo: 'acme/repo', type: 'issue', title: 'Bug', status: 'backlog' }]);
    const [item] = listItems();

    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });
    const res = createFakeRes();
    await app.handler('PATCH', '/api/workqueue/items/:id')({ params: { id: item.id }, body: { status: 'in_progress' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.linearCreateWarning).toBeUndefined();
    expect(res.body.item.linkedLinearId).toBe('');
  });

  it('never mirrors twice: a second in_progress transition with linkedLinearId already set is a no-op', async () => {
    const createIssue = vi.fn();
    vi.doMock('../linear/auth.js', () => ({ getLinearAuth: () => ({ accessToken: 'token' }) }));
    vi.doMock('../linear/client.js', () => ({ createIssue, assignIssueToViewer: vi.fn(), moveIssueToStateType: vi.fn() }));
    const { registerWorkQueueRoutes } = await import('./routes.js');
    const { upsertSyncedItems, listItems, patchItem } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#6', repo: 'acme/repo', type: 'issue', title: 'Bug', status: 'in_progress', linkedLinearId: 'already-linked' }]);
    let [item] = listItems();
    patchItem(item.id, { status: 'todo' });
    item = listItems()[0];

    const app = createFakeApp();
    registerWorkQueueRoutes(app, { getSmallModelService: vi.fn() });
    const res = createFakeRes();
    await app.handler('PATCH', '/api/workqueue/items/:id')({ params: { id: item.id }, body: { status: 'in_progress' } }, res);

    expect(createIssue).not.toHaveBeenCalled();
  });
});

describe('close reasons on Finish', () => {
  it('closes a GitHub issue as not_planned with a duplicate-of comment when closeReason is duplicate', async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    vi.doMock('../github/octokit.js', () => ({
      getOctokitOrNull: () => ({ rest: { issues: { createComment, update } } }),
    }));
    const { finishItem } = await import('./finish.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'github', sourceId: 'acme/repo#7', repo: 'acme/repo', type: 'issue', title: 'Bug' }]);
    const [item] = listItems();

    const result = await finishItem(item, { closeReason: 'duplicate', duplicateOfUrl: 'https://github.com/acme/repo/issues/1' });

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('https://github.com/acme/repo/issues/1'),
    }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed', state_reason: 'not_planned' }));
    expect(result.issueClosedGitHub).toBe(true);
    const { getItem } = await import('./store.js');
    expect(getItem(item.id).closeReason).toBe('duplicate');
  });

  it('prefers a Linear state named "Duplicate" over the first canceled-type state', async () => {
    const moveIssueToStateType = vi.fn().mockResolvedValue({ changed: true, stateName: 'Duplicate' });
    vi.doMock('../linear/client.js', () => ({ moveIssueToStateType }));
    const { finishItem } = await import('./finish.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{ source: 'linear', sourceId: 'issue-20', team: 'team-1', type: 'issue', title: 'T' }]);
    const [item] = listItems();

    await finishItem(item, { closeReason: 'duplicate' });

    expect(moveIssueToStateType).toHaveBeenCalledWith(expect.objectContaining({
      stateType: 'canceled',
      preferNameMatch: expect.any(RegExp),
    }));
    expect(moveIssueToStateType.mock.calls[0][0].preferNameMatch.test('Duplicate')).toBe(true);
  });

  it('also closes the mirrored Linear issue when finishing a GitHub item that has one', async () => {
    const moveIssueToStateType = vi.fn().mockResolvedValue({ changed: true, stateName: 'Done' });
    vi.doMock('../github/octokit.js', () => ({
      getOctokitOrNull: () => ({ rest: { issues: { update: vi.fn().mockResolvedValue({}) } } }),
    }));
    vi.doMock('../linear/client.js', () => ({ moveIssueToStateType }));
    const { finishItem } = await import('./finish.js');
    const { upsertSyncedItems, listItems } = await import('./store.js');
    upsertSyncedItems([{
      source: 'github',
      sourceId: 'acme/repo#8',
      repo: 'acme/repo',
      type: 'issue',
      title: 'Bug',
      linkedLinearId: 'linear-issue-2',
      team: 'team-1',
    }]);
    const [item] = listItems();

    await finishItem(item, { closeReason: 'completed' });

    expect(moveIssueToStateType).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'linear-issue-2', teamId: 'team-1', stateType: 'completed' }));
  });
});
