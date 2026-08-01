import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const harnessPromptCalls = [];
const harnessPromptMock = mock(async (params) => {
  harnessPromptCalls.push(params);
  return { ok: true, status: 'started' };
});

class HarnessClientError extends Error {
  constructor(message, code, statusCode = 500, status) {
    super(message);
    this.name = 'HarnessClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = status;
  }
}

// `mock.module` is global to the run, so a partial mock would strip the real
// module's other exports for every test file that loads after this one.
const actualClient = await import('@/lib/harness/client');

mock.module('@/lib/harness/client', () => ({
  ...actualClient,
  HarnessClientError,
  harnessPrompt: harnessPromptMock,
  harnessAbort: mock(async () => ({ ok: true })),
  harnessPermissionReply: mock(async () => ({ ok: true })),
  harnessSessionCapabilities: mock(async (sessionId) => ({
    sessionId,
    harnessId: 'claude-code',
    capabilities: {
      sessionId,
      slashCommands: ['compact', 'usage', 'clear'],
      skills: [],
      agents: [],
      tools: [],
      mcpServers: [],
      updatedAt: 0,
    },
  })),
  buildHarnessPromptBody: (params) => params,
}));

// Same reasoning as the client mock above: spread the real module so other
// exports (extractLastAssistantText, clearPendingHandoffTarget, etc.) survive
// for every test file loaded after this one.
const actualSessionHandoff = await import('@/lib/harness/session-handoff');
let handoffSessionResult = null;
const createHarnessHandoffSessionMock = mock(async () => handoffSessionResult);

mock.module('@/lib/harness/session-handoff', () => ({
  ...actualSessionHandoff,
  createHarnessHandoffSession: createHarnessHandoffSessionMock,
}));

const { opencodeClient } = await import('@/lib/opencode/client');
const { routeMessage, useSessionUIStore } = await import(`./session-ui-store?harness-route=${Date.now()}`);
const { setActionRefs, setOptimisticRefs } = await import('./session-actions');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSelectionStore } = await import('./selection-store');
const { useHarnessStore } = await import('@/stores/useHarnessStore');
const { useCommandsStore } = await import('@/stores/useCommandsStore');
const { useSkillsStore } = await import('@/stores/useSkillsStore');
const { setCachedClaudeAgentsMode } = await import('@/lib/harness/settings');
const { useClaudeAgentsStore } = await import('@/stores/useClaudeAgentsStore');

const DIRECTORY = '/claude/project';

const CLAUDE_ENGINE = {
  id: 'claude-code',
  displayName: 'Claude Code',
  shortName: 'Claude',
  auth: { mode: 'subscription-cli' },
  capabilities: {},
  install: { binaryNames: ['claude'], docsUrl: 'https://example.com' },
};

const READY_SECTIONS = [
  { id: 'models', name: 'Models', kind: 'models', models: [{ id: 'sonnet', name: 'Sonnet' }] },
];

function setClaudeCatalog(status, sections) {
  useHarnessStore.setState({
    catalogsById: { 'claude-code': { engine: CLAUDE_ENGINE, status, sections } },
    loadState: 'ready',
    error: null,
  });
}

function selectClaude(sessionId, overrides = {}) {
  useSelectionStore.getState().saveSessionTarget(sessionId, {
    harnessId: 'claude-code',
    modelRef: 'sonnet',
    ...overrides,
  });
}

function route(overrides) {
  return routeMessage({
    directory: DIRECTORY,
    providerID: 'anthropic',
    modelID: 'claude-sonnet',
    ...overrides,
  });
}

