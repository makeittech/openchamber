import { createClaudeCodeTranslator } from './translators/claude-code/index.js';

function opencodeSdkError() {
  const error = new Error('OpenCode harness prompts use the OpenCode SDK path');
  error.code = 'OPENCODE_SDK_PATH';
  error.statusCode = 400;
  throw error;
}

function unavailable(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  throw error;
}

export function createHarnessRouter(deps = {}) {
  const getBroadcast = deps.getBroadcast || (() => null);
  const claude = deps.claudeTranslator || createClaudeCodeTranslator({
    getBroadcast,
    createOpenChamberMcpServers: deps.createOpenChamberMcpServers,
    resolveOpenCodeCommand: deps.resolveOpenCodeCommand,
    resolveOpenCodeAgents: deps.resolveOpenCodeAgents,
  });
  const opencode = deps.opencodeTranslator || { prompt: opencodeSdkError };

  const prompt = async (body) => {
    const harnessId = body?.target?.harnessId || body?.harnessId;
    if (harnessId === 'opencode') {
      return opencode.prompt(body);
    }
    if (harnessId === 'claude-code') {
      return claude.prompt(body);
    }
    const error = new Error(harnessId
      ? `Unsupported harnessId: ${harnessId}`
      : 'target.harnessId is required');
    error.code = 'HARNESS_UNSUPPORTED';
    error.statusCode = 400;
    throw error;
  };

  const reply = (method, message, code) => async (body) => {
    if (typeof claude[method] !== 'function') unavailable(message, code);
    return claude[method](body);
  };

  return {
    prompt,
    abort: async (body) => claude.abort(body),
    replyPermission: reply('replyPermission', 'Permission reply is unavailable', 'PERMISSION_UNAVAILABLE'),
    replyQuestion: reply('replyQuestion', 'Question reply is unavailable', 'QUESTION_UNAVAILABLE'),
    start: () => claude.start?.(),
    stop: () => claude.stop?.(),
    hasPendingRetry: (sessionId) => Boolean(claude.hasPendingRetry?.(sessionId)),
    deleteSession: (sessionId) => claude.deleteSession?.(sessionId),
    claude, opencode,
  };
}
