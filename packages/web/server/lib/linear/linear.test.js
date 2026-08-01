import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataDir;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.OPENCHAMBER_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('parseIssueRef', () => {
  it('accepts identifiers, URLs, and UUIDs', async () => {
    const { parseIssueRef } = await import('./routes.js');
    expect(parseIssueRef('OPE-296')).toBe('OPE-296');
    expect(parseIssueRef('ope-296')).toBe('OPE-296');
    expect(parseIssueRef('https://linear.app/openchamber/issue/OPE-296/add-linear-integration')).toBe('OPE-296');
    expect(parseIssueRef('https://linear.app/openchamber/issue/OPE-296')).toBe('OPE-296');
    expect(parseIssueRef('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(parseIssueRef('not an issue')).toBeNull();
    expect(parseIssueRef('')).toBeNull();
    expect(parseIssueRef(null)).toBeNull();
    expect(parseIssueRef('https://evil.example/issue/OPE-296')).toBeNull();
  });
});

describe('graphql authorization header', () => {
  it('sends personal API keys raw and OAuth tokens as Bearer', async () => {
    const { fetchViewer } = await import('./client.js');
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers.authorization);
      return new Response(JSON.stringify({ data: { viewer: { id: 'u1', name: 'U' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await fetchViewer({ accessToken: 'lin_api_personalkey', fetchImpl });
    await fetchViewer({ accessToken: 'oauth-access-token', fetchImpl });
    expect(seen).toEqual(['lin_api_personalkey', 'Bearer oauth-access-token']);
  });
});

describe('assignIssueToViewer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assigns the issue to the connected viewer', async () => {
    const { assignIssueToViewer } = await import('./client.js');
    const { setLinearAuth } = await import('./auth.js');
    setLinearAuth({ accessToken: 'token', user: null, organization: null });

    const calls = [];
    vi.stubGlobal('fetch', stubLinearFetch([
      ['OpenChamberViewer', () => graphqlResponse({ viewer: { id: 'viewer-1', name: 'Ada', displayName: 'Ada Lovelace' } })],
      ['OpenChamberIssueUpdateAssignee', (variables) => {
        calls.push(variables.assigneeId);
        return graphqlResponse({
          issueUpdate: { success: true, issue: { id: variables.id, assignee: { id: 'viewer-1', name: 'Ada', displayName: 'Ada Lovelace' } } },
        });
      }],
    ]));

    const result = await assignIssueToViewer({ issueId: 'issue-uuid-1' });
    expect(result).toEqual({ changed: true, assigneeName: 'Ada Lovelace' });
    expect(calls).toEqual(['viewer-1']);
  });

  it('reports a failure instead of guessing success', async () => {
    const { assignIssueToViewer } = await import('./client.js');
    const { setLinearAuth } = await import('./auth.js');
    setLinearAuth({ accessToken: 'token', user: null, organization: null });

    vi.stubGlobal('fetch', stubLinearFetch([
      ['OpenChamberViewer', () => graphqlResponse({ viewer: { id: 'viewer-1', name: 'Ada' } })],
      ['OpenChamberIssueUpdateAssignee', () => graphqlResponse({ issueUpdate: { success: false, issue: null } })],
    ]));

    const result = await assignIssueToViewer({ issueId: 'issue-uuid-1' });
    expect(result).toEqual({ changed: false, reason: 'update-failed' });
  });
});

describe('oauth state', () => {
  it('creates single-use states', async () => {
    const { createOAuthState, consumeOAuthState } = await import('./oauth.js');
    const state = createOAuthState({ redirectUri: 'http://localhost:3001/api/linear/auth/callback' });
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(16);

    const entry = consumeOAuthState(state);
    expect(entry?.redirectUri).toBe('http://localhost:3001/api/linear/auth/callback');
    // second consume fails (single-use)
    expect(consumeOAuthState(state)).toBeNull();
    expect(consumeOAuthState('')).toBeNull();
    expect(consumeOAuthState('nonexistent')).toBeNull();
  });

  it('builds an authorize url with required params', async () => {
    const { buildAuthorizeUrl } = await import('./oauth.js');
    const url = new URL(buildAuthorizeUrl({
      clientId: 'client-123',
      redirectUri: 'http://localhost:3001/api/linear/auth/callback',
      state: 'state-abc',
    }));
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3001/api/linear/auth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('read,write');
    expect(url.searchParams.get('state')).toBe('state-abc');
  });
});

describe('auth storage', () => {
  it('round-trips an auth record and never stores partial entries', async () => {
    const { getLinearAuth, setLinearAuth, clearLinearAuth, LINEAR_AUTH_FILE } = await import('./auth.js');
    expect(getLinearAuth()).toBeNull();

    const stored = setLinearAuth({
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      scope: 'read,write',
      expiresAt: Date.now() + 3600_000,
      user: { id: 'u1', name: 'Test User', email: 'test@example.com' },
      organization: { id: 'o1', name: 'Org', urlKey: 'org' },
    });
    expect(stored.accessToken).toBe('token-abc');
    expect(stored.kind).toBe('oauth');

    const loaded = getLinearAuth();
    expect(loaded?.accessToken).toBe('token-abc');
    expect(loaded?.refreshToken).toBe('refresh-abc');
    expect(loaded?.user?.name).toBe('Test User');
    expect(loaded?.organization?.urlKey).toBe('org');

    // file is not world-readable
    const mode = fs.statSync(LINEAR_AUTH_FILE).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(() => setLinearAuth({})).toThrow();
    expect(clearLinearAuth()).toBe(true);
    expect(getLinearAuth()).toBeNull();
  });

  it('stores personal API key connections with kind api_key', async () => {
    const { getLinearAuth, setLinearAuth } = await import('./auth.js');
    setLinearAuth({ accessToken: 'lin_api_abc123', kind: 'api_key', user: null, organization: null });
    const loaded = getLinearAuth();
    expect(loaded?.kind).toBe('api_key');
    expect(loaded?.refreshToken).toBeNull();
  });
});

describe('automation settings', () => {
  it('defaults to start-transition on and done-transition off', async () => {
    const { getLinearAutomationSettings, setLinearAutomationSettings } = await import('./auth.js');
    expect(getLinearAutomationSettings()).toEqual({
      moveToInProgressOnStart: true,
      moveToDoneOnComplete: false,
    });

    expect(setLinearAutomationSettings({ moveToDoneOnComplete: true })).toEqual({
      moveToInProgressOnStart: true,
      moveToDoneOnComplete: true,
    });
    // partial patches preserve the other toggle
    expect(setLinearAutomationSettings({ moveToInProgressOnStart: false })).toEqual({
      moveToInProgressOnStart: false,
      moveToDoneOnComplete: true,
    });
    expect(getLinearAutomationSettings()).toEqual({
      moveToInProgressOnStart: false,
      moveToDoneOnComplete: true,
    });
  });
});

const createFakeApp = () => {
  const handlers = new Map();
  const register = (method) => (path, handler) => handlers.set(`${method} ${path}`, handler);
  return {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    delete: register('DELETE'),
    handler: (method, path) => handlers.get(`${method} ${path}`),
  };
};

const createFakeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    redirectTo: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(url) { this.redirectTo = url; return this; },
  };
  return res;
};

const graphqlResponse = (data) => ({
  ok: true,
  status: 200,
  json: async () => ({ data }),
});

// Routes GraphQL calls by matching a marker in the query document.
const stubLinearFetch = (table) => vi.fn(async (_url, init) => {
  const body = JSON.parse(init?.body ?? '{}');
  const query = typeof body.query === 'string' ? body.query : '';
  for (const [marker, respond] of table) {
    if (query.includes(marker)) {
      return respond(body.variables ?? {});
    }
  }
  throw new Error(`Unexpected GraphQL query: ${query.slice(0, 80)}`);
});

describe('api key route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates and stores a personal API key', async () => {
    const { registerLinearRoutes } = await import('./routes.js');
    const { getLinearAuth } = await import('./auth.js');
    const app = createFakeApp();
    registerLinearRoutes(app);

    vi.stubGlobal('fetch', stubLinearFetch([
      ['viewer', () => graphqlResponse({
        viewer: {
          id: 'user-1',
          name: 'Api User',
          displayName: 'apiuser',
          email: 'api@example.com',
          avatarUrl: null,
          organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' },
        },
      })],
    ]));

    const res = createFakeRes();
    await app.handler('POST', '/api/linear/auth/apikey')(
      { body: { apiKey: 'lin_api_testkey123' }, headers: {}, query: {} },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.kind).toBe('api_key');
    expect(res.body.user?.name).toBe('Api User');
    expect(res.body.organization?.urlKey).toBe('openchamber');

    const stored = getLinearAuth();
    expect(stored?.accessToken).toBe('lin_api_testkey123');
    expect(stored?.kind).toBe('api_key');

    // malformed keys are rejected without a network call
    const bad = createFakeRes();
    await app.handler('POST', '/api/linear/auth/apikey')({ body: { apiKey: 'nope' }, headers: {}, query: {} }, bad);
    expect(bad.statusCode).toBe(400);
  });

  it('rejects keys Linear does not accept', async () => {
    const { registerLinearRoutes } = await import('./routes.js');
    const { getLinearAuth } = await import('./auth.js');
    const app = createFakeApp();
    registerLinearRoutes(app);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ errors: [{ message: 'Authentication required' }] }),
    })));

    const res = createFakeRes();
    await app.handler('POST', '/api/linear/auth/apikey')(
      { body: { apiKey: 'lin_api_badkey' }, headers: {}, query: {} },
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(getLinearAuth()).toBeNull();
  });
});