describe('routeMessage Claude harness branch', () => {
  const sendMessageCalls = [];
  const shellSessionCalls = [];
  let originalSendMessage;
  let originalShellSession;

  beforeEach(() => {
    harnessPromptCalls.length = 0;
    sendMessageCalls.length = 0;
    shellSessionCalls.length = 0;
    harnessPromptMock.mockClear();
    setCachedClaudeAgentsMode('opencode');

    const childStore = {
      getState: () => ({
        session: [],
        message: {},
        part: {},
        session_status: {},
      }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => DIRECTORY);
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true });
    useCommandsStore.setState({ commands: [] });
    useSkillsStore.setState({ skills: [] });
    useSelectionStore.setState({
      sessionTargets: new Map(),
      lastUsedTarget: null,
    });
    setClaudeCatalog('ready', READY_SECTIONS);

    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendMessage = async (params) => {
      sendMessageCalls.push(params);
      return 'msg';
    };
    originalShellSession = opencodeClient.shellSession;
    opencodeClient.shellSession = async (params) => {
      shellSessionCalls.push(params);
      return { info: {}, parts: [] };
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
    opencodeClient.shellSession = originalShellSession;
    useSelectionStore.setState({
      sessionTargets: new Map(),
      lastUsedTarget: null,
    });
  });

  test('routes Claude targets through harnessPrompt and skips OpenCode sendMessage', async () => {
    selectClaude('session-claude');

    await route({
      sessionId: 'session-claude',
      content: 'hello claude',
      files: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,x', filename: 'a.png' }],
    });

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].sessionId).toBe('session-claude');
    expect(harnessPromptCalls[0].directory).toBe(DIRECTORY);
    expect(harnessPromptCalls[0].target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'sonnet',
      permissionMode: 'default',
    });
    expect(harnessPromptCalls[0].agentsMode).toBe('opencode');
    expect(harnessPromptCalls[0].text).toBe('hello claude');
    expect(harnessPromptCalls[0].files).toEqual([{ mime: 'image/png', url: 'data:image/png;base64,x', filename: 'a.png' }]);
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('claude agents mode omits OpenCode-derived permissionMode', async () => {
    setCachedClaudeAgentsMode('claude');
    selectClaude('session-claude-native', { modelRef: 'opus', permissionMode: 'acceptEdits' });

    await route({
      sessionId: 'session-claude-native',
      content: 'native agents',
      modelID: 'claude-opus',
      agent: 'build',
    });

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].agentsMode).toBe('claude');
    expect(harnessPromptCalls[0].target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'opus',
    });
    expect(harnessPromptCalls[0].systemPromptAppend).toBeUndefined();
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('opencode agents mode sends the agent name for server-side resolution', async () => {
    selectClaude('session-agent-name');

    await route({ sessionId: 'session-agent-name', content: 'inherit build', agent: 'build' });

    expect(harnessPromptCalls).toHaveLength(1);
    // The server re-reads this agent's prompt + permission ruleset from
    // OpenCode; without the name it can inherit nothing.
    expect(harnessPromptCalls[0].agent).toBe('build');
    expect(harnessPromptCalls[0].claudeAgent).toBeUndefined();
  });

  test('an explicit Claude executionTarget still inherits the OpenCode agent', async () => {
    // Shape used by a harness handoff and by MultiRun: the target is supplied
    // directly instead of being resolved from the session. Both used to drop
    // the agent name for Claude, which left the turn inheriting nothing.
    await route({
      sessionId: 'session-handoff-claude',
      content: 'seeded turn',
      agent: 'build',
      executionTarget: { harnessId: 'claude-code', modelRef: 'sonnet' },
      seedFromSessionId: 'session-source',
    });

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].agent).toBe('build');
    expect(harnessPromptCalls[0].agentsMode).toBe('opencode');
    expect(harnessPromptCalls[0].seedFromSessionId).toBe('session-source');
  });

  test('claude agents mode sends the native Claude agent and no OpenCode agent', async () => {
    setCachedClaudeAgentsMode('claude');
    useClaudeAgentsStore.getState().select('session-claude-agent', 'Explore');
    selectClaude('session-claude-agent');

    await route({ sessionId: 'session-claude-agent', content: 'native agent', agent: 'build' });

    expect(harnessPromptCalls).toHaveLength(1);
    // Selection comes from the session-scoped store, so a queued follow-up
    // still sends the agent this session was configured with.
    expect(harnessPromptCalls[0].claudeAgent).toBe('Explore');
    expect(harnessPromptCalls[0].agent).toBeUndefined();
  });

  test('claude agents mode sends no agent when the session picked Claude default', async () => {
    setCachedClaudeAgentsMode('claude');
    selectClaude('session-claude-default');

    await route({ sessionId: 'session-claude-default', content: 'default agent' });

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].claudeAgent).toBeUndefined();
    expect(harnessPromptCalls[0].agent).toBeUndefined();
  });

  test('routes shell mode through OpenCode session.shell on Claude sessions', async () => {
    selectClaude('session-claude');

    await route({
      sessionId: 'session-claude',
      content: 'ls',
      agent: 'build',
      inputMode: 'shell',
    });

    expect(shellSessionCalls).toHaveLength(1);
    expect(shellSessionCalls[0]).toEqual({
      sessionId: 'session-claude',
      directory: DIRECTORY,
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      command: 'ls',
    });
    expect(harnessPromptCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('keeps OpenCode path when session target is opencode', async () => {
    useSelectionStore.getState().saveSessionTarget('session-oc', {
      harnessId: 'opencode',
      providerId: 'provider-a',
      modelId: 'model-a',
    });

    await route({
      sessionId: 'session-oc',
      content: 'hello opencode',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(harnessPromptCalls).toHaveLength(0);
  });

  test('blocks Claude send when engine is not ready', async () => {
    selectClaude('session-claude');
    setClaudeCatalog('needs-login', []);

    let caught = null;
    try {
      await route({ sessionId: 'session-claude', content: 'hello' });
    } catch (error) {
      caught = error;
    }

    expect(caught?.code).toBe('CLAUDE_NOT_READY');
    expect(harnessPromptCalls).toHaveLength(0);
  });

  // Claude-native and unknown slash tokens both travel as literal prompt text.
  const literalPromptCases = [
    ['routes Claude-native /compact through harnessPrompt', '/compact'],
    ['leaves unknown slash tokens as literal harness prompt text', '/not-a-known-command'],
  ];

  for (const [name, content] of literalPromptCases) {
    test(name, async () => {
      selectClaude('session-claude');

      await route({ sessionId: 'session-claude', content });

      expect(harnessPromptCalls).toHaveLength(1);
      expect(harnessPromptCalls[0].command).toBeUndefined();
      expect(harnessPromptCalls[0].text).toBe(content);
      expect(sendMessageCalls).toHaveLength(0);
    });
  }

  const commandTranslationCases = [
    {
      name: 'translates OpenCode commands into a harness command payload',
      content: '/pr-review 2480 extra',
      command: { name: 'pr-review', arguments: '2480 extra' },
      text: '',
    },
    {
      // Typing the URL on its own line is the normal way to pass a long
      // argument. Splitting the name on " " alone swallowed the whole message
      // into the command name, so nothing matched and Claude received literal
      // text.
      name: 'translates a command whose argument is on the next line',
      content: '/pr-review\nhttps://github.com/openchamber/openchamber/pull/2513',
      command: {
        name: 'pr-review',
        arguments: 'https://github.com/openchamber/openchamber/pull/2513',
      },
      text: '',
    },
    {
      name: 'keeps queued follow-up text alongside a translated command',
      content: '/pr-review 2480',
      additionalParts: [{ text: 'also check the tests' }],
      command: { name: 'pr-review', arguments: '2480' },
      text: 'also check the tests',
    },
  ];

  for (const testCase of commandTranslationCases) {
    test(testCase.name, async () => {
      selectClaude('session-claude');
      useCommandsStore.setState({
        commands: [{ name: 'pr-review', description: 'oc', scope: 'global' }],
      });

      await route({
        sessionId: 'session-claude',
        content: testCase.content,
        additionalParts: testCase.additionalParts,
      });

      expect(harnessPromptCalls).toHaveLength(1);
      // The server owns expansion, so the literal "/name args" line never
      // travels as prompt text — only the command reference does.
      expect(harnessPromptCalls[0].command).toEqual(testCase.command);
      expect(harnessPromptCalls[0].text).toBe(testCase.text);
      expect(sendMessageCalls).toHaveLength(0);
    });
  }

  test('sendMessage handoff to Claude still sends the agent name for server-side resolution', async () => {
    // Regression: the handoff branch in session-ui-store's sendMessage used to
    // gate the agent name on the DESTINATION harness (`agent: pendingHandoff
    // .harnessId === "opencode" ? effectiveAgent : undefined`), so a handoff
    // from OpenCode to Claude Code dropped the agent name and the first turn
    // after the handoff inherited nothing (asked for every tool).
    handoffSessionResult = {
      sessionId: 'session-handoff-dest',
      directory: DIRECTORY,
      seed: { text: '', omittedTurns: 0, includedTurns: 0 },
    };

    useSelectionStore.getState().saveSessionTarget('session-handoff-source', {
      harnessId: 'opencode',
      providerId: 'provider-a',
      modelId: 'model-a',
    });
    useSelectionStore.getState().setPendingHandoffTarget('session-handoff-source', {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
    });

    await useSessionUIStore.getState().sendMessage(
      'seeded turn',
      'provider-a',
      'model-a',
      'build',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { sessionId: 'session-handoff-source', directory: DIRECTORY },
    );

    expect(harnessPromptCalls).toHaveLength(1);
    expect(harnessPromptCalls[0].agent).toBe('build');
    expect(harnessPromptCalls[0].agentsMode).toBe('opencode');
    expect(harnessPromptCalls[0].target.harnessId).toBe('claude-code');
  });
});
