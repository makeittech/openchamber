/**
 * Integration module for model selector in OpenChamber server
 * 
 * This module provides helper functions to use the model selector
 * for server-side API calls (e.g., Zen API for summarization).
 */

import { selectModel, executeWithFailover } from './selector.js';

/**
 * Get model mode configuration from settings
 * @param {Object} settings - Settings object from readSettingsFromDisk
 * @returns {Object|null} ModelModeConfig or null if not configured
 */
export function getModelModeConfig(settings) {
  if (!settings || typeof settings !== 'object') {
    return null;
  }

  const config = settings.modelModeConfig;
  if (!config || typeof config !== 'object') {
    return null;
  }

  return {
    mode: config.mode || 'default',
    defaultModel: config.defaultModel || null,
    rules: Array.isArray(config.rules) ? config.rules : undefined,
    priorities: Array.isArray(config.priorities) ? config.priorities : undefined
  };
}

/**
 * Select model for server-side operations
 * 
 * @param {Object} settings - Settings object from readSettingsFromDisk
 * @param {Object} [context] - Selection context
 * @returns {string|null} Selected model ID
 */
export function selectServerModel(settings, context = {}) {
  const config = getModelModeConfig(settings);
  
  if (!config) {
    return null;
  }
  
  return selectModel(config, context);
}

/**
 * Execute server operation with model selection and failover
 * 
 * @param {Object} settings - Settings object from readSettingsFromDisk
 * @param {Object} context - Selection context
 * @param {Function} executor - Async function that takes model ID and returns response
 * @param {Object} [options] - Execution options
 * @returns {Promise<{success: boolean, model?: string, result?: any, error?: string}>}
 */
export async function executeWithServerModel(settings, context, executor, options = {}) {
  const config = getModelModeConfig(settings);
  
  if (!config) {
    return {
      success: false,
      error: 'No model mode configuration found'
    };
  }
  
  return executeWithFailover(config, context, executor, options);
}

/**
 * Create context for server-side model selection
 * 
 * @param {Object} params - Context parameters
 * @param {string} [params.topic] - Current topic or operation type
 * @param {string} [params.promptPrefix] - Prompt prefix if any
 * @param {number} [params.tokenCount] - Token count if known
 * @param {string} [params.session] - Session ID
 * @returns {Object} Context object for model selector
 */
export function createServerContext(params = {}) {
  const context = {};
  
  if (typeof params.topic === 'string' && params.topic.trim().length > 0) {
    context.topic = params.topic.trim();
  }
  
  if (params.time instanceof Date) {
    context.time = params.time;
  } else {
    context.time = new Date();
  }
  
  if (typeof params.promptPrefix === 'string' && params.promptPrefix.trim().length > 0) {
    context.promptPrefix = params.promptPrefix.trim();
  }
  
  if (typeof params.tokenCount === 'number' && Number.isFinite(params.tokenCount) && params.tokenCount >= 0) {
    context.tokenCount = params.tokenCount;
  }
  
  if (typeof params.session === 'string' && params.session.trim().length > 0) {
    context.session = params.session.trim();
  }
  
  return context;
}

export default {
  getModelModeConfig,
  selectServerModel,
  executeWithServerModel,
  createServerContext
};
