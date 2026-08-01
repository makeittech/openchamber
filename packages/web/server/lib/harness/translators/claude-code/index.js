import { mapAttachmentsToContentBlocks } from './attachments.js';
import { startClaudeQuery } from './query.js';
import {
  buildClaudeMcpServersFromOpenChamber,
  buildMcpAllowedToolPatterns,
} from './mcp-config.js';
import {
  createCanUseTool,
  rejectPendingForSession as rejectPendingPermissions,
  replyPermission as replyPendingPermission,
} from './permissions.js';
import {
  rejectPendingForSession as rejectPendingQuestions,
  replyQuestion as replyPendingQuestion,
} from './questions.js';
import { normalizeOpenCodeCommandRequest } from './opencode-command.js';
import { claudePermissionModeFromEditAction } from './opencode-agents.js';
import { listClaudeAgents } from './claude-agents.js';
import {
  buildTurnAbortEvents,
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
  mapClaudeMessageToEvents,
} from '../../events/from-claude.js';
import { emitHarnessEvents } from '../../events/emit.js';
import {
  bindSession,
  getSessionBinding,
  setBindingError,
  setForeignSessionId,
  updateSessionBinding,
  clearSessionBinding,
} from '../../session-bindings.js';
import { getHarnessCapabilities } from '../../registry.js';
import { detectClaudeCode } from '../../detect.js';
import { clearSessionCapabilities, updateSessionCapabilities } from '../../session-capabilities.js';
import { clearHarnessTurnSnapshot } from '../../turn-snapshot.js';
import { createHarnessRetryRuntime } from '../../retry-runtime.js';
import {
  initPendingRetryStore,
  getPendingRetry,
  listPendingRetries,
  putPendingRetry,
  deletePendingRetry,
} from '../../pending-retry-store.js';
import {
  buildRecoveryUserMessage,
  createRecoveryToolGuard,
  inspectRecoveryTranscript,
} from './recovery-transcript.js';
import { getClaudeTranscriptMessages } from './transcript-messages.js';

const ABORT_INTERRUPT_TIMEOUT_MS = 2_000;

const DETECT_STATUS_ERROR_CODES = new Map([
  ['missing-cli', 'CLAUDE_MISSING_CLI'],
  ['needs-login', 'CLAUDE_NEEDS_LOGIN'],
]);

/** @type {<T>(value: unknown, fallback?: T) => string | T} */
const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
/** @type {<T>(value: unknown, fallback: T) => Function | T} */
const asFunction = (value, fallback) => (typeof value === 'function' ? value : fallback);

function warnHarness(label, error) {
  console.warn(`[harness/claude-code] ${label}`, error instanceof Error ? error.message : error);
}

function isIdleStatusEvent(event, sessionId) {
  return event?.type === 'session.status'
    && event.properties?.sessionID === sessionId
    && event.properties?.status?.type === 'idle';
}

async function interruptWithTimeout(handle, timeoutMs = ABORT_INTERRUPT_TIMEOUT_MS) {
  if (typeof handle?.interrupt !== 'function') return;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => handle.interrupt()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function httpError(message, code, statusCode, properties = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...properties });
}

function idleEvent(sessionId) {
  return {
    type: 'session.status',
    properties: { sessionID: sessionId, status: { type: 'idle' } },
  };
}

function abortedMessageEvent(sessionId, target) {
  return {
    type: 'message.updated',
    properties: { info: {
      id: createOpenCodeId('msg'),
      sessionID: sessionId,
      role: 'assistant',
      time: { created: Date.now(), completed: Date.now() },
      providerID: 'claude-code',
      modelID: target?.modelRef || 'sonnet',
      agent: 'build',
      mode: 'build',
      error: { name: 'MessageAbortedError', data: { message: 'Aborted by user' } },
    } },
  };
}

function rejectPending(sessionId) {
  rejectPendingPermissions(sessionId);
  rejectPendingQuestions(sessionId);
}

