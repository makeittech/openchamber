import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHarnessRoutes } from './routes.js';
import { createHarnessRouter } from './router.js';
import {
  bindSession,
  configureSessionBindings,
  getSessionBinding,
  resetSessionBindings,
} from './session-bindings.js';
import {
  createCanUseTool,
  replyPermission,
  resetPendingPermissions,
} from './translators/claude-code/permissions.js';
import {
  createAskUserQuestionHandler,
  replyQuestion,
  resetPendingQuestions,
} from './translators/claude-code/questions.js';
import { resetClaudeTranscriptCaches } from './translators/claude-code/transcript-messages.js';
import { applyHarnessEventToSnapshot, resetHarnessTurnSnapshots } from './turn-snapshot.js';

beforeAll(() => configureSessionBindings({ persist: false, load: true }));
afterEach(() => {
  resetSessionBindings();
  resetPendingPermissions();
  resetPendingQuestions();
  resetHarnessTurnSnapshots();
  resetClaudeTranscriptCaches();
  configureSessionBindings({ persist: false, load: true });
});async function withServer(register, run) {
  const app = express();
  register(app);
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

const post = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const translator = (overrides = {}) => ({
  prompt: async () => ({ ok: true }),
  abort: async () => ({ ok: true, aborted: false }),
  replyPermission: async () => ({ ok: true }),
  replyQuestion: async () => ({ ok: true }),
  ...overrides,
});

const routerWith = (overrides) => createHarnessRouter({ claudeTranslator: translator(overrides) });

describe('harness routes', () => {
  it('lists catalogs, detects a harness, and rejects unknown ids', async () => {
    const claude = { descriptor: { id: 'claude-code' }, status: 'missing-cli', sections: [] };
    await withServer((app) => registerHarnessRoutes(app, {
      initBindings: false,
      detectAll: async () => [{ descriptor: { id: 'opencode' }, status: 'ready', sections: [] }, claude],
      detectOne: async (id) => (id === 'claude-code' ? claude : null),
    }), async (base) => {
      expect((await (await fetch(`${base}/api/harness`)).json()).catalogs).toHaveLength(2);
      expect((await fetch(`${base}/api/harness/nope`)).status).toBe(404);
      const detected = await post(base, '/api/harness/claude-code/detect');
      expect(detected.status).toBe(200);
      expect((await detected.json()).status).toBe('missing-cli');
    });
  });

  it('starts, exposes, and aborts a sticky Claude binding', async () => {
    const router = routerWith({
      prompt: async (body) => {
        bindSession({
          sessionId: body.sessionId,
          harnessId: 'claude-code',
          directory: body.directory,
          target: body.target,
        });
        return { ok: true, sessionId: body.sessionId, harnessId: 'claude-code', status: 'started' };
      },
    });
    await withServer((app) => registerHarnessRoutes(app, { router, initBindings: false }), async (base) => {
      const response = await post(base, '/api/harness/prompt', {
        sessionId: 'ses_test',
        directory: '/tmp/project',
        target: { harnessId: 'claude-code', modelRef: 'sonnet' },
        text: 'hello',
      });
      expect(response.status).toBe(202);
      expect(getSessionBinding('ses_test')?.harnessId).toBe('claude-code');
      expect((await (await fetch(`${base}/api/harness/sessions/ses_test`)).json()).binding.harnessId)
        .toBe('claude-code');
      expect((await post(base, '/api/harness/abort', { sessionId: 'ses_test' })).status).toBe(200);
    });
  });

  it('preserves router failure status, code, and harness status', async () => {
    const router = routerWith({
      prompt: async () => {
        const error = new Error('Claude Code is not ready (missing-cli)');
        error.code = 'CLAUDE_MISSING_CLI';
        error.statusCode = 503;
        error.status = 'missing-cli';
        throw error;
      },
    });
    await withServer((app) => registerHarnessRoutes(app, { router, initBindings: false }), async (base) => {
      const response = await post(base, '/api/harness/prompt', { target: { harnessId: 'claude-code' } });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'CLAUDE_MISSING_CLI', status: 'missing-cli' });
    });
  });

  it('resolves a bridged question', async () => {
    const events = [];
    createAskUserQuestionHandler({
      sessionId: 'ses_q',
      directory: '/tmp/project',
      getBroadcast: () => (event) => events.push(event),
      createId: () => 'qst_route',
    })({
      questions: [{
        question: 'Pick one',
        header: 'Choice',
        options: [{ label: 'A', description: 'Option A' }],
        multiSelect: false,
      }],
    }, {});
    await withServer((app) => registerHarnessRoutes(app, {
      router: routerWith({ replyQuestion }),
      initBindings: false,
    }), async (base) => {
      const response = await post(base, '/api/harness/question/reply', {
        sessionId: 'ses_q', requestId: 'qst_route', answers: [['A']], directory: '/tmp/project',
      });
      expect(await response.json()).toMatchObject({ ok: true, sessionId: 'ses_q', requestId: 'qst_route' });
      expect(events.map(({ type }) => type)).toContain('question.replied');
    });
  });

  it('resolves a bridged permission and its pending tool decision', async () => {
    const events = [];
    const canUseTool = createCanUseTool({
      sessionId: 'ses_p',
      directory: '/tmp/project',
      getBroadcast: () => (event) => events.push(event),
      createId: () => 'perm_route',
    });
    const pending = canUseTool('Bash', { command: 'ls' }, {});
    pending.catch(() => {});
    await withServer((app) => registerHarnessRoutes(app, {
      router: routerWith({ replyPermission }),
      initBindings: false,
    }), async (base) => {
      const response = await post(base, '/api/harness/permission/reply', {
        sessionId: 'ses_p', requestId: 'perm_route', reply: 'once', directory: '/tmp/project',
      });
      expect(await response.json()).toMatchObject({
        ok: true, sessionId: 'ses_p', requestId: 'perm_route', reply: 'once',
      });
      expect(events.map(({ type }) => type)).toContain('permission.replied');
      expect(await pending).toMatchObject({ behavior: 'allow' });
    });
  });

  it('returns the permission bridge error for an unknown request', async () => {
    await withServer((app) => registerHarnessRoutes(app, {
      router: routerWith({ replyPermission }),
      initBindings: false,
    }), async (base) => {
      const response = await post(base, '/api/harness/permission/reply', {
        sessionId: 'ses_p', requestId: 'missing', reply: 'once',
      });
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('PERMISSION_NOT_FOUND');
    });
  });
});

