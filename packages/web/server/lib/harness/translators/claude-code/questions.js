/**
 * Claude Agent SDK AskUserQuestion ↔ OpenChamber question.asked bridge.
 *
 * The SDK surfaces clarifying questions through the same `canUseTool` callback
 * as permission prompts, but with `toolName === 'AskUserQuestion'`. We translate
 * those into OpenCode `question.asked` events so the shared QuestionCard can
 * collect answers, then return the selections to Claude as the tool's input.
 */

import { createOpenCodeId } from '../../events/from-claude.js';
import { emitHarnessEvents } from '../../events/emit.js';

/**
 * @typedef {object} PendingQuestion
 * @property {(result: object) => void} resolve
 * @property {string} sessionId
 * @property {string} directory
 * @property {object} input
 * @property {() => ((payload: object, options?: object) => void) | null | undefined} getBroadcast
 */

/** @type {Map<string, PendingQuestion>} */
const pending = new Map();

/** Trimmed string, or `''` for anything that is not a string. */
const trimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

function questionError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * @param {unknown} value
 * @returns {value is { label: string; description?: string; preview?: string }}
 */
function isQuestionOption(value) {
  if (!value || typeof value !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return typeof candidate.label === 'string' && candidate.label.length > 0;
}

/**
 * @param {unknown} value
 * @returns {{ label: string; description: string }[]}
 */
function sanitizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isQuestionOption).map((entry) => ({
    label: entry.label,
    description: typeof entry.description === 'string' ? entry.description : '',
  }));
}

/**
 * @param {unknown} value
 * @returns {{ question: string; header: string; options: { label: string; description: string }[]; multiple: boolean }[]}
 */
function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = /** @type {Record<string, unknown>} */ (entry);
    const question = typeof candidate.question === 'string' ? candidate.question.trim() : '';
    const header = typeof candidate.header === 'string' ? candidate.header.trim() : '';
    if (!question) continue;
    const options = sanitizeOptions(candidate.options);
    if (options.length === 0) continue;
    out.push({
      question,
      header,
      options,
      multiple: candidate.multiSelect === true,
    });
  }
  return out;
}

/**
 * @param {string} requestId
 * @param {PendingQuestion} entry
 * @param {'allow' | 'deny'} decision
 * @param {object} [extra]
 */
function settlePending(requestId, entry, decision, extra = {}) {
  pending.delete(requestId);

  const broadcast = entry.getBroadcast();
  emitHarnessEvents(broadcast, entry.directory, [{
    type: decision === 'allow' ? 'question.replied' : 'question.rejected',
    properties: {
      sessionID: entry.sessionId,
      requestID: requestId,
    },
  }]);

  let result;
  if (decision === 'allow') {
    result = { behavior: 'allow', ...extra };
  } else {
    result = { behavior: 'deny', message: extra.message || 'User declined' };
  }
  entry.resolve(result);
}

/**
 * Build the `answers` record Claude expects from the UI payload.
 *
 * @param {{ question: string; multiple: boolean }[]} questions
 * @param {string[][]} answers
 * @returns {Record<string, string>}
 */
function buildAnswersRecord(questions, answers) {
  /** @type {Record<string, string>} */
  const record = {};
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const selected = Array.isArray(answers[i]) ? answers[i] : [];
    if (q.multiple) {
      record[q.question] = selected.join(', ');
    } else {
      record[q.question] = selected[0] || '';
    }
  }
  return record;
}

/**
 * Create a handler for one Claude Code turn's AskUserQuestion prompts.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.directory
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} params.getBroadcast
 * @param {() => string} [params.createId]
 * @param {string} [params.assistantMessageId]
 * @returns {(input: Record<string, unknown>, options: object) => Promise<object>}
 */
export function createAskUserQuestionHandler(params) {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
  const directory = typeof params?.directory === 'string' ? params.directory : '';
  const getBroadcast = typeof params?.getBroadcast === 'function' ? params.getBroadcast : () => null;
  const createId = typeof params?.createId === 'function'
    ? params.createId
    : () => createOpenCodeId('qst');
  const assistantMessageId = typeof params?.assistantMessageId === 'string'
    ? params.assistantMessageId
    : '';

  return async (input, options = {}) => {
    if (!sessionId || !directory) {
      return { behavior: 'deny', message: 'Question bridge misconfigured' };
    }
    if (options?.signal?.aborted) {
      return { behavior: 'deny', message: 'Question request aborted' };
    }

    const safeInput = input && typeof input === 'object' ? input : {};
    const questions = sanitizeQuestions(safeInput.questions);
    if (questions.length === 0) {
      return { behavior: 'deny', message: 'No valid questions' };
    }

    const requestId = createId();

    /** @type {Record<string, unknown>} */
    const questionRequest = {
      id: requestId,
      sessionID: sessionId,
      questions,
    };
    if (typeof options.toolUseID === 'string' && assistantMessageId) {
      questionRequest.tool = {
        messageID: assistantMessageId,
        callID: options.toolUseID,
      };
    }

    const broadcast = getBroadcast();
    emitHarnessEvents(broadcast, directory, [{
      type: 'question.asked',
      properties: questionRequest,
    }]);

    return new Promise((resolve) => {
      /** @type {PendingQuestion} */
      const entry = {
        resolve,
        sessionId,
        directory,
        input: safeInput,
        getBroadcast,
      };

      pending.set(requestId, entry);

      if (options?.signal && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', () => {
          if (!pending.has(requestId)) return;
          settlePending(requestId, entry, 'deny', { message: 'Question request aborted' });
        }, { once: true });
      }
    });
  };
}

/**
 * Resolve a pending AskUserQuestion from the UI reply route.
 *
 * @param {object} body
 * @param {string} body.sessionId
 * @param {string} body.requestId
 * @param {string[][]} [body.answers]
 * @param {boolean} [body.reject]
 * @returns {{ ok: true, sessionId: string, requestId: string }}
 */
export function replyQuestion(body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';

  if (!sessionId || !requestId) {
    throw questionError('sessionId and requestId are required', 'QUESTION_REPLY_INVALID', 400);
  }

  const entry = pending.get(requestId);
  if (!entry) {
    throw questionError('Question request not found', 'QUESTION_NOT_FOUND', 404);
  }
  if (entry.sessionId !== sessionId) {
    throw questionError('Question request does not belong to this session', 'QUESTION_SESSION_MISMATCH', 409);
  }

  if (body?.reject === true) {
    settlePending(requestId, entry, 'deny', { message: 'User declined' });
    return { ok: true, sessionId, requestId };
  }

  const questions = sanitizeQuestions(entry.input.questions);
  const answers = Array.isArray(body?.answers) ? body.answers : [];
  const answersRecord = buildAnswersRecord(questions, answers);

  settlePending(requestId, entry, 'allow', {
    updatedInput: {
      questions: entry.input.questions,
      answers: answersRecord,
    },
  });

  return { ok: true, sessionId, requestId };
}

/**
 * Reject every pending question for a session (abort / turn end).
 * @param {string} sessionId
 * @returns {number} settled count
 */
export function rejectPendingForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return 0;
  let count = 0;
  for (const [requestId, entry] of Array.from(pending.entries())) {
    if (entry.sessionId !== sessionId) continue;
    settlePending(requestId, entry, 'deny', { message: 'Turn ended' });
    count += 1;
  }
  return count;
}

/** Test helper — clears pending map. */
export function resetPendingQuestions() {
  pending.clear();
}