export function buildClaudePrompt(text, files, options = {}) {
  const blocks = mapAttachmentsToContentBlocks(files, {
    cwd: asString(options.cwd, undefined),
    preferPathReferences: options.preferPathReferences,
  });
  if (blocks.length === 0) return asString(text);
  const content = [{ type: 'text', text: asString(text) }, ...blocks];
  return (async function* () {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    };
  })();
}

export function createClaudeCodeTranslator(deps = {}) {
  const activeTurns = new Map();
  const getBroadcast = deps.getBroadcast || (() => null);
  const startQuery = deps.startQuery || startClaudeQuery;
  const detect = deps.detect || detectClaudeCode;
  const createOpenChamberMcpServers = deps.createOpenChamberMcpServers || (async () => null);
  const resolveOpenCodeCommand = asFunction(deps.resolveOpenCodeCommand, null);
  const resolveOpenCodeAgents = asFunction(deps.resolveOpenCodeAgents, null);
  const listAgents = asFunction(deps.listClaudeAgents, listClaudeAgents);
  const recoveryContexts = new Map();
  const retryStore = deps.retryStore || {
    init: initPendingRetryStore,
    get: getPendingRetry,
    list: listPendingRetries,
    put: putPendingRetry,
    delete: deletePendingRetry,
  };
  if (!deps.retryRuntime) retryStore.init();
  let retryRuntime = deps.retryRuntime;

  const startPreparedTurn = async (body, internal = null) => {
    const sessionId = asString(body?.sessionId);
    const directory = asString(body?.directory);
    let text = asString(body?.text);
    const commandRequest = normalizeOpenCodeCommandRequest(body?.command);
    const target = body?.target && typeof body.target === 'object' ? body.target : null;
    const harnessId = target?.harnessId || 'claude-code';
    const requestedAgentsMode = body?.agentsMode === 'claude' || body?.agentsMode === 'opencode'
      ? body.agentsMode
      : undefined;

    if (!sessionId || !directory) {
      throw httpError('sessionId and directory are required', 'PROMPT_INVALID', 400);
    }
    if (harnessId !== 'claude-code') {
      const message = `Unsupported harnessId for Claude translator: ${harnessId}`;
      throw httpError(message, 'HARNESS_UNSUPPORTED', 400);
    }

    const detection = await detect();
    if (detection.status !== 'ready') {
      const code = DETECT_STATUS_ERROR_CODES.get(detection.status) || 'CLAUDE_NOT_READY';
      const message = detection.statusDetail || `Claude Code is not ready (${detection.status})`;
      throw httpError(message, code, 503, { status: detection.status });
    }

    const existing = getSessionBinding(sessionId);
    if (existing && existing.harnessId !== 'claude-code') {
      throw httpError(
        'Session is bound to a different engine; create a new session for handoff',
        'BINDING_CONFLICT',
        409,
      );
    }

    if (activeTurns.has(sessionId) || (!internal && retryRuntime?.hasPending(sessionId))) {
      throw httpError('A Claude Code turn is already active for this session', 'TURN_IN_PROGRESS', 409);
    }

    if (commandRequest) {
      if (!resolveOpenCodeCommand) {
        throw httpError(
          'OpenCode command translation is unavailable for this harness runtime',
          'COMMAND_UNAVAILABLE',
          503,
        );
      }
      const translated = await resolveOpenCodeCommand({
        name: commandRequest.name,
        args: commandRequest.args,
        directory,
      });
      text = [translated.text, text.trim()].filter(Boolean).join('\n\n');
    }

    const capabilities = getHarnessCapabilities('claude-code');
    const binding = internal?.binding || bindSession({
      sessionId,
      harnessId: 'claude-code',
      directory,
      target: {
        harnessId: 'claude-code',
        modelRef: asString(target?.modelRef, 'sonnet'),
        permissionMode: target?.permissionMode,
        effort: target?.effort,
      },
      capabilitySnapshot: capabilities,
      seedFromSessionId: asString(body?.seedFromSessionId, undefined),
      agentsMode: requestedAgentsMode,
      agentName: asString(body?.agent, undefined),
      claudeAgentName: asString(body?.claudeAgent, undefined),
    }).binding;

    const userMessageId = asString(body?.messageId) || createOpenCodeId('msg');
    const assistantMessageId = asString(body?.assistantMessageId) || createOpenCodeId('msg');

    const ctx = internal?.ctx || createClaudeMapperContext({
      sessionId,
      directory,
      userMessageId,
      assistantMessageId,
      modelRef: binding.target?.modelRef || 'sonnet',
    });

    const broadcast = getBroadcast();
    const files = internal ? [] : (Array.isArray(body?.files) ? body.files : []);

    let promptInput;
    try {
      promptInput = internal?.promptInput || buildClaudePrompt(text, files, { cwd: directory });
    } catch (error) {
      setBindingError(sessionId, {
        code: error.code || 'ATTACHMENT_ERROR',
        message: error.message || 'Attachment mapping failed',
      });
      throw error;
    }

    if (!internal) emitHarnessEvents(broadcast, directory, buildUserMessageEvents(ctx, text, files));

    const agentsMode = requestedAgentsMode || 'opencode';
    const requestedAgentName = asString(body?.agent).trim();
    const requestedClaudeAgent = agentsMode === 'claude' ? asString(body?.claudeAgent).trim() : '';
    let claudeAgentName = '';
    if (requestedClaudeAgent) {
      try {
        const { agents: knownAgents } = await listAgents({ directory });
        const match = knownAgents.find((entry) => (
          typeof entry?.name === 'string'
          && entry.name.toLowerCase() === requestedClaudeAgent.toLowerCase()
        ));
        if (match) {
          claudeAgentName = match.name;
        } else {
          console.warn(
            `[harness/claude-code] unknown Claude agent "${requestedClaudeAgent}" — running the default main-thread agent`,
          );
        }
      } catch (error) {
        warnHarness('Claude agent discovery failed:', error);
      }
    }

    let inheritance = null;
    if (agentsMode === 'opencode' && resolveOpenCodeAgents) {
      try {
        inheritance = await resolveOpenCodeAgents({ directory, agentName: requestedAgentName });
      } catch (error) {
        warnHarness('OpenCode agent inheritance unavailable:', error);
        inheritance = null;
      }
    }

    const canUseTool = createCanUseTool({
      sessionId,
      directory,
      getBroadcast,
      assistantMessageId,
      ...(inheritance ? {
        resolveToolPolicy: inheritance.resolveToolPolicy,
        policySourceLabel: inheritance.agentName || requestedAgentName,
      } : {}),
    });

    const turnAbort = new AbortController();

    const bridgedMcpServers = buildClaudeMcpServersFromOpenChamber(directory);
    let controlMcpServers = null;
    try {
      controlMcpServers = await createOpenChamberMcpServers({
        contextDirectory: directory,
        signal: turnAbort.signal,
      });
    } catch (error) {
      warnHarness('OpenChamber MCP injection failed:', error);
    }
    const mcpServers = {
      ...bridgedMcpServers,
      ...(controlMcpServers && typeof controlMcpServers === 'object' ? controlMcpServers : {}),
    };
    const allowedTools = buildMcpAllowedToolPatterns(mcpServers);

    const systemPromptAppend = inheritance
      ? inheritance.systemPromptAppend
      : asString(body?.systemPromptAppend).trim();

    let systemPrompt;
    if (agentsMode === 'opencode' && systemPromptAppend) {
      systemPrompt = { type: 'preset', preset: 'claude_code', append: systemPromptAppend };
    }

    const agentDefinitions = agentsMode === 'opencode' && inheritance
      ? inheritance.agentDefinitions
      : null;

    let permissionMode;
    if (agentsMode === 'opencode') {
      permissionMode = inheritance
        ? claudePermissionModeFromEditAction(inheritance.resolveToolPolicy('Edit', {}))
        : binding.target?.permissionMode;
    }

    let handle;
    try {
      handle = await startQuery({
        prompt: promptInput,
        cwd: directory,
        model: binding.target?.modelRef,
        resume: binding.foreignSessionId,
        permissionMode,
        effort: binding.target?.effort,
        systemPrompt,
        canUseTool,
        includePartialMessages: true,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(agentDefinitions && Object.keys(agentDefinitions).length > 0
          ? { agents: agentDefinitions }
          : {}),
        ...(claudeAgentName ? { agent: claudeAgentName } : {}),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        skills: 'all',
        settingSources: ['user', 'project', 'local'],
        forwardSubagentText: true,
        agentProgressSummaries: true,
        ...(internal?.toolGuard ? {
          hooks: { PreToolUse: [{ hooks: [internal.toolGuard] }] },
        } : {}),
      });
    } catch (error) {
      turnAbort.abort();
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (!wrapped.code) wrapped.code = 'CLAUDE_SDK_UNAVAILABLE';
      if (!wrapped.statusCode) wrapped.statusCode = 503;
      setBindingError(sessionId, { code: wrapped.code, message: wrapped.message });
      if (!internal) emitHarnessEvents(broadcast, directory, [idleEvent(sessionId)]);
      throw wrapped;
    }

    const activeTurn = {
      handle,
      ctx,
      aborting: false,
      idleEmitted: false,
      turnAbort,
      recovery: Boolean(internal),
    };
    activeTurns.set(sessionId, activeTurn);
    const emitEvents = (events) => {
      const ownedEvents = internal
        ? events.filter((event) => !isIdleStatusEvent(event, sessionId))
        : events;
      if (ownedEvents.some((event) => isIdleStatusEvent(event, sessionId))) {
        activeTurn.idleEmitted = true;
      }
      emitHarnessEvents(getBroadcast(), directory, ownedEvents);
    };
    const emitIdleOnce = () => {
      if (activeTurn.idleEmitted) return;
      activeTurn.idleEmitted = true;
      emitHarnessEvents(getBroadcast(), directory, [idleEvent(sessionId)]);
    };

    /**
     * Persist a confirmed rate-limit terminal into the retry runtime.
     * Returns `true` when the durable obligation was created. On persistence
     * failure the binding records the store error and a hard session error is
     * emitted; the caller must fall back to `outcome = 'error'`.
     */
    const scheduleRetryForTerminal = (terminal) => {
      try {
        retryRuntime.schedule({
          sessionId,
          directory,
          foreignSessionId: getSessionBinding(sessionId)?.foreignSessionId,
          target: binding.target,
          agentsMode,
          agentName: requestedAgentName || undefined,
          claudeAgentName: claudeAgentName || undefined,
          assistantUuid: terminal.assistantUuid,
          expectedTailUuid: terminal.assistantUuid,
          rateLimitType: terminal.rateLimitType,
          resetAt: terminal.resetAt,
          attempt: 1,
        });
        recoveryContexts.set(sessionId, ctx);
        return true;
      } catch (error) {
        setBindingError(sessionId, {
          code: error?.code || 'RETRY_STORE_UNAVAILABLE',
          message: error?.message || 'Retry persistence failed',
        });
        emitEvents([{ type: 'session.error', properties: { sessionID: sessionId } }]);
        return false;
      }
    };

    const completion = (async () => {
      let outcome = 'success';
      let terminalResult;
      try {
        for await (const message of handle.stream) {
          const { events, foreignSessionId, capabilities, terminal } = mapClaudeMessageToEvents(ctx, message);
          if (foreignSessionId) setForeignSessionId(sessionId, foreignSessionId);
          if (capabilities) updateSessionCapabilities(sessionId, capabilities);
          emitEvents(events);
          if (terminal?.type === 'rate-limit') terminalResult = terminal;
        }
        if (terminalResult) {
          if (internal) {
            outcome = 'rate-limit';
          } else if (scheduleRetryForTerminal(terminalResult)) {
            outcome = 'rate-limit';
          } else {
            outcome = 'error';
          }
        } else {
          updateSessionBinding(sessionId, { lastError: undefined });
        }
      } catch (error) {
        if (activeTurn.aborting) return;
        if (terminalResult?.type === 'rate-limit') {
          // The Claude Agent SDK delivers the structured rate-limit result
          // (rate_limit_event + parent `error: 'rate_limit'` + result) and
          // then throws its own "Claude Code returned an error result: ..."
          // exit error after the stream. The correlated structured terminal is
          // authoritative — schedule durable recovery instead of recording a
          // generic CLAUDE_TURN_ERROR. Recovery turns keep the obligation too:
          // the runtime re-schedules with attempt + 1.
          if (internal || scheduleRetryForTerminal(terminalResult)) {
            outcome = 'rate-limit';
          } else {
            outcome = 'error';
          }
          return { outcome, terminal: terminalResult };
        }
        const rawMessage = error instanceof Error ? error.message : 'Claude Code turn failed';
        const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const isEnotdir = rawCode === 'ENOTDIR' || /spawn.*ENOTDIR/i.test(rawMessage);
        const message = isEnotdir
          ? 'Claude Code executable path is not spawnable (ENOTDIR). Reinstall/update Desktop or ensure `claude` is on PATH.'
          : rawMessage;
        setBindingError(sessionId, {
          code: isEnotdir ? 'CLAUDE_SPAWN_ENOTDIR' : 'CLAUDE_TURN_ERROR',
          message,
        });
        emitEvents([
          idleEvent(sessionId),
          { type: 'session.error', properties: { sessionID: sessionId } },
        ]);
        outcome = 'error';
      } finally {
        try { rejectPending(sessionId); } catch {}
        if (!internal && (outcome !== 'rate-limit' || activeTurn.aborting)) emitIdleOnce();
        try { handle.close(); } catch {}
        turnAbort.abort();
        activeTurns.delete(sessionId);
      }
      return { outcome, terminal: terminalResult };
    })();
    activeTurn.completion = completion;

    if (internal) return completion;

    return {
      ok: true,
      sessionId,
      harnessId: 'claude-code',
      messageId: userMessageId,
      assistantMessageId,
      foreignSessionId: getSessionBinding(sessionId)?.foreignSessionId,
      status: 'started',
    };
  };

  if (!retryRuntime) {
    retryRuntime = createHarnessRetryRuntime({
      store: retryStore,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: clearTimeout,
      inspectTranscript: deps.inspectTranscript || (async (params) => inspectRecoveryTranscript(params)),
      emitStatus: (sessionId, directory, status) => emitHarnessEvents(getBroadcast(), directory, [
        { type: 'session.status', properties: { sessionID: sessionId, status } },
      ]),
      sessionExists: deps.sessionExists || (async () => 'unknown'),
      launchRecovery: async ({ record, toolGuard }) => {
        const binding = getSessionBinding(record.sessionId) || record;
        let ctx = recoveryContexts.get(record.sessionId);
        if (!ctx) {
          const replay = getClaudeTranscriptMessages(record.sessionId);
          const lastUser = replay.findLast?.((entry) => entry?.info?.role === 'user');
          const lastAssistant = replay.findLast?.((entry) => entry?.info?.role === 'assistant');
          ctx = createClaudeMapperContext({
            sessionId: record.sessionId,
            directory: record.directory,
            userMessageId: lastUser?.info?.id || createOpenCodeId('msg'),
            assistantMessageId: lastAssistant?.info?.id || createOpenCodeId('msg'),
            modelRef: record.target?.modelRef || 'sonnet',
          });
        }
        ctx.parentRateLimitError = null;
        ctx.latestRateLimitInfo = null;
        ctx.sdkRetryActive = false;
        const message = buildRecoveryUserMessage(record.launchUuid);
        const promptInput = (async function* () { yield message; })();
        try {
          return await startPreparedTurn({
            sessionId: record.sessionId,
            directory: record.directory,
            target: record.target,
            agentsMode: record.agentsMode,
            agent: record.agentName,
            claudeAgent: record.claudeAgentName,
          }, {
            binding: { ...binding, foreignSessionId: record.foreignSessionId, target: record.target },
            ctx,
            promptInput,
            toolGuard: Array.isArray(toolGuard) ? createRecoveryToolGuard(toolGuard) : toolGuard,
          });
        } catch (error) {
          emitHarnessEvents(getBroadcast(), record.directory, [
            { type: 'session.error', properties: { sessionID: record.sessionId } },
          ]);
          throw error;
        }
      },
    });
  }

  const abort = async (body) => {
    const sessionId = asString(body?.sessionId);
    if (!sessionId) throw httpError('sessionId is required', 'ABORT_INVALID', 400);

    const active = activeTurns.get(sessionId);
    const binding = getSessionBinding(sessionId);
    if (!active && retryRuntime?.hasPending(sessionId)) {
      const pending = getSessionBinding(sessionId) || getPendingRetry(sessionId);
      const result = await retryRuntime.cancel(sessionId);
      if (result?.aborted && pending?.directory) {
        const events = [abortedMessageEvent(sessionId, pending.target)];
        emitHarnessEvents(getBroadcast(), pending.directory, events);
      }
      return { ok: true, sessionId, aborted: Boolean(result?.aborted) };
    }
    if (!active) return { ok: true, sessionId, aborted: false, reason: 'no-active-turn' };

    const canceledDurableRecovery = retryRuntime?.hasPending(sessionId)
      ? Boolean((await retryRuntime.cancel(sessionId))?.aborted)
      : false;

    active.aborting = true;
    active.idleEmitted = true;
    try { active.turnAbort?.abort(); } catch {}
    try { rejectPending(sessionId); } catch {}
    try {
      await interruptWithTimeout(active.handle);
    } catch {
    } finally {
      try { active.handle.close(); } catch {}
      activeTurns.delete(sessionId);
    }

    if (binding?.directory) {
      emitHarnessEvents(getBroadcast(), binding.directory, [
        ...buildTurnAbortEvents(active.ctx),
        abortedMessageEvent(sessionId, binding.target),
        ...(canceledDurableRecovery ? [] : [idleEvent(sessionId)]),
      ]);
    }

    return { ok: true, sessionId, aborted: true };
  };

  const stop = async () => {
    await retryRuntime?.stop();
    await Promise.all(Array.from(activeTurns.values(), async (active) => {
      active.aborting = true;
      active.turnAbort?.abort();
      await interruptWithTimeout(active.handle);
      active.handle.close?.();
    }));
    activeTurns.clear();
  };

  const deleteSession = async (sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const active = activeTurns.get(sessionId);
    if (active) {
      active.aborting = true;
      active.idleEmitted = true;
      active.turnAbort?.abort();
      try { await interruptWithTimeout(active.handle); } catch {}
      try { active.handle.close?.(); } catch {}
      activeTurns.delete(sessionId);
    }
    try {
      rejectPending(sessionId);
      await retryRuntime?.deleteSession(sessionId, { authoritative: true });
    } finally {
      clearSessionBinding(sessionId);
      clearHarnessTurnSnapshot(sessionId);
      clearSessionCapabilities(sessionId);
    }
    return { removed: true };
  };

  return {
    prompt: async (body) => startPreparedTurn(body),
    abort,
    replyPermission: async (body) => replyPendingPermission(body),
    replyQuestion: async (body) => replyPendingQuestion(body),
    start: () => retryRuntime?.start(),
    stop,
    hasPendingRetry: (sessionId) => Boolean(retryRuntime?.hasPending(sessionId)),
    deleteSession,
    _activeTurns: activeTurns,
  };
}
