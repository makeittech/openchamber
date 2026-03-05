/**
 * Model Selector with smart rules and prioritised failover
 * 
 * Supports three modes:
 * - default: Use configured default model
 * - smart: Evaluate rules against context, first match wins
 * - prioritised: Try models in priority order with failover on errors
 */

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_RETRIES = 10;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

/**
 * Select model based on configuration and context
 * @param {Object} config - ModelModeConfig
 * @param {string} config.mode - 'default' | 'smart' | 'prioritised'
 * @param {string} config.defaultModel - Default model ID
 * @param {Array} [config.rules] - Rules for smart mode
 * @param {Array} [config.priorities] - Priority list for prioritised mode
 * @param {Object} [context] - Selection context
 * @param {string} [context.topic] - Current topic
 * @param {Date} [context.time] - Current time
 * @param {string} [context.promptPrefix] - Prompt prefix
 * @param {number} [context.tokenCount] - Token count
 * @param {string} [context.session] - Session ID
 * @returns {string|null} Selected model ID or null if invalid config
 */
export function selectModel(config, context = {}) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  const mode = config.mode || 'default';
  const defaultModel = config.defaultModel;

  if (mode === 'default') {
    return typeof defaultModel === 'string' && defaultModel.trim().length > 0 
      ? defaultModel.trim() 
      : null;
  }

  if (mode === 'smart') {
    return selectModelByRules(config, context);
  }

  if (mode === 'prioritised') {
    return selectModelByPriority(config, context);
  }

  return typeof defaultModel === 'string' && defaultModel.trim().length > 0 
    ? defaultModel.trim() 
    : null;
}

/**
 * Select model by evaluating smart rules
 */
function selectModelByRules(config, context) {
  const rules = Array.isArray(config.rules) ? config.rules : [];
  
  if (rules.length === 0) {
    return typeof config.defaultModel === 'string' && config.defaultModel.trim().length > 0
      ? config.defaultModel.trim()
      : null;
  }

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    
    const { condition, value, model } = rule;
    
    if (!condition || typeof value !== 'string' || typeof model !== 'string') {
      continue;
    }

    if (evaluateCondition(condition, value, context)) {
      return model.trim();
    }
  }

  return typeof config.defaultModel === 'string' && config.defaultModel.trim().length > 0
    ? config.defaultModel.trim()
    : null;
}

/**
 * Evaluate a single condition against context
 */
function evaluateCondition(condition, value, context) {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return false;
  }

  switch (condition) {
    case 'topic':
      return evaluateTopicCondition(trimmedValue, context.topic);
    
    case 'time':
      return evaluateTimeCondition(trimmedValue, context.time);
    
    case 'promptPrefix':
      return evaluatePromptPrefixCondition(trimmedValue, context.promptPrefix);
    
    case 'tokenCount':
      return evaluateTokenCountCondition(trimmedValue, context.tokenCount);
    
    default:
      return false;
  }
}

function evaluateTopicCondition(pattern, topic) {
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    return false;
  }
  
  const lowerPattern = pattern.toLowerCase();
  const lowerTopic = topic.toLowerCase();
  
  if (lowerPattern.startsWith('*') && lowerPattern.endsWith('*')) {
    const searchTerm = lowerPattern.slice(1, -1);
    return searchTerm.length > 0 && lowerTopic.includes(searchTerm);
  }
  
  if (lowerPattern.startsWith('*')) {
    const suffix = lowerPattern.slice(1);
    return suffix.length > 0 && lowerTopic.endsWith(suffix);
  }
  
  if (lowerPattern.endsWith('*')) {
    const prefix = lowerPattern.slice(0, -1);
    return prefix.length > 0 && lowerTopic.startsWith(prefix);
  }
  
  return lowerTopic === lowerPattern;
}

function evaluateTimeCondition(pattern, time) {
  const targetTime = time instanceof Date ? time : new Date();
  
  if (isNaN(targetTime.getTime())) {
    return false;
  }
  
  try {
    const parts = pattern.split('-');
    if (parts.length !== 2) {
      return false;
    }
    
    const startHour = parseInt(parts[0], 10);
    const endHour = parseInt(parts[1], 10);
    
    if (isNaN(startHour) || isNaN(endHour)) {
      return false;
    }
    
    const currentHour = targetTime.getHours();
    
    if (startHour <= endHour) {
      return currentHour >= startHour && currentHour <= endHour;
    } else {
      return currentHour >= startHour || currentHour <= endHour;
    }
  } catch {
    return false;
  }
}

function evaluatePromptPrefixCondition(pattern, promptPrefix) {
  if (typeof promptPrefix !== 'string' || promptPrefix.trim().length === 0) {
    return false;
  }
  
  return promptPrefix.toLowerCase().startsWith(pattern.toLowerCase());
}

function evaluateTokenCountCondition(pattern, tokenCount) {
  if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount)) {
    return false;
  }
  
  const operator = pattern.match(/^(<=?|>=?|=)/)?.[0] || '';
  const valueStr = pattern.replace(/^(<=?|>=?|=)/, '').trim();
  const threshold = parseInt(valueStr, 10);
  
  if (isNaN(threshold)) {
    return false;
  }
  
  switch (operator) {
    case '<':
      return tokenCount < threshold;
    case '<=':
      return tokenCount <= threshold;
    case '>':
      return tokenCount > threshold;
    case '>=':
      return tokenCount >= threshold;
    case '=':
    case '':
      return tokenCount === threshold;
    default:
      return false;
  }
}

/**
 * Select model by priority (returns first in list)
 */