describe('session attach route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const issuePayload = (stateType) => ({
    id: 'issue-uuid-1',
    identifier: 'OPE-296',
    title: 'Add Linear integration',
    url: 'https://linear.app/openchamber/issue/OPE-296',
    description: 'desc',
    state: { name: 'Backlog', type: stateType, position: 1 },
    team: { id: 'team-1', key: 'OPE', name: 'Openchamber' },
    assignee: null,
    creator: null,
    labels: { nodes: [] },
    priority: 0,
    estimate: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  });

  const buildFetchTable = ({ stateType, calls }) => [
    ['query OpenChamberIssue(', () => graphqlResponse({ issue: issuePayload(stateType) })],
    ['commentCreate', () => { calls.push('comment'); return graphqlResponse({ commentCreate: { success: true, comment: { id: 'c1' } } }); }],
    ['attachmentCreate', () => { calls.push('attachment'); return graphqlResponse({ attachmentCreate: { success: true, attachment: { id: 'a1' } } }); }],
    ['OpenChamberTeamStates', () => graphqlResponse({
      team: {
        id: 'team-1',
        states: {
          nodes: [
            { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 1 },
            { id: 'state-progress', name: 'In Progress', type: 'started', position: 2 },
            { id: 'state-done', name: 'Done', type: 'completed', position: 3 },
          ],
        },
      },
    })],
    ['issueUpdate', (variables) => {
      calls.push(`issueUpdate:${variables.stateId}`);
      return graphqlResponse({ issueUpdate: { success: true, issue: { id: 'issue-uuid-1', state: { name: 'In Progress', type: 'started' } } } });
    }],
  ];

  it('moves a backlog issue to In Progress on session start', async () => {
    const { registerLinearRoutes } = await import('./routes.js');
    const { setLinearAuth, setLinearAutomationSettings } = await import('./auth.js');
    setLinearAuth({ accessToken: 'token', user: null, organization: null });
    setLinearAutomationSettings({ moveToInProgressOnStart: true, moveToDoneOnComplete: false });

    const calls = [];
    vi.stubGlobal('fetch', stubLinearFetch(buildFetchTable({ stateType: 'backlog', calls })));

    const app = createFakeApp();
    registerLinearRoutes(app);
    const res = createFakeRes();
    await app.handler('POST', '/api/linear/sessions')(
      {
        body: { issue: 'OPE-296', session: { id: 'sess-1', title: 'OPE-296 work', url: 'http://localhost:4096/?session=sess-1' } },
        headers: { host: 'localhost:4096' },
        query: {},
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.link.issueId).toBe('issue-uuid-1');
    expect(res.body.link.teamId).toBe('team-1');
    expect(res.body.commentPosted).toBe(true);
    expect(res.body.attachmentPosted).toBe(true);
    expect(res.body.stateChanged).toBe(true);
    expect(res.body.stateName).toBe('In Progress');
    expect(calls).toContain('issueUpdate:state-progress');
  });

  it('does not touch the state of an already-started issue', async () => {
    const { registerLinearRoutes } = await import('./routes.js');
    const { setLinearAuth, setLinearAutomationSettings } = await import('./auth.js');
    setLinearAuth({ accessToken: 'token', user: null, organization: null });
    setLinearAutomationSettings({ moveToInProgressOnStart: true, moveToDoneOnComplete: false });

    const calls = [];
    vi.stubGlobal('fetch', stubLinearFetch(buildFetchTable({ stateType: 'started', calls })));

    const app = createFakeApp();
    registerLinearRoutes(app);
    const res = createFakeRes();
    await app.handler('POST', '/api/linear/sessions')(
      {
        body: { issue: 'OPE-296', session: { id: 'sess-2', title: 'work', url: '/?session=sess-2' } },
        headers: { host: 'localhost:4096' },
        query: {},
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.stateChanged).toBe(false);
    expect(calls.filter((c) => c.startsWith('issueUpdate'))).toHaveLength(0);
  });
});

