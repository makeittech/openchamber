/**
 * Cursor engine translator — prompt/abort orchestration.
 */

import { runCursorAgentTurn } from './agent-client.js';
import { resolveCursorAccessToken } from './credentials.js';
import {
  FALLBACK_MODELS,
  getCursorModels,
  resolveCursorModelSelection,
} from './models.js';
import { literalCursorModelSelection } from './model-selection.js';
import {
  buildCursorUserMessageEvents,
  createCursorMapperContext,
  createOpenCodeId,
  mapCursorEventToEvents,
} from '../../events/from-cursor.js';
import { emitHarnessEvents } from '../../events/emit.js';
import {
  bindSession,
  getSessionBinding,
  setBindingError,
  setForeignSessionId,
  updateSessionBinding,
} from '../../session-bindings.js';
import { getHarnessCapabilities } from '../../registry.js';
import { detectCursor } from '../../detect.js';

/**
 * @param {string | undefined} modelRef
 * @param {object[]} models
 */
function selectionForModelRef(modelRef, models) {
  const ref = typeof modelRef === 'string' && modelRef.trim() ? modelRef.trim() : 'composer-1.5';
  // modelRef may be "id" or "id:variant"
  const [modelId, variant] = ref.split(':');
  return resolveCursorModelSelection(models, modelId, variant)
    || literalCursorModelSelection(modelId || 'composer-1.5');
}

/**
 * Encode checkpoint bytes for durable foreignSessionId storage (base64).
 * @param {Uint8Array | null | undefined} bytes
 * @param {string} conversationId
 * @returns {string | undefined}
 */
function encodeForeignState(bytes, conversationId) {
  if (!conversationId) return undefined;
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.length === 0) {
    return `cursor:${conversationId}`;
  }
  return `cursor:${conversationId}:${Buffer.from(bytes).toString('base64url')}`;
}

/**
 * @param {string | undefined} foreignSessionId
 * @returns {{ conversationId?: string, conversationState?: Uint8Array | null }}
 */
function decodeForeignState(foreignSessionId) {
  if (typeof foreignSessionId !== 'string' || !foreignSessionId.startsWith('cursor:')) {
    return {};
  }
  const rest = foreignSessionId.slice('cursor:'.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) {
    return { conversationId: rest || undefined, conversationState: null };
  }
  const conversationId = rest.slice(0, firstColon);
  const encoded = rest.slice(firstColon + 1);
  try {
    return {
      conversationId,
      conversationState: Buffer.from(encoded, 'base64url'),
    };
  } catch {
    return { conversationId, conversationState: null };
  }
}

/**
 * @param {object} deps
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} [deps.getBroadcast]
 * @param {typeof runCursorAgentTurn} [deps.runTurn]
 * @param {typeof detectCursor} [deps.detect]
 * @param {typeof resolveCursorAccessToken} [deps.resolveAccessToken]
 */
