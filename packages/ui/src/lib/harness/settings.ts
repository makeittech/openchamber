import type { HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';

/** Which agent definitions Claude Code sessions inherit. */
export type ClaudeAgentsMode = 'claude' | 'opencode';

export const CLAUDE_AGENTS_MODES: readonly ClaudeAgentsMode[] = ['claude', 'opencode'] as const;

export function isClaudeAgentsMode(value: unknown): value is ClaudeAgentsMode {
  return typeof value === 'string'
    && (CLAUDE_AGENTS_MODES as readonly string[]).includes(value);
}

export type HarnessSettingsFields = {
  harnessDefaultId: HarnessId;
  /** Confirm dialog when switching harness on a session with messages. Default true. */
  harnessWarnOnSwitch: boolean;
  harnessClaudeCodeEnabled: boolean;
  /**
   * Claude Code agent source:
   * - `opencode` — OpenChamber/OpenCode agents drive permissionMode + system prompt append
   * - `claude` — native Claude Code agents / prompts / permission settings
   */
  harnessClaudeCodeAgentsMode: ClaudeAgentsMode;
};

export const HARNESS_SETTINGS_DEFAULTS: HarnessSettingsFields = {
  harnessDefaultId: 'opencode',
  harnessWarnOnSwitch: true,
  harnessClaudeCodeEnabled: true,
  // Preserve documented v1 behavior: OpenCode agents derive Claude permissionMode.
  harnessClaudeCodeAgentsMode: 'opencode',
};

/** In-memory mirror of the harness-switch confirm toggle for picker/send gates. */
let cachedWarnOnHarnessSwitch: boolean =
  HARNESS_SETTINGS_DEFAULTS.harnessWarnOnSwitch;

export function getCachedWarnOnHarnessSwitch(): boolean {
  return cachedWarnOnHarnessSwitch;
}

export function setCachedWarnOnHarnessSwitch(enabled: boolean): void {
  cachedWarnOnHarnessSwitch = enabled;
}

/** In-memory mirror for Claude send-path agent inheritance (no per-send settings fetch). */
let cachedClaudeAgentsMode: ClaudeAgentsMode =
  HARNESS_SETTINGS_DEFAULTS.harnessClaudeCodeAgentsMode;

export function getCachedClaudeAgentsMode(): ClaudeAgentsMode {
  return cachedClaudeAgentsMode;
}

export function setCachedClaudeAgentsMode(mode: ClaudeAgentsMode): void {
  cachedClaudeAgentsMode = mode;
}

export type SanitizedHarnessSettings = Partial<HarnessSettingsFields>;

/**
 * Sanitize persisted harness settings fields.
 * Invalid harness ids fall back to `opencode`. Wrong-typed fields are omitted.
 * Legacy `engines*` keys are accepted (read migration); output uses new keys only.
 */
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

/** Fill missing harness settings with product defaults. */
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
