import type { ClaudePermissionMode, ExecutionTarget } from '@/types/harness';
import type { ClaudeAgentsMode } from '@/lib/harness/settings';
import { claudePermissionModeFromEditPermission } from '@/lib/harness/claude-models';
import {
  getAgentDefaultEditPermission,
  getAgentPrompt,
} from '@/stores/utils/permissionUtils';

export type ClaudeAgentsSendOptions = {
  target: Extract<ExecutionTarget, { harnessId: 'claude-code' }>;
  systemPromptAppend?: string;
  agent?: string;
  claudeAgent?: string;
  agentsMode: ClaudeAgentsMode;
};

export function resolveClaudeAgentsSendOptions(params: {
  target: Extract<ExecutionTarget, { harnessId: 'claude-code' }>;
  agentsMode: ClaudeAgentsMode;
  agentName?: string;
  claudeAgentName?: string;
}): ClaudeAgentsSendOptions {
  const agentsMode = params.agentsMode;
  const base: Extract<ExecutionTarget, { harnessId: 'claude-code' }> = {
    harnessId: 'claude-code',
    modelRef: params.target.modelRef,
    ...(params.target.effort ? { effort: params.target.effort } : {}),
  };

  if (agentsMode === 'claude') {
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