export function createCursorTranslator(deps = {}) {
  /** @type {Map<string, { abortController: AbortController, aborting: boolean }>} */
  const activeTurns = new Map();
  const getBroadcast = deps.getBroadcast || (() => null);
  const runTurn = deps.runTurn || runCursorAgentTurn;
  const detect = deps.detect || detectCursor;
  const resolveAccessToken = deps.resolveAccessToken || resolveCursorAccessToken;

  /**
   * @param {object} body
   */
  const prompt = async (body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const directory = typeof body?.directory === 'string' ? body.directory : '';
    const text = typeof body?.text === 'string' ? body.text : '';
    const target = body?.target && typeof body.target === 'object' ? body.target : null;
    const harnessId = target?.harnessId || 'cursor';

    if (!sessionId || !directory) {
      const error = new Error('sessionId and directory are required');
      error.code = 'PROMPT_INVALID';
      error.statusCode = 400;
      throw error;
    }
    if (harnessId !== 'cursor') {
      const error = new Error(`Unsupported harnessId for Cursor translator: ${harnessId}`);
      error.code = 'HARNESS_UNSUPPORTED';
      error.statusCode = 400;
      throw error;
    }

    const detection = await detect();
    if (detection.status !== 'ready') {
      const error = new Error(detection.statusDetail || `Cursor is not ready (${detection.status})`);
      error.code = detection.status === 'needs-login'
        ? 'CURSOR_NEEDS_LOGIN'
        : 'CURSOR_NOT_READY';
      error.statusCode = 503;
      error.status = detection.status;
      throw error;
    }

    const existing = getSessionBinding(sessionId);
    if (existing && existing.harnessId !== 'cursor') {
      const error = new Error('Session is bound to a different engine; create a new session for handoff');
      error.code = 'BINDING_CONFLICT';
      error.statusCode = 409;
      throw error;
    }

    if (activeTurns.has(sessionId)) {
      const error = new Error('A Cursor turn is already active for this session');
      error.code = 'TURN_IN_PROGRESS';
      error.statusCode = 409;
      throw error;
    }

    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      const error = new Error('Cursor credentials are missing or expired. Sign in again.');
      error.code = 'CURSOR_NEEDS_LOGIN';
      error.statusCode = 503;
      error.status = 'needs-login';
      throw error;
    }

    const capabilities = getHarnessCapabilities('cursor');
    const modelRef = typeof target?.modelRef === 'string' ? target.modelRef : 'composer-1.5';
    const { binding } = bindSession({
      sessionId,
      harnessId: 'cursor',
      directory,
      target: {
        harnessId: 'cursor',
        modelRef,
      },
      capabilitySnapshot: capabilities,
      seedFromSessionId: typeof body?.seedFromSessionId === 'string' ? body.seedFromSessionId : undefined,
    });

    const userMessageId = typeof body?.messageId === 'string' && body.messageId
      ? body.messageId
      : createOpenCodeId('msg');
    const assistantMessageId = typeof body?.assistantMessageId === 'string' && body.assistantMessageId
      ? body.assistantMessageId
      : createOpenCodeId('msg');

    const ctx = createCursorMapperContext({
      sessionId,
      directory,
      userMessageId,
      assistantMessageId,
      modelRef: binding.target?.modelRef || modelRef,
    });

    const broadcast = getBroadcast();
    const userEvents = buildCursorUserMessageEvents(ctx, text);
    emitHarnessEvents(broadcast, directory, userEvents);

    let models = FALLBACK_MODELS;
    try {
      models = await getCursorModels(accessToken);
    } catch {
      models = FALLBACK_MODELS;
    }
    const modelSelection = selectionForModelRef(binding.target?.modelRef || modelRef, models);
    const resumed = decodeForeignState(binding.foreignSessionId);
    const conversationId = resumed.conversationId || crypto.randomUUID();

    const abortController = new AbortController();
    activeTurns.set(sessionId, { abortController, aborting: false });

    void (async () => {
      try {
        const result = await runTurn({
          accessToken,
          text,
          cwd: directory,
          modelSelection,
          conversationId,
          conversationState: resumed.conversationState,
          abortSignal: abortController.signal,
          onEvent: (event) => {
            const mapped = mapCursorEventToEvents(ctx, event);
            if (mapped.checkpoint) {
              const foreign = encodeForeignState(mapped.checkpoint, conversationId);
              if (foreign) setForeignSessionId(sessionId, foreign);
            }
            emitHarnessEvents(getBroadcast(), directory, mapped.events);
          },
        });

        const foreign = encodeForeignState(
          result.checkpoint,
          result.conversationId || conversationId,
        );
        if (foreign) setForeignSessionId(sessionId, foreign);
        updateSessionBinding(sessionId, { lastError: undefined });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cursor turn failed';
        setBindingError(sessionId, { code: 'CURSOR_TURN_ERROR', message });
        emitHarnessEvents(getBroadcast(), directory, [
          {
            type: 'session.status',
            properties: { sessionID: sessionId, status: { type: 'idle' } },
          },
          {
            type: 'session.error',
            properties: { sessionID: sessionId },
          },
        ]);
      } finally {
        activeTurns.delete(sessionId);
      }
    })();

    return {
      ok: true,
      sessionId,
      harnessId: 'cursor',
      messageId: userMessageId,
      assistantMessageId,
      foreignSessionId: getSessionBinding(sessionId)?.foreignSessionId,
      status: 'started',
    };
  };

  /**
   * @param {{ sessionId: string }} body
   */
  const abort = async (body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) {
      const error = new Error('sessionId is required');
      error.code = 'ABORT_INVALID';
      error.statusCode = 400;
      throw error;
    }

    const active = activeTurns.get(sessionId);
    const binding = getSessionBinding(sessionId);
    if (!active) {
      return { ok: true, sessionId, aborted: false, reason: 'no-active-turn' };
    }

    active.aborting = true;
    try {
      active.abortController.abort();
    } catch {
      // ignore
    }
    activeTurns.delete(sessionId);

    if (binding?.directory) {
      emitHarnessEvents(getBroadcast(), binding.directory, [{
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      }]);
    }

    return { ok: true, sessionId, aborted: true };
  };

  return {
    prompt,
    abort,
    /** @internal test helper */
    _activeTurns: activeTurns,
  };
}

export const cursorTranslator = createCursorTranslator();
