export type ModelMode = 'default' | 'smart' | 'prioritised';

export type ModelModeCondition = 'topic' | 'time' | 'promptPrefix' | 'tokenCount';

export interface ModelModeRule {
  condition: ModelModeCondition;
  value: string;
  model: string;
}

export interface ModelPriority {
  model: string;
  timeout?: number;
  retryOn?: ('error' | 'timeout' | 'rateLimit')[];
}

export interface ModelModeConfig {
  mode: ModelMode;
  defaultModel: string;
  rules?: ModelModeRule[];
  priorities?: ModelPriority[];
}

export const MODEL_MODES: ModelMode[] = ['default', 'smart', 'prioritised'];
export const MODEL_MODE_CONDITIONS: ModelModeCondition[] = ['topic', 'time', 'promptPrefix', 'tokenCount'];
export const MODEL_PRIORITY_RETRY_OPTIONS = ['error', 'timeout', 'rateLimit'] as const;

const MAX_RULES = 100;
const MAX_PRIORITIES = 50;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_VALUE_LENGTH = 4096;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

export function isValidModelMode(value: unknown): value is ModelMode {
  return typeof value === 'string' && MODEL_MODES.includes(value as ModelMode);
}

export function isValidModelModeCondition(value: unknown): value is ModelModeCondition {
  return typeof value === 'string' && MODEL_MODE_CONDITIONS.includes(value as ModelModeCondition);
}

export function isValidModelId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_MODEL_ID_LENGTH;
}

export function validateModelModeRule(rule: unknown): ModelModeRule | null {
  if (!rule || typeof rule !== 'object') return null;

  const r = rule as Record<string, unknown>;

  const condition = r.condition;
  if (!isValidModelModeCondition(condition)) return null;

  const value = typeof r.value === 'string' ? r.value.trim() : '';
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return null;

  const model = typeof r.model === 'string' ? r.model.trim() : '';
  if (!isValidModelId(model)) return null;

  return { condition, value, model };
}

export function validateModelPriority(priority: unknown): ModelPriority | null {
  if (!priority || typeof priority !== 'object') return null;

  const p = priority as Record<string, unknown>;

  const model = typeof p.model === 'string' ? p.model.trim() : '';
  if (!isValidModelId(model)) return null;

  const result: ModelPriority = { model };

  if (typeof p.timeout === 'number' && Number.isFinite(p.timeout)) {
    const timeout = Math.round(p.timeout);
    if (timeout >= MIN_TIMEOUT_MS && timeout <= MAX_TIMEOUT_MS) {
      result.timeout = timeout;
    }
  }

  if (Array.isArray(p.retryOn)) {
    const validRetryOn: ('error' | 'timeout' | 'rateLimit')[] = [];
    for (const item of p.retryOn) {
      if (MODEL_PRIORITY_RETRY_OPTIONS.includes(item as typeof MODEL_PRIORITY_RETRY_OPTIONS[number])) {
        validRetryOn.push(item as typeof MODEL_PRIORITY_RETRY_OPTIONS[number]);
      }
    }
    if (validRetryOn.length > 0) {
      result.retryOn = validRetryOn;
    }
  }

  return result;
}

export function validateModelModeRules(rules: unknown): ModelModeRule[] | null {
  if (!Array.isArray(rules)) return null;

  const validated: ModelModeRule[] = [];
  for (let i = 0; i < Math.min(rules.length, MAX_RULES); i++) {
    const rule = validateModelModeRule(rules[i]);
    if (rule) {
      validated.push(rule);
    }
  }

  return validated.length > 0 ? validated : null;
}

export function validateModelPriorities(priorities: unknown): ModelPriority[] | null {
  if (!Array.isArray(priorities)) return null;

  const validated: ModelPriority[] = [];
  for (let i = 0; i < Math.min(priorities.length, MAX_PRIORITIES); i++) {
    const priority = validateModelPriority(priorities[i]);
    if (priority) {
      validated.push(priority);
    }
  }

  return validated.length > 0 ? validated : null;
}

export function validateModelModeConfig(config: unknown): ModelModeConfig | null {
  if (!config || typeof config !== 'object') return null;

  const c = config as Record<string, unknown>;

  const mode = isValidModelMode(c.mode) ? c.mode : 'default';
  const defaultModel = typeof c.defaultModel === 'string' ? c.defaultModel.trim() : '';

  if (!isValidModelId(defaultModel)) return null;

  const result: ModelModeConfig = {
    mode,
    defaultModel,
  };

  if (mode === 'smart') {
    const rules = validateModelModeRules(c.rules);
    if (rules) {
      result.rules = rules;
    }
  }

  if (mode === 'prioritised') {
    const priorities = validateModelPriorities(c.priorities);
    if (priorities) {
      result.priorities = priorities;
    }
  }

  return result;
}

export function sanitizeModelModeConfig(input: unknown): Partial<ModelModeConfig> | undefined {
  if (!input || typeof input !== 'object') return undefined;

  const c = input as Record<string, unknown>;
  const result: Partial<ModelModeConfig> = {};

  if (isValidModelMode(c.mode)) {
    result.mode = c.mode;
  }

  if (typeof c.defaultModel === 'string') {
    const trimmed = c.defaultModel.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_MODEL_ID_LENGTH) {
      result.defaultModel = trimmed;
    }
  }

  const rules = validateModelModeRules(c.rules);
  if (rules) {
    result.rules = rules;
  }

  const priorities = validateModelPriorities(c.priorities);
  if (priorities) {
    result.priorities = priorities;
  }

  if (Object.keys(result).length === 0) return undefined;

  return result;
}
