import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionTitleRuntime } from './runtime.js';
import { resetClaudeTranscriptCaches } from '../harness/translators/claude-code/transcript-messages.js';

const SESSION_ID = 'ses_claude';
const DIRECTORY = '/workspace';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const originalFetch = globalThis.fetch;

const waitForRuntime = () => new Promise((resolve) => setTimeout(resolve, 20));

const userMessageEvent = (sessionId = SESSION_ID) => ({
  type: 'message.updated',
  properties: {
    info: {
      id: 'msg_user',
      sessionID: sessionId,
      role: 'user',
      time: { created: 1 },
    },
  },
});

const idleEvent = (sessionId = SESSION_ID) => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'idle' }, directory: DIRECTORY },
});

const busyEvent = (sessionId = SESSION_ID) => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'busy' }, directory: DIRECTORY },
});

const createRuntimeHarness = ({
  binding = { harnessId: 'claude-code' },
  session = { id: SESSION_ID, title: 'Untitled Session' },
  messages = [{
    info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user' },
    parts: [{ type: 'text', text: 'Implement OAuth callback handling' }],
  }],
  generatedText = 'OAuth Callback Handling',
} = {}) => {
  const requests = [];
  const fetchImpl = mock(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    requests.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
      return jsonResponse({ ...session, title: JSON.parse(init.body).title });
    }
    if (url.pathname === `/session/${SESSION_ID}`) {
      return jsonResponse(session);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  globalThis.fetch = fetchImpl;

  const service = {
    generateSmallModelText: mock(async () => ({
      text: generatedText,
      providerID: 'provider',
      modelID: 'model',
    })),
  };
  const getSmallModelService = mock(async () => service);
  const getHarnessRecentMessages = mock(() => messages);
  const getSessionBinding = mock(() => binding);
  const runtime = createSessionTitleRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
    getSmallModelService,
    getHarnessRecentMessages,
    getSessionBinding,
    quietMs: 0,
  });

  return {
    runtime,
    requests,
    service,
    getSmallModelService,
    getHarnessRecentMessages,
    getSessionBinding,
  };
};

describe('session title runtime', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it('skips non-claude bindings', async () => {
    const { runtime, getSmallModelService, getSessionBinding } = createRuntimeHarness({
      binding: { harnessId: 'opencode' },
    });

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(getSessionBinding).toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('skips non-default titles', async () => {
    const { runtime, requests, getSmallModelService } = createRuntimeHarness({
      session: { id: SESSION_ID, title: 'Important migration plan' },
    });

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(requests.map((request) => request.method)).toEqual(['GET']);
    expect(getSmallModelService).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('patches title on idle after user message using harness recent messages', async () => {
    const { runtime, requests, service, getHarnessRecentMessages } = createRuntimeHarness();

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(busyEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(getHarnessRecentMessages).toHaveBeenCalledWith(SESSION_ID);
    expect(service.generateSmallModelText).toHaveBeenCalledTimes(1);
    expect(service.generateSmallModelText.mock.calls[0][0].prompt).toContain('Implement OAuth callback handling');
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch.url.searchParams.get('directory')).toBe(DIRECTORY);
    expect(JSON.parse(patch.body)).toEqual({ title: 'OAuth Callback Handling' });
    runtime.stop();
  });

  it('prefers Claude ai-title from the transcript over small-model generation', async () => {
    const foreignId = '123e4567-e89b-42d3-a456-426614174000';
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-test-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpRoot;
    resetClaudeTranscriptCaches();
    try {
      const projectDir = path.join(tmpRoot, 'projects', '-workspace');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, `${foreignId}.jsonl`), [
        JSON.stringify({ type: 'ai-title', aiTitle: 'Claude native session name', sessionId: foreignId }),
      ].join('\n'));

      const { runtime, requests, service, getHarnessRecentMessages } = createRuntimeHarness({
        binding: { harnessId: 'claude-code', foreignSessionId: foreignId },
      });

      runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
      runtime.processHarnessPayload(busyEvent(), DIRECTORY);
      runtime.processHarnessPayload(idleEvent(), DIRECTORY);
      await waitForRuntime();

      expect(service.generateSmallModelText).not.toHaveBeenCalled();
      expect(getHarnessRecentMessages).not.toHaveBeenCalled();
      const patch = requests.find((request) => request.method === 'PATCH');
      expect(patch).toBeDefined();
      expect(JSON.parse(patch.body)).toEqual({ title: 'Claude native session name' });
      runtime.stop();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      resetClaudeTranscriptCaches();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not double-title same session', async () => {
    const { runtime, requests, service } = createRuntimeHarness();

    runtime.processHarnessPayload(userMessageEvent(), DIRECTORY);
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();
    runtime.processHarnessPayload(idleEvent(), DIRECTORY);
    await waitForRuntime();

    expect(service.generateSmallModelText).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    runtime.stop();
  });
});