describe('OpenCode overlay routes', () => {
  const upstreamHost = '127.0.0.1:1';
  const registerOverlay = (app) => {
    registerHarnessRoutes(app, {
      initBindings: false,
      detectAll: async () => [],
      detectOne: async () => null,
      buildOpenCodeUrl: (route) => `http://${upstreamHost}/${route.replace(/^\//, '')}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    app.use((_req, res) => res.status(599).json({ fellThrough: true }));
  };

  async function withUpstream(implementation, run) {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      return url.includes(upstreamHost) ? implementation(input, init) : original(input, init);
    };
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  }

  // Point CLAUDE_CONFIG_DIR at an isolated (usually empty) tree so transcript
  // lookups never scan the developer's real ~/.claude.
  async function withClaudeConfigDir(seed, run) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-routes-ccd-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpRoot;
    resetClaudeTranscriptCaches();
    try {
      if (seed) {
        seed(tmpRoot);
      }
      await run();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      resetClaudeTranscriptCaches();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it('overlays complete retry status over upstream idle', async () => {
    applyHarnessEventToSnapshot({
      type: 'session.status',
      properties: {
        sessionID: 'ses_retry',
        status: { type: 'retry', attempt: 4, message: 'claude-session-limit', next: 4567 },
      },
    }, '/proj');
    await withServer(registerOverlay, async (base) => withUpstream(
      async () => Response.json({ ses_retry: { type: 'idle' } }),
      async () => expect(await (await fetch(`${base}/api/session/status?directory=/proj`)).json()).toEqual({
        ses_retry: { type: 'retry', attempt: 4, message: 'claude-session-limit', next: 4567 },
      }),
    ));
  });

  const failures = [
    ['non-OK upstream response', '/api/session/status?directory=/proj', async () => new Response('nope', { status: 502 })],
    ['thrown upstream request', '/api/session/ses_1/message', async () => { throw new Error('refused'); }],
    ['invalid upstream JSON', '/api/session/ses_1/message', async () => new Response('<html>')],
  ];
  for (const [name, route, implementation] of failures) {
    it(`falls through after ${name}`, async () => {
      await withServer(registerOverlay, async (base) => withUpstream(implementation, async () => {
        expect((await fetch(`${base}${route}`)).status).toBe(599);
      }));
    });
  }

  it('serves a harness message overlay when upstream fails', async () => {
    bindSession({
      sessionId: 'ses_live',
      harnessId: 'claude-code',
      directory: '/proj',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: { info: { id: 'msg_live', sessionID: 'ses_live', role: 'assistant' } },
    }, '/proj');
    await withClaudeConfigDir(null, async () => {
      await withServer(registerOverlay, async (base) => withUpstream(
        async () => new Response('nope', { status: 502 }),
        async () => {
          const response = await fetch(`${base}/api/session/ses_live/message`);
          expect(response.status).toBe(200);
          expect((await response.json())[0].info.id).toBe('msg_live');
        },
      ));
    });
  });

  it('lets non-Claude sessions fall through to the generic proxy', async () => {
    let upstreamCalled = false;
    await withServer(registerOverlay, async (base) => withUpstream(
      async () => {
        upstreamCalled = true;
        throw new Error('upstream must not be reached');
      },
      async () => {
        const response = await fetch(`${base}/api/session/ses_plain/message?limit=10`);
        expect(response.status).toBe(599);
        expect(upstreamCalled).toBe(false);
      },
    ));
  });

  it('pages merged Claude messages and keeps the pagination cursor', async () => {
    const foreignSessionId = '11111111-1111-4111-8111-111111111111';
    bindSession({
      sessionId: 'ses_page',
      harnessId: 'claude-code',
      directory: '/proj',
      foreignSessionId,
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: { info: { id: 'msg_user', sessionID: 'ses_page', role: 'user' } },
    }, '/proj');
    applyHarnessEventToSnapshot({
      type: 'message.updated',
      properties: { info: { id: 'msg_assistant', sessionID: 'ses_page', role: 'assistant' } },
    }, '/proj');

    const upstreamPage = [
      { info: { id: 'msg_aaa', sessionID: 'ses_page', role: 'user' }, parts: [] },
      { info: { id: 'msg_bbb', sessionID: 'ses_page', role: 'assistant' }, parts: [] },
    ];
    const upstreamQueries = [];
    await withClaudeConfigDir(null, async () => {
      await withServer(registerOverlay, async (base) => withUpstream(
        async (input) => {
          const url = new URL(String(input));
          upstreamQueries.push({
            limit: url.searchParams.get('limit'),
            before: url.searchParams.get('before'),
          });
          return Response.json(upstreamPage);
        },
        async () => {
          const first = await fetch(`${base}/api/session/ses_page/message?limit=2`);
          const firstBody = await first.json();
          expect(upstreamQueries[0]).toEqual({ limit: '2', before: null });
          // merged = [msg_aaa, msg_assistant, msg_bbb, msg_user] (id sort);
          // newest 2 = [msg_bbb, msg_user], cursor = oldest of the page.
          expect(firstBody.map((record) => record.info.id)).toEqual(['msg_bbb', 'msg_user']);
          expect(first.headers.get('x-next-cursor')).toBe('msg_bbb');

          const second = await fetch(`${base}/api/session/ses_page/message?limit=2&before=msg_bbb`);
          const secondBody = await second.json();
          expect(upstreamQueries[1]).toEqual({ limit: '2', before: 'msg_bbb' });
          expect(secondBody.map((record) => record.info.id)).toEqual(['msg_aaa', 'msg_assistant']);
          expect(second.headers.get('x-next-cursor')).toBe('msg_aaa');
        },
      ));
    });
  });

  it('omits the cursor when the full transcript fits one page', async () => {
    const foreignSessionId = '22222222-2222-4222-8222-222222222222';
    const transcriptRecord = (overrides) => JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/proj',
      sessionId: foreignSessionId,
      version: '2.1.220',
      ...overrides,
    });
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-routes-test-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpRoot;
    resetClaudeTranscriptCaches();
    try {
      const projectDir = path.join(tmpRoot, 'projects', '-tmp-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, `${foreignSessionId}.jsonl`), [
        transcriptRecord({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-28T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        }),
        transcriptRecord({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-28T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        }),
      ].join('\n') + '\n');

      bindSession({
        sessionId: 'ses_full',
        harnessId: 'claude-code',
        directory: '/proj',
        foreignSessionId,
        target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      });
      await withServer(registerOverlay, async (base) => withUpstream(
        async () => Response.json([]),
        async () => {
          const response = await fetch(`${base}/api/session/ses_full/message?limit=10`);
          expect(response.status).toBe(200);
          expect(response.headers.get('x-next-cursor')).toBeNull();
          expect((await response.json()).length).toBe(2);
        },
      ));
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      resetClaudeTranscriptCaches();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('Claude import routes', () => {
  it('lists candidates and imports selected sessions', async () => {
    const foreignSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await withServer((app) => registerHarnessRoutes(app, {
      initBindings: false,
      listClaudeImportCandidates: async () => ({ projects: [{ projectKey: '-tmp-app' }] }),
      importClaudeSessions: async ({ sessions }) => ({
        results: [{ ok: true, foreignSessionId, sessionId: 'ses_imported', status: 'imported' }],
        summary: { imported: sessions.length, skipped: 0, failed: 0 },
      }),
    }), async (base) => {
      expect((await (await fetch(`${base}/api/harness/claude-code/import/candidates`)).json()).projects)
        .toHaveLength(1);
      const response = await post(base, '/api/harness/claude-code/import', {
        sessions: [{ foreignSessionId, directory: '/tmp/app', title: 'Hello' }],
      });
      expect(await response.json()).toMatchObject({
        summary: { imported: 1 },
        results: [{ sessionId: 'ses_imported' }],
      });
    });
  });

  it('rejects a missing sessions array', async () => {
    await withServer((app) => registerHarnessRoutes(app, { initBindings: false }), async (base) => {
      const response = await post(base, '/api/harness/claude-code/import', {});
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('IMPORT_INVALID');
    });
  });
});

describe('Claude agents route', () => {
  const empty = { agents: [], roots: { user: null, project: null } };

  for (const [name, suffix, expected] of [
    ['present', `?directory=${encodeURIComponent('/tmp/app')}`, '/tmp/app'],
    ['missing', '', ''],
  ]) {
    it(`forwards a ${name} directory query`, async () => {
      let received;
      await withServer((app) => registerHarnessRoutes(app, {
        initBindings: false,
        listClaudeAgents: async (args) => {
          received = args;
          return empty;
        },
      }), async (base) => {
        expect((await fetch(`${base}/api/harness/claude-code/agents${suffix}`)).status).toBe(200);
        expect(received).toEqual({ directory: expected });
      });
    });
  }

  it('wins route precedence over harness detail detection', async () => {
    let detectCalls = 0;
    const payload = { agents: [{ name: 'planner', source: 'builtin' }], roots: {} };
    await withServer((app) => registerHarnessRoutes(app, {
      initBindings: false,
      listClaudeAgents: async () => payload,
      detectOne: async () => {
        detectCalls += 1;
        return null;
      },
    }), async (base) => {
      expect(await (await fetch(`${base}/api/harness/claude-code/agents`)).json()).toEqual(payload);
      expect(detectCalls).toBe(0);
    });
  });

  it('returns discovery errors with their status and code', async () => {
    await withServer((app) => registerHarnessRoutes(app, {
      initBindings: false,
      listClaudeAgents: async () => {
        const error = new Error('Claude Code is not ready');
        error.code = 'CLAUDE_MISSING_CLI';
        error.statusCode = 503;
        throw error;
      },
    }), async (base) => {
      const response = await fetch(`${base}/api/harness/claude-code/agents`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: 'Claude Code is not ready', code: 'CLAUDE_MISSING_CLI',
      });
    });
  });
});
