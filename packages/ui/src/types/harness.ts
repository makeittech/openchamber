/**
 * Harness / engine contracts for OpenChamber execution backends.
 * UI copy uses "Engine"; code identifiers use harnessId.
 */

export type HarnessId = 'opencode' | 'claude-code' | 'cursor';

export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

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
    }
  | {
      harnessId: 'cursor';
      modelRef: string;
      variant?: string;
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

export type HarnessAuthMode = 'subscription-cli' | 'opencode-providers' | 'subscription-oauth';

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

export type EngineCatalogModel = {
  id: string;
  name: string;
  supportsImages?: boolean;
  supportsDocuments?: boolean;
};

export type EngineCatalogSection = {
  id: string;
  name: string;
  kind: 'provider' | 'profile' | 'models';
  models: EngineCatalogModel[];
};

/** Server JSON shape for GET /api/harness and GET /api/harness/:id */
export type EngineCatalog = {
  engine: HarnessDescriptor;
  status: HarnessRuntimeStatus;
  statusDetail?: string;
  version?: string;
  sections: EngineCatalogSection[];
};

export const HARNESS_IDS: readonly HarnessId[] = ['opencode', 'claude-code', 'cursor'] as const;

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
  value === 'opencode' || value === 'claude-code' || value === 'cursor';

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
  'dontAsk',
  'bypassPermissions',
] as const;

export const isClaudePermissionMode = (value: unknown): value is ClaudePermissionMode =>
  typeof value === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);

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
      && (candidate.permissionMode === undefined || isClaudePermissionMode(candidate.permissionMode));
  }
  if (candidate.harnessId === 'cursor') {
    return typeof candidate.modelRef === 'string'
      && candidate.modelRef.length > 0
      && (candidate.variant === undefined || typeof candidate.variant === 'string');
  }
  return false;
};
