/**
 * Harness prompt/abort dispatch.
 */

import { createClaudeCodeTranslator } from './translators/claude-code/index.js';
import { createOpenCodeTranslator } from './translators/opencode/index.js';

/**
 * @param {object} [deps]
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} [deps.getBroadcast]
 * @param {(options?: object) => Promise<Record<string, unknown> | null>} [deps.createOpenChamberMcpServers]
 * @param {(params: { name: string, args: string, directory: string }) => Promise<{ name: string, text: string }>} [deps.resolveOpenCodeCommand]
 * @param {(params: { directory: string, agentName?: string }) => Promise<import('./translators/claude-code/opencode-agents.js').OpenCodeAgentInheritance>} [deps.resolveOpenCodeAgents]
 */
export function createHarnessRouter(deps = {}) {
  const getBroadcast = deps.getBroadcast || (() => null);
  const claude = deps.claudeTranslator || createClaudeCodeTranslator({
    getBroadcast,
    createOpenChamberMcpServers: deps.createOpenChamberMcpServers,
    resolveOpenCodeCommand: deps.resolveOpenCodeCommand,
    resolveOpenCodeAgents: deps.resolveOpenCodeAgents,
  });
  const opencode = deps.opencodeTranslator || createOpenCodeTranslator();

  /**
   * @param {object} body
   */
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

  /**
   * @param {object} body
   */
  const abort = async (body) => {
    // Abort is session-scoped; Claude translator owns active-turn state.
    // OpenCode abort remains on the SDK path.
    return claude.abort(body);
  };

  /**
   * Resolve a bridged Claude permission prompt.
   * @param {object} body
   */
  const replyPermission = async (body) => {
    if (typeof claude.replyPermission !== 'function') {
      const error = new Error('Permission reply is unavailable');
      error.code = 'PERMISSION_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    return claude.replyPermission(body);
  };

  /**
   * Resolve a bridged Claude question prompt.
   * @param {object} body
   */
  const replyQuestion = async (body) => {
    if (typeof claude.replyQuestion !== 'function') {
      const error = new Error('Question reply is unavailable');
      error.code = 'QUESTION_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    return claude.replyQuestion(body);
  };

  return {
    prompt, abort, replyPermission, replyQuestion,
    start: () => claude.start?.(),
    stop: () => claude.stop?.(),
    hasPendingRetry: (sessionId) => Boolean(claude.hasPendingRetry?.(sessionId)),
    deleteSession: (sessionId) => claude.deleteSession?.(sessionId),
    claude, opencode,
  };
}
