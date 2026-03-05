import { describe, test, expect } from 'bun:test';
import {
  isValidModelMode,
  isValidModelModeCondition,
  isValidModelId,
  validateModelModeRule,
  validateModelPriority,
  validateModelModeRules,
  validateModelPriorities,
  validateModelModeConfig,
  sanitizeModelModeConfig,
} from './modelModes';

describe('isValidModelMode', () => {
  test('returns true for valid modes', () => {
    expect(isValidModelMode('default')).toBe(true);
    expect(isValidModelMode('smart')).toBe(true);
    expect(isValidModelMode('prioritised')).toBe(true);
  });

  test('returns false for invalid modes', () => {
    expect(isValidModelMode('invalid')).toBe(false);
    expect(isValidModelMode('')).toBe(false);
    expect(isValidModelMode(null)).toBe(false);
    expect(isValidModelMode(undefined)).toBe(false);
    expect(isValidModelMode(123)).toBe(false);
  });
});

describe('isValidModelModeCondition', () => {
  test('returns true for valid conditions', () => {
    expect(isValidModelModeCondition('topic')).toBe(true);
    expect(isValidModelModeCondition('time')).toBe(true);
    expect(isValidModelModeCondition('promptPrefix')).toBe(true);
    expect(isValidModelModeCondition('tokenCount')).toBe(true);
  });

  test('returns false for invalid conditions', () => {
    expect(isValidModelModeCondition('invalid')).toBe(false);
    expect(isValidModelModeCondition('')).toBe(false);
    expect(isValidModelModeCondition(null)).toBe(false);
  });
});

describe('isValidModelId', () => {
  test('returns true for valid model IDs', () => {
    expect(isValidModelId('gpt-4')).toBe(true);
    expect(isValidModelId('claude-3-opus')).toBe(true);
    expect(isValidModelId('  trimmed  ')).toBe(true);
  });

  test('returns false for invalid model IDs', () => {
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('   ')).toBe(false);
    expect(isValidModelId(null)).toBe(false);
    expect(isValidModelId('a'.repeat(257))).toBe(false);
  });
});

describe('validateModelModeRule', () => {
  test('validates correct rule', () => {
    const rule = { condition: 'topic', value: 'coding', model: 'gpt-4' };
    const result = validateModelModeRule(rule);
    expect(result).toEqual(rule);
  });

  test('trims whitespace', () => {
    const rule = { condition: 'topic', value: '  coding  ', model: '  gpt-4  ' };
    const result = validateModelModeRule(rule);
    expect(result).toEqual({ condition: 'topic', value: 'coding', model: 'gpt-4' });
  });

  test('returns null for invalid condition', () => {
    const rule = { condition: 'invalid', value: 'coding', model: 'gpt-4' };
    expect(validateModelModeRule(rule)).toBeNull();
  });

  test('returns null for empty value', () => {
    const rule = { condition: 'topic', value: '', model: 'gpt-4' };
    expect(validateModelModeRule(rule)).toBeNull();
  });

  test('returns null for empty model', () => {
    const rule = { condition: 'topic', value: 'coding', model: '' };
    expect(validateModelModeRule(rule)).toBeNull();
  });

  test('returns null for non-object input', () => {
    expect(validateModelModeRule(null)).toBeNull();
    expect(validateModelModeRule(undefined)).toBeNull();
    expect(validateModelModeRule('string')).toBeNull();
  });
});

describe('validateModelPriority', () => {
  test('validates basic priority', () => {
    const priority = { model: 'gpt-4' };
    const result = validateModelPriority(priority);
    expect(result).toEqual({ model: 'gpt-4' });
  });

  test('validates priority with timeout', () => {
    const priority = { model: 'gpt-4', timeout: 30000 };
    const result = validateModelPriority(priority);
    expect(result).toEqual({ model: 'gpt-4', timeout: 30000 });
  });

  test('validates priority with retryOn', () => {
    const priority = { model: 'gpt-4', retryOn: ['error', 'timeout'] };
    const result = validateModelPriority(priority);
    expect(result).toEqual({ model: 'gpt-4', retryOn: ['error', 'timeout'] });
  });

  test('filters invalid retryOn values', () => {
    const priority = { model: 'gpt-4', retryOn: ['error', 'invalid'] };
    const result = validateModelPriority(priority);
    expect(result).toEqual({ model: 'gpt-4', retryOn: ['error'] });
  });

  test('clamps timeout to valid range', () => {
    const low = { model: 'gpt-4', timeout: 100 };
    expect(validateModelPriority(low)?.timeout).toBeUndefined();

    const high = { model: 'gpt-4', timeout: 1000000 };
    expect(validateModelPriority(high)?.timeout).toBeUndefined();
  });

  test('returns null for invalid model', () => {
    expect(validateModelPriority({ model: '' })).toBeNull();
    expect(validateModelPriority(null)).toBeNull();
  });
});

