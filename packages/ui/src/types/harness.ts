export type HarnessId = 'opencode' | 'claude-code';

/**
 * Derived from the selected agent's edit permission. Auto-approve remains a
 * separate bridge mechanism, so bypass modes do not belong here.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan';

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ExecutionTarget =
  | {
      harnessId: 'opencode';
      providerId: string;
      modelId: string;
      agentName?: string;
      variant?: string;
    }
  | {
      harnessId: 'claude-code';
      modelRef: string;
      permissionMode?: ClaudePermissionMode;
      effort?: ClaudeEffort;
    };

export type CapabilityLevel = 'full' | 'partial' | 'none';

export type HarnessCapability =
  | 'prompt'
  | 'abort'
  | 'resume'
  | 'streaming-text'
  | 'streaming-tools'
  | 'permissions'
  | 'images'
  | 'file-attachments'
  | 'shell'
  | 'slash-commands'
  | 'mcp'
  | 'subagents'
  | 'multirun'
  | 'goal'
  | 'openchamber-tool';

export type HarnessRuntimeStatus =
  | 'ready'
  | 'needs-login'
  | 'missing-cli'
  | 'unsupported-host'
  | 'error';

export type HarnessAuthMode = 'subscription-cli' | 'opencode-providers';

export type HarnessDescriptor = {
  id: HarnessId;
  displayName: string;
  shortName: string;
  auth: {
    mode: HarnessAuthMode;
  };
  capabilities: Record<HarnessCapability, CapabilityLevel>;
  install: {
    binaryNames: string[];
    docsUrl: string;
    minVersion?: string;
  };
};

export type HarnessCatalogModel = {
  id: string;
  name: string;
  supportsImages?: boolean;
  supportsDocuments?: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
};

export type HarnessCatalogSection = {
  id: string;
  name: string;
  kind: 'provider' | 'profile' | 'models';
  models: HarnessCatalogModel[];
};

export type HarnessCatalog = {
  descriptor: HarnessDescriptor;
  status: HarnessRuntimeStatus;
  statusDetail?: string;
  version?: string;
  sections: HarnessCatalogSection[];
};

export const HARNESS_IDS: readonly HarnessId[] = ['opencode', 'claude-code'] as const;

export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  'prompt',
  'abort',
  'resume',
  'streaming-text',
  'streaming-tools',
  'permissions',
  'images',
  'file-attachments',
  'shell',
  'slash-commands',
  'mcp',
  'subagents',
  'multirun',
  'goal',
  'openchamber-tool',
] as const;

export const isHarnessId = (value: unknown): value is HarnessId =>
  value === 'opencode' || value === 'claude-code';

export const isHarnessRuntimeStatus = (value: unknown): value is HarnessRuntimeStatus =>
  value === 'ready'
  || value === 'needs-login'
  || value === 'missing-cli'
  || value === 'unsupported-host'
  || value === 'error';

export const isCapabilityLevel = (value: unknown): value is CapabilityLevel =>
  value === 'full' || value === 'partial' || value === 'none';

export const CLAUDE_EFFORT_LEVELS: readonly ClaudeEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const isClaudePermissionMode = (value: unknown): value is ClaudePermissionMode =>
  value === 'default' || value === 'acceptEdits' || value === 'plan';

export const isClaudeEffort = (value: unknown): value is ClaudeEffort =>
  CLAUDE_EFFORT_LEVELS.includes(value as ClaudeEffort);

export const isExecutionTarget = (value: unknown): value is ExecutionTarget => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.harnessId === 'opencode') {
    return typeof candidate.providerId === 'string'
      && candidate.providerId.length > 0
      && typeof candidate.modelId === 'string'
      && candidate.modelId.length > 0
      && (candidate.agentName === undefined || typeof candidate.agentName === 'string')
      && (candidate.variant === undefined || typeof candidate.variant === 'string');
  }
  if (candidate.harnessId === 'claude-code') {
    return typeof candidate.modelRef === 'string'
      && candidate.modelRef.length > 0
      && (candidate.permissionMode === undefined || isClaudePermissionMode(candidate.permissionMode))
      && (candidate.effort === undefined || isClaudeEffort(candidate.effort));
  }
  return false;
};