describe('session links store', () => {
  it('adds, lists, updates, and replaces links per session', async () => {
    const { addSessionLink, getSessionLink, listSessionLinks, updateSessionLink } = await import('./links.js');

    const link = addSessionLink({
      issueId: 'issue-1',
      issueIdentifier: 'OPE-296',
      issueTitle: 'Add Linear integration',
      issueUrl: 'https://linear.app/openchamber/issue/OPE-296',
      sessionId: 'session-1',
      directory: '/tmp/project',
      sessionTitle: 'OPE-296 Add Linear integration',
      sessionUrl: 'http://localhost:3001/?session=session-1',
    });
    expect(link.status).toBe('started');

    expect(listSessionLinks({ issueId: 'issue-1' })).toHaveLength(1);
    expect(listSessionLinks({ sessionId: 'session-1' })).toHaveLength(1);
    expect(listSessionLinks()).toHaveLength(1);

    const updated = updateSessionLink('session-1', {
      status: 'completed',
      notifiedStatuses: ['started', 'completed'],
    });
    expect(updated?.status).toBe('completed');
    expect(updated?.notifiedStatuses).toEqual(['started', 'completed']);

    // re-attaching the same session replaces the record
    addSessionLink({ ...link, sessionTitle: 'renamed' });
    expect(listSessionLinks()).toHaveLength(1);
    expect(getSessionLink('session-1')?.sessionTitle).toBe('renamed');

    expect(() => addSessionLink({ issueId: '', sessionId: '' })).toThrow();
  });
});

