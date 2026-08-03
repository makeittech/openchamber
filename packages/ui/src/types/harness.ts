/**
 * Harness contracts for OpenChamber execution backends.
 * UI copy uses "Harness"; code identifiers use harnessId.
 */

export type HarnessId = 'opencode' | 'claude-code';

/**
 * Claude permission modes OpenChamber can produce.
 *
 * This is never a standalone control: it is derived from the selected agent's
 * edit permission on every send (see `claudePermissionModeFromEditPermission`).
 * Auto-approve is a separate mechanism that answers the `canUseTool` bridge,
 * so no bypass mode belongs here — one would silently defeat that bridge.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan';

/** Claude Agent SDK effort levels (named). */
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
      /** Reasoning effort for Claude Agent SDK; omit for SDK default. */
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

/** Server JSON shape for GET /api/harness and GET /api/harness/:id */
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

const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
] as const;

export const CLAUDE_EFFORT_LEVELS: readonly ClaudeEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const isClaudePermissionMode = (value: unknown): value is ClaudePermissionMode =>
  typeof value === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);

export const isClaudeEffort = (value: unknown): value is ClaudeEffort =>
  typeof value === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);

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