describe('validateModelModeRules', () => {
  test('validates array of rules', () => {
    const rules = [
      { condition: 'topic', value: 'coding', model: 'gpt-4' },
      { condition: 'time', value: 'night', model: 'claude-3' },
    ];
    const result = validateModelModeRules(rules);
    expect(result).toHaveLength(2);
  });

  test('filters invalid rules', () => {
    const rules = [
      { condition: 'topic', value: 'coding', model: 'gpt-4' },
      { condition: 'invalid', value: 'bad', model: 'bad' },
    ];
    const result = validateModelModeRules(rules);
    expect(result).toHaveLength(1);
  });

  test('returns null for empty result', () => {
    expect(validateModelModeRules([])).toBeNull();
    expect(validateModelModeRules([{}])).toBeNull();
  });

  test('returns null for non-array input', () => {
    expect(validateModelModeRules(null)).toBeNull();
    expect(validateModelModeRules({})).toBeNull();
  });
});

describe('validateModelPriorities', () => {
  test('validates array of priorities', () => {
    const priorities = [
      { model: 'gpt-4', timeout: 30000 },
      { model: 'claude-3', timeout: 60000 },
    ];
    const result = validateModelPriorities(priorities);
    expect(result).toHaveLength(2);
  });

  test('returns null for empty result', () => {
    expect(validateModelPriorities([])).toBeNull();
  });
});

describe('validateModelModeConfig', () => {
  test('validates default mode config', () => {
    const config = { mode: 'default', defaultModel: 'gpt-4' };
    const result = validateModelModeConfig(config);
    expect(result).toEqual({ mode: 'default', defaultModel: 'gpt-4' });
  });

  test('defaults mode to default if invalid', () => {
    const config = { mode: 'invalid', defaultModel: 'gpt-4' };
    const result = validateModelModeConfig(config);
    expect(result?.mode).toBe('default');
  });

  test('validates smart mode with rules', () => {
    const config = {
      mode: 'smart',
      defaultModel: 'gpt-4',
      rules: [{ condition: 'topic', value: 'coding', model: 'claude-3' }],
    };
    const result = validateModelModeConfig(config);
    expect(result?.mode).toBe('smart');
    expect(result?.rules).toHaveLength(1);
  });

  test('validates prioritised mode with priorities', () => {
    const config = {
      mode: 'prioritised',
      defaultModel: 'gpt-4',
      priorities: [{ model: 'gpt-4' }, { model: 'claude-3' }],
    };
    const result = validateModelModeConfig(config);
    expect(result?.mode).toBe('prioritised');
    expect(result?.priorities).toHaveLength(2);
  });

  test('returns null for missing defaultModel', () => {
    const config = { mode: 'default' };
    expect(validateModelModeConfig(config)).toBeNull();
  });

  test('returns null for invalid input', () => {
    expect(validateModelModeConfig(null)).toBeNull();
    expect(validateModelModeConfig('string')).toBeNull();
  });
});

describe('sanitizeModelModeConfig', () => {
  test('sanitizes valid config', () => {
    const config = {
      mode: 'smart',
      defaultModel: 'gpt-4',
      rules: [{ condition: 'topic', value: 'coding', model: 'claude-3' }],
    };
    const result = sanitizeModelModeConfig(config);
    expect(result).toEqual({
      mode: 'smart',
      defaultModel: 'gpt-4',
      rules: [{ condition: 'topic', value: 'coding', model: 'claude-3' }],
    });
  });

  test('returns undefined for empty config', () => {
    expect(sanitizeModelModeConfig({})).toBeUndefined();
    expect(sanitizeModelModeConfig(null)).toBeUndefined();
  });

  test('only includes valid fields', () => {
    const config = {
      mode: 'default',
      defaultModel: '  gpt-4  ',
      invalid: 'field',
    };
    const result = sanitizeModelModeConfig(config);
    expect(result).toEqual({ mode: 'default', defaultModel: 'gpt-4' });
  });
});