function selectModelByPriority(config, context) {
  const priorities = Array.isArray(config.priorities) ? config.priorities : [];
  
  if (priorities.length === 0) {
    return typeof config.defaultModel === 'string' && config.defaultModel.trim().length > 0
      ? config.defaultModel.trim()
      : null;
  }

  const firstPriority = priorities[0];
  if (!firstPriority || typeof firstPriority.model !== 'string') {
    return typeof config.defaultModel === 'string' && config.defaultModel.trim().length > 0
      ? config.defaultModel.trim()
      : null;
  }

  const model = firstPriority.model.trim();
  if (model.length === 0) {
    return typeof config.defaultModel === 'string' && config.defaultModel.trim().length > 0
      ? config.defaultModel.trim()
      : null;
  }

  return model;
}

/**
 * Execute request with prioritised failover
 * @param {Object} config - ModelModeConfig
 * @param {Object} context - Selection context
 * @param {Function} executor - Async function that takes model ID and returns response
 * @param {Object} [options] - Execution options
 * @param {number} [options.timeout] - Request timeout in ms
 * @returns {Promise<{success: boolean, model?: string, result?: any, error?: string, attempts?: Array}>}
 */
export async function executeWithFailover(config, context, executor, options = {}) {
  const timeout = typeof options.timeout === 'number' && options.timeout > 0 
    ? options.timeout 
    : DEFAULT_TIMEOUT_MS;
  
  const mode = config?.mode || 'default';
  
  if (mode !== 'prioritised') {
    const selectedModel = selectModel(config, context);
    if (!selectedModel) {
      return {
        success: false,
        error: 'No valid model selected',
        attempts: []
      };
    }
    
    try {
      const result = await executeWithTimeout(selectedModel, executor, timeout);
      return {
        success: true,
        model: selectedModel,
        result,
        attempts: [{ model: selectedModel, success: true }]
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Request failed',
        model: selectedModel,
        attempts: [{ model: selectedModel, success: false, error: error.message }]
      };
    }
  }

  const priorities = Array.isArray(config.priorities) ? config.priorities : [];
  
  if (priorities.length === 0) {
    const fallbackModel = config.defaultModel;
    if (!fallbackModel) {
      return {
        success: false,
        error: 'No models configured for failover',
        attempts: []
      };
    }
    
    try {
      const result = await executeWithTimeout(fallbackModel, executor, timeout);
      return {
        success: true,
        model: fallbackModel,
        result,
        attempts: [{ model: fallbackModel, success: true }]
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Request failed',
        model: fallbackModel,
        attempts: [{ model: fallbackModel, success: false, error: error.message }]
      };
    }
  }

  const attempts = [];
  let lastError = null;
  
  for (let i = 0; i < Math.min(priorities.length, MAX_RETRIES); i++) {
    const priority = priorities[i];
    if (!priority || typeof priority.model !== 'string') {
      continue;
    }
    
    const model = priority.model.trim();
    const modelTimeout = typeof priority.timeout === 'number' && priority.timeout > 0
      ? priority.timeout
      : timeout;
    
    const retryOn = Array.isArray(priority.retryOn) ? priority.retryOn : ['error', 'timeout', 'rateLimit'];
    
    try {
      const result = await executeWithTimeout(model, executor, modelTimeout);
      attempts.push({ model, success: true });
      
      return {
        success: true,
        model,
        result,
        attempts
      };
    } catch (error) {
      lastError = error;
      const errorType = classifyError(error);
      attempts.push({ model, success: false, error: error.message, errorType });
      
      const shouldRetry = retryOn.includes(errorType) && i < priorities.length - 1;
      
      if (!shouldRetry) {
        break;
      }
      
      if (i < priorities.length - 1) {
        const backoffMs = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, i),
          BACKOFF_MAX_MS
        );
        await sleep(backoffMs);
      }
    }
  }
  
  return {
    success: false,
    error: lastError?.message || 'All models failed',
    attempts
  };
}

/**
 * Execute request with timeout
 */
async function executeWithTimeout(model, executor, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Request timeout after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
    
    Promise.resolve()
      .then(() => executor(model))
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Classify error type for retry decision
 */
function classifyError(error) {
  if (!error) {
    return 'error';
  }
  
  if (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
    return 'timeout';
  }
  
  if (error.status === 429 || error.code === 'RATE_LIMIT') {
    return 'rateLimit';
  }
  
  if (typeof error.status === 'number') {
    if (error.status >= 500) {
      return 'error';
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 429) {
      return 'permanent';
    }
  }
  
  return 'error';
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get next model in priority list (for manual failover control)
 */
export function getNextModel(config, currentModel, context = {}) {
  if (!config || config.mode !== 'prioritised') {
    return null;
  }
  
  const priorities = Array.isArray(config.priorities) ? config.priorities : [];
  const currentIndex = priorities.findIndex(
    (p) => p && typeof p.model === 'string' && p.model.trim() === currentModel
  );
  
  if (currentIndex === -1 || currentIndex >= priorities.length - 1) {
    return null;
  }
  
  const nextPriority = priorities[currentIndex + 1];
  return nextPriority && typeof nextPriority.model === 'string' 
    ? nextPriority.model.trim() 
    : null;
}

/**
 * Check if error is retryable based on model config
 */
export function isRetryableError(config, model, error) {
  if (!config || config.mode !== 'prioritised') {
    return false;
  }
  
  const priorities = Array.isArray(config.priorities) ? config.priorities : [];
  const priority = priorities.find(
    (p) => p && typeof p.model === 'string' && p.model.trim() === model
  );
  
  if (!priority) {
    return false;
  }
  
  const retryOn = Array.isArray(priority.retryOn) ? priority.retryOn : ['error', 'timeout', 'rateLimit'];
  const errorType = classifyError(error);
  
  return retryOn.includes(errorType);
}

export default {
  selectModel,
  executeWithFailover,
  getNextModel,
  isRetryableError
};
