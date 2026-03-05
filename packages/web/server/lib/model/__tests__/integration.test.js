import { describe, it, expect } from 'bun:test';
import {
  getModelModeConfig,
  selectServerModel,
  executeWithServerModel,
  createServerContext
} from '../integration.js';

describe('Model Integration', () => {
  describe('getModelModeConfig', () => {
    it('should extract valid model mode config from settings', () => {
      const settings = {
        modelModeConfig: {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: 'coding', model: 'coding-model' }
          ]
        }
      };
      
      const config = getModelModeConfig(settings);
      
      expect(config.mode).toBe('smart');
      expect(config.defaultModel).toBe('fallback');
      expect(config.rules).toHaveLength(1);
    });

    it('should return null for missing config', () => {
      const settings = {};
      
      expect(getModelModeConfig(settings)).toBe(null);
    });

    it('should return null for invalid config', () => {
      const settings = {
        modelModeConfig: 'invalid'
      };
      
      expect(getModelModeConfig(settings)).toBe(null);
    });

    it('should default mode to default when not specified', () => {
      const settings = {
        modelModeConfig: {
          defaultModel: 'test'
        }
      };
      
      const config = getModelModeConfig(settings);
      
      expect(config.mode).toBe('default');
    });
  });

  describe('selectServerModel', () => {
    it('should select model from settings config', () => {
      const settings = {
        modelModeConfig: {
          mode: 'default',
          defaultModel: 'test-model'
        }
      };
      
      expect(selectServerModel(settings)).toBe('test-model');
    });

    it('should return null when no config', () => {
      expect(selectServerModel({})).toBe(null);
    });

    it('should use context for smart mode', () => {
      const settings = {
        modelModeConfig: {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: 'coding', model: 'coding-model' }
          ]
        }
      };
      
      expect(selectServerModel(settings, { topic: 'coding' })).toBe('coding-model');
      expect(selectServerModel(settings, { topic: 'other' })).toBe('fallback');
    });
  });

  describe('executeWithServerModel', () => {
    it('should execute with selected model', async () => {
      const settings = {
        modelModeConfig: {
          mode: 'default',
          defaultModel: 'test-model'
        }
      };
      
      const executor = async (model) => ({ usedModel: model });
      const result = await executeWithServerModel(settings, {}, executor);
      
      expect(result.success).toBe(true);
      expect(result.model).toBe('test-model');
      expect(result.result.usedModel).toBe('test-model');
    });

    it('should fail when no config', async () => {
      const executor = async () => ({});
      const result = await executeWithServerModel({}, {}, executor);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('No model mode configuration found');
    });

    it('should support failover in prioritised mode', async () => {
      const settings = {
        modelModeConfig: {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary', retryOn: ['error'] },
            { model: 'backup' }
          ]
        }
      };
      
      let callCount = 0;
      const executor = async (model) => {
        callCount++;
        if (model === 'primary') {
          throw new Error('Primary failed');
        }
        return { usedModel: model };
      };
      
      const result = await executeWithServerModel(settings, {}, executor);
      
      expect(result.success).toBe(true);
      expect(result.model).toBe('backup');
      expect(result.attempts).toHaveLength(2);
    });
  });

  describe('createServerContext', () => {
    it('should create context with all parameters', () => {
      const params = {
        topic: 'test topic',
        promptPrefix: 'DEBUG:',
        tokenCount: 1000,
        session: 'session-123'
      };
      
      const context = createServerContext(params);
      
      expect(context.topic).toBe('test topic');
      expect(context.promptPrefix).toBe('DEBUG:');
      expect(context.tokenCount).toBe(1000);
      expect(context.session).toBe('session-123');
      expect(context.time instanceof Date).toBe(true);
    });

    it('should use current time when not specified', () => {
      const before = Date.now();
      const context = createServerContext({});
      const after = Date.now();
      
      const contextTime = context.time.getTime();
      expect(contextTime).toBeGreaterThanOrEqual(before);
      expect(contextTime).toBeLessThanOrEqual(after);
    });

    it('should trim whitespace from string parameters', () => {
      const context = createServerContext({
        topic: '  test  ',
        promptPrefix: '  PREFIX  ',
        session: '  session  '
      });
      
      expect(context.topic).toBe('test');
      expect(context.promptPrefix).toBe('PREFIX');
      expect(context.session).toBe('session');
    });

    it('should ignore invalid parameters', () => {
      const context = createServerContext({
        topic: '',
        promptPrefix: '   ',
        tokenCount: -100,
        session: ''
      });
      
      expect(context.topic).toBeUndefined();
      expect(context.promptPrefix).toBeUndefined();
      expect(context.tokenCount).toBeUndefined();
      expect(context.session).toBeUndefined();
    });

    it('should handle empty params', () => {
      const context = createServerContext();
      
      expect(context.time instanceof Date).toBe(true);
      expect(Object.keys(context)).toHaveLength(1);
    });
  });
});