describe('status tracker', () => {
  it('maps OpenCode events to lifecycle statuses', async () => {
    const { mapPayloadToStatus } = await import('./tracker.js');

    expect(mapPayloadToStatus({ type: 'session.idle', properties: { sessionID: 's1' } }))
      .toEqual({ sessionId: 's1', status: 'completed' });
    expect(mapPayloadToStatus({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } }))
      .toEqual({ sessionId: 's1', status: 'completed' });
    expect(mapPayloadToStatus({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } }))
      .toBeNull();
    expect(mapPayloadToStatus({ type: 'session.error', properties: { sessionID: 's1' } }))
      .toEqual({ sessionId: 's1', status: 'error' });
    expect(mapPayloadToStatus({ type: 'permission.asked', properties: { sessionID: 's1' } }))
      .toEqual({ sessionId: 's1', status: 'attention' });
    expect(mapPayloadToStatus({ type: 'message.updated', properties: {} })).toBeNull();
    expect(mapPayloadToStatus(null)).toBeNull();
  });

  it('posts each status once and stops after a terminal status', async () => {
    const { addSessionLink } = await import('./links.js');
    const { setLinearAuth } = await import('./auth.js');
    const { createLinearStatusTracker } = await import('./tracker.js');

    setLinearAuth({ accessToken: 'token', user: null, organization: null });
    addSessionLink({
      issueId: 'issue-1',
      issueIdentifier: 'OPE-296',
      sessionId: 'session-1',
      sessionTitle: 'OPE-296 work',
      sessionUrl: 'http://localhost:3001/?session=session-1',
    });

    const posted = [];
    const tracker = createLinearStatusTracker({
      postComment: async ({ issueId, body }) => {
        posted.push({ issueId, body });
        return { success: true };
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    // attention first, then duplicate attention is suppressed
    tracker.processPayload({ type: 'permission.asked', properties: { sessionID: 'session-1' } });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    tracker.processPayload({ type: 'permission.asked', properties: { sessionID: 'session-1' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain('needs attention');
    expect(posted[0].body).toContain('http://localhost:3001/?session=session-1');

    // completion posts, then further events are suppressed (terminal)
    tracker.processPayload({ type: 'session.idle', properties: { sessionID: 'session-1' } });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].body).toContain('completed');
    tracker.processPayload({ type: 'session.error', properties: { sessionID: 'session-1' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toHaveLength(2);

    // unlinked sessions never post
    tracker.processPayload({ type: 'session.idle', properties: { sessionID: 'other' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toHaveLength(2);
  });

  it('serializes concurrent notifications for the same session (no double-post)', async () => {
    const { addSessionLink } = await import('./links.js');
    const { setLinearAuth } = await import('./auth.js');
    const { createLinearStatusTracker } = await import('./tracker.js');

    setLinearAuth({ accessToken: 'token', user: null, organization: null });
    addSessionLink({
      issueId: 'issue-1',
      issueIdentifier: 'OPE-296',
      sessionId: 'session-race',
      sessionTitle: 'race',
      sessionUrl: '',
    });

    const posted = [];
    const tracker = createLinearStatusTracker({
      postComment: async ({ body }) => {
        // Delay the Linear round-trip so the second notification starts while
        // the first is still in flight (the session.idle + session.status
        // double-emission race).
        await new Promise((resolve) => setTimeout(resolve, 25));
        posted.push(body);
        return { success: true };
      },
      logger: { warn: vi.fn() },
    });

    tracker.processPayload({ type: 'session.idle', properties: { sessionID: 'session-race' } });
    tracker.processPayload({ type: 'session.status', properties: { sessionID: 'session-race', status: { type: 'idle' } } });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    // Give a hypothetical second post time to land — it must not arrive.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(1);
  });

  it('does not notify when Linear is disconnected', async () => {
    const { addSessionLink } = await import('./links.js');
    const { createLinearStatusTracker } = await import('./tracker.js');

    addSessionLink({
      issueId: 'issue-1',
      sessionId: 'session-1',
      sessionTitle: 'work',
      sessionUrl: '',
    });

    const postComment = vi.fn();
    const tracker = createLinearStatusTracker({ postComment, logger: { warn: vi.fn() } });
    const result = await tracker.notifyStatus('session-1', 'completed');
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('not-connected');
    expect(postComment).not.toHaveBeenCalled();
  });

  it('moves the issue to Done on completion only when enabled', async () => {
    const { addSessionLink } = await import('./links.js');
    const { setLinearAuth, setLinearAutomationSettings } = await import('./auth.js');
    const { createLinearStatusTracker } = await import('./tracker.js');

    setLinearAuth({ accessToken: 'token', user: null, organization: null });
    addSessionLink({
      issueId: 'issue-1',
      teamId: 'team-1',
      sessionId: 'session-1',
      sessionTitle: 'work',
      sessionUrl: '',
    });

    const postComment = vi.fn(async () => ({ success: true }));
    const moveIssue = vi.fn(async () => ({ changed: true, stateName: 'Done' }));
    const tracker = createLinearStatusTracker({ postComment, moveIssue, logger: { warn: vi.fn() } });

    // default: disabled → no state transition
    setLinearAutomationSettings({ moveToDoneOnComplete: false });
    await tracker.notifyStatus('session-1', 'completed');
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(moveIssue).not.toHaveBeenCalled();

    // enabled → moves to the team's completed state after the comment
    const { addSessionLink: addAgain } = await import('./links.js');
    addAgain({ issueId: 'issue-1', teamId: 'team-1', sessionId: 'session-2', sessionTitle: 'w2', sessionUrl: '' });
    setLinearAutomationSettings({ moveToDoneOnComplete: true });
    await tracker.notifyStatus('session-2', 'completed');
    expect(moveIssue).toHaveBeenCalledWith({ issueId: 'issue-1', teamId: 'team-1', stateType: 'completed' });

    // non-completed statuses never move the issue
    const { addSessionLink: addThird } = await import('./links.js');
    addThird({ issueId: 'issue-1', teamId: 'team-1', sessionId: 'session-3', sessionTitle: 'w3', sessionUrl: '' });
    moveIssue.mockClear();
    await tracker.notifyStatus('session-3', 'attention');
    expect(moveIssue).not.toHaveBeenCalled();
  });
});
