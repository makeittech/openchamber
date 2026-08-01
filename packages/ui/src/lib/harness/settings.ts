import type { HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';

export type ClaudeAgentsMode = 'claude' | 'opencode';

const isClaudeAgentsMode = (value: unknown): value is ClaudeAgentsMode =>
  value === 'claude' || value === 'opencode';

export type HarnessSettingsFields = {
  harnessDefaultId: HarnessId;
  harnessWarnOnSwitch: boolean;
  harnessClaudeCodeEnabled: boolean;
  harnessClaudeCodeAgentsMode: ClaudeAgentsMode;
};

export const HARNESS_SETTINGS_DEFAULTS: HarnessSettingsFields = {
  harnessDefaultId: 'opencode',
  harnessWarnOnSwitch: true,
  harnessClaudeCodeEnabled: true,
  harnessClaudeCodeAgentsMode: 'opencode',
};

let cachedWarnOnHarnessSwitch = HARNESS_SETTINGS_DEFAULTS.harnessWarnOnSwitch;

export function getCachedWarnOnHarnessSwitch(): boolean {
  return cachedWarnOnHarnessSwitch;
}

export function setCachedWarnOnHarnessSwitch(enabled: boolean): void {
  cachedWarnOnHarnessSwitch = enabled;
}

let cachedClaudeAgentsMode = HARNESS_SETTINGS_DEFAULTS.harnessClaudeCodeAgentsMode;
const claudeAgentsModeListeners = new Set<() => void>();

export function getCachedClaudeAgentsMode(): ClaudeAgentsMode {
  return cachedClaudeAgentsMode;
}

export function setCachedClaudeAgentsMode(mode: ClaudeAgentsMode): void {
  if (cachedClaudeAgentsMode === mode) return;
  cachedClaudeAgentsMode = mode;
  for (const listener of claudeAgentsModeListeners) {
    listener();
  }
}

export function subscribeClaudeAgentsMode(listener: () => void): () => void {
  claudeAgentsModeListeners.add(listener);
  return () => {
    claudeAgentsModeListeners.delete(listener);
  };
}

export type SanitizedHarnessSettings = Partial<HarnessSettingsFields>;

export function sanitizeHarnessSettings(candidate: Record<string, unknown>): SanitizedHarnessSettings {
  const result: SanitizedHarnessSettings = {};

  const defaultId = candidate.harnessDefaultId ?? candidate.enginesDefaultHarnessId;
  if (defaultId !== undefined) {
    result.harnessDefaultId = isHarnessId(defaultId)
      ? defaultId
      : HARNESS_SETTINGS_DEFAULTS.harnessDefaultId;
  }

  const warnOnSwitch = candidate.harnessWarnOnSwitch ?? candidate.enginesClaudeCodeWarnOnOpenCodeHandoff;
  if (typeof warnOnSwitch === 'boolean') {
    result.harnessWarnOnSwitch = warnOnSwitch;
  }

  const claudeCodeEnabled = candidate.harnessClaudeCodeEnabled ?? candidate.enginesClaudeCodeEnabled;
  if (typeof claudeCodeEnabled === 'boolean') {
    result.harnessClaudeCodeEnabled = claudeCodeEnabled;
  }

  const agentsMode = candidate.harnessClaudeCodeAgentsMode ?? candidate.enginesClaudeCodeAgentsMode;
  if (agentsMode !== undefined) {
    if (isClaudeAgentsMode(agentsMode)) {
      result.harnessClaudeCodeAgentsMode = agentsMode;
    } else {
      result.harnessClaudeCodeAgentsMode = HARNESS_SETTINGS_DEFAULTS.harnessClaudeCodeAgentsMode;
    }
  }

  return result;
}

export function withHarnessSettingsDefaults(
  partial: SanitizedHarnessSettings | null | undefined,
): HarnessSettingsFields {
  return {
    harnessDefaultId: partial?.harnessDefaultId ?? HARNESS_SETTINGS_DEFAULTS.harnessDefaultId,
    harnessWarnOnSwitch:
      partial?.harnessWarnOnSwitch
      ?? HARNESS_SETTINGS_DEFAULTS.harnessWarnOnSwitch,
    harnessClaudeCodeEnabled:
      partial?.harnessClaudeCodeEnabled ?? HARNESS_SETTINGS_DEFAULTS.harnessClaudeCodeEnabled,
    harnessClaudeCodeAgentsMode:
      partial?.harnessClaudeCodeAgentsMode ?? HARNESS_SETTINGS_DEFAULTS.harnessClaudeCodeAgentsMode,
  };
}
