/**
 * Resolve Claude Code send options from the selected agents mode.
 *
 * - `opencode`: inherit OpenChamber/OpenCode agent edit permission + prompt
 * - `claude`: use native Claude Code prompts/permissions (no OpenCode inheritance)
 *
 * Only the agent *name* is sent to the server in `opencode` mode. The server
 * re-reads that agent's prompt and full permission ruleset from OpenCode
 * (`translators/claude-code/opencode-agents.js`), so the permission bridge can
 * never be handed a client-authored ruleset that allows everything. The
 * `permissionMode` and `systemPromptAppend` computed here remain as the
 * fallback for runtimes where the server has no OpenCode URL builder.
 */

import type { ClaudePermissionMode, ExecutionTarget } from '@/types/harness';
import type { ClaudeAgentsMode } from '@/lib/harness/settings';
import { claudePermissionModeFromEditPermission } from '@/lib/harness/claude-models';
import {
  getAgentDefaultEditPermission,
  getAgentPrompt,
} from '@/stores/utils/permissionUtils';

export type ClaudeAgentsSendOptions = {
  /** Target with permissionMode set only in OpenCode agents mode. */
  target: Extract<ExecutionTarget, { harnessId: 'claude-code' }>;
  /** OpenCode agent prompt to append to Claude's system prompt (opencode mode only). */
  systemPromptAppend?: string;
  /** OpenCode agent name the server resolves prompt + permissions from. */
  agent?: string;
  /** Native Claude agent selected for the main thread (claude mode only). */
  claudeAgent?: string;
  agentsMode: ClaudeAgentsMode;
};

/**
 * Apply agents-mode policy to a Claude execution target for one send.
 */
export function resolveClaudeAgentsSendOptions(params: {
  target: Extract<ExecutionTarget, { harnessId: 'claude-code' }>;
  agentsMode: ClaudeAgentsMode;
  agentName?: string;
  /** Native Claude agent selected in the composer (claude mode only). */
  claudeAgentName?: string;
}): ClaudeAgentsSendOptions {
  const agentsMode = params.agentsMode;
  const base: Extract<ExecutionTarget, { harnessId: 'claude-code' }> = {
    harnessId: 'claude-code',
    modelRef: params.target.modelRef,
    ...(params.target.effort ? { effort: params.target.effort } : {}),
  };

  if (agentsMode === 'claude') {
    // Native Claude: do not inherit OpenCode permissionMode or agent prompts.
    const claudeAgent = params.claudeAgentName?.trim();
    return {
      target: base,
      agentsMode,
      ...(claudeAgent ? { claudeAgent } : {}),
    };
  }

  const permissionMode: ClaudePermissionMode = claudePermissionModeFromEditPermission(
    getAgentDefaultEditPermission(params.agentName),
  );
  const prompt = getAgentPrompt(params.agentName);
  const agent = params.agentName?.trim();
  return {
    agentsMode,
    target: {
      ...base,
      permissionMode,
    },
    ...(agent ? { agent } : {}),
    ...(prompt ? { systemPromptAppend: prompt } : {}),
  };
}
