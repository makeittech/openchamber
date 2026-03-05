import { describe, it, expect, beforeEach } from 'bun:test';
import {
  selectModel,
  executeWithFailover,
  getNextModel,
  isRetryableError
} from '../selector.js';

describe('Model Selector', () => {
  describe('selectModel', () => {
    describe('default mode', () => {
      it('should return default model in default mode', () => {
        const config = {
          mode: 'default',
          defaultModel: 'opencode/big-pickle'
        };
        
        expect(selectModel(config)).toBe('opencode/big-pickle');
      });

      it('should trim whitespace from default model', () => {
        const config = {
          mode: 'default',
          defaultModel: '  opencode/big-pickle  '
        };
        
        expect(selectModel(config)).toBe('opencode/big-pickle');
      });

      it('should return null for empty default model', () => {
        const config = {
          mode: 'default',
          defaultModel: '   '
        };
        
        expect(selectModel(config)).toBe(null);
      });

      it('should return null for missing default model', () => {
        const config = {
          mode: 'default'
        };
        
        expect(selectModel(config)).toBe(null);
      });
    });

    describe('smart mode', () => {
      it('should match topic with exact match', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: 'coding', model: 'coding-model' }
          ]
        };
        
        expect(selectModel(config, { topic: 'coding' })).toBe('coding-model');
      });

      it('should match topic case-insensitively', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: 'CODING', model: 'coding-model' }
          ]
        };
        
        expect(selectModel(config, { topic: 'coding' })).toBe('coding-model');
      });

      it('should match topic with prefix wildcard', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: 'code*', model: 'coding-model' }
          ]
        };
        
        expect(selectModel(config, { topic: 'code review' })).toBe('coding-model');
        expect(selectModel(config, { topic: 'programming' })).toBe('fallback');
      });

      it('should match topic with suffix wildcard', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: '*review', model: 'review-model' }
          ]
        };
        
        expect(selectModel(config, { topic: 'code review' })).toBe('review-model');
        expect(selectModel(config, { topic: 'review' })).toBe('review-model');
        expect(selectModel(config, { topic: 'coding' })).toBe('fallback');
      });

      it('should match topic with contains wildcard', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: '*code*', model: 'coding-model' }
          ]
        };
        
        expect(selectModel(config, { topic: 'my code review' })).toBe('coding-model');
        expect(selectModel(config, { topic: 'review' })).toBe('fallback');
      });

      it('should match time range within same day', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'time', value: '9-17', model: 'day-model' }
          ]
        };
        
        const dayTime = new Date('2024-01-01T12:00:00');
        const nightTime = new Date('2024-01-01T20:00:00');
        
        expect(selectModel(config, { time: dayTime })).toBe('day-model');
        expect(selectModel(config, { time: nightTime })).toBe('fallback');
      });

      it('should match time range spanning midnight', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'time', value: '22-6', model: 'night-model' }
          ]
        };
        
        const lateNight = new Date('2024-01-01T23:00:00');
        const earlyMorning = new Date('2024-01-01T03:00:00');
        const dayTime = new Date('2024-01-01T12:00:00');
        
        expect(selectModel(config, { time: lateNight })).toBe('night-model');
        expect(selectModel(config, { time: earlyMorning })).toBe('night-model');
        expect(selectModel(config, { time: dayTime })).toBe('fallback');
      });

      it('should match prompt prefix', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'promptPrefix', value: 'DEBUG:', model: 'debug-model' }
          ]
        };
        
        expect(selectModel(config, { promptPrefix: 'DEBUG: Fix this' })).toBe('debug-model');
        expect(selectModel(config, { promptPrefix: 'debug: something' })).toBe('debug-model');
        expect(selectModel(config, { promptPrefix: 'FEATURE:' })).toBe('fallback');
      });

      it('should match token count with operators', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'tokenCount', value: '<1000', model: 'small-model' },
            { condition: 'tokenCount', value: '>=1000', model: 'large-model' }
          ]
        };
        
        expect(selectModel(config, { tokenCount: 500 })).toBe('small-model');
        expect(selectModel(config, { tokenCount: 1000 })).toBe('large-model');
        expect(selectModel(config, { tokenCount: 5000 })).toBe('large-model');
      });

      it('should evaluate rules in order and return first match', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: 'urgent', model: 'fast-model' },
            { condition: 'topic', value: '*urgent*', model: 'backup-model' }
          ]
        };
        
        expect(selectModel(config, { topic: 'urgent' })).toBe('fast-model');
        expect(selectModel(config, { topic: 'urgent task' })).toBe('backup-model');
      });

      it('should return default when no rules match', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: [
            { condition: 'topic', value: 'coding', model: 'coding-model' }
          ]
        };
        
        expect(selectModel(config, { topic: 'writing' })).toBe('fallback');
      });

      it('should return default when no rules configured', () => {
        const config = {
          mode: 'smart',
          defaultModel: 'fallback',
          rules: []
        };
        
        expect(selectModel(config, { topic: 'coding' })).toBe('fallback');
      });
    });

    describe('prioritised mode', () => {
      it('should return first model in priority list', () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary-model' },
            { model: 'backup-model' }
          ]
        };
        
        expect(selectModel(config)).toBe('primary-model');
      });

      it('should return default when no priorities configured', () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: []
        };
        
        expect(selectModel(config)).toBe('fallback');
      });

      it('should return null when first priority is invalid', () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: '' },
            { model: 'backup-model' }
          ]
        };
        
        expect(selectModel(config)).toBe('fallback');
      });
    });

    describe('edge cases', () => {
      it('should return null for null config', () => {
        expect(selectModel(null)).toBe(null);
      });

      it('should return null for undefined config', () => {
        expect(selectModel(undefined)).toBe(null);
      });

      it('should return default model for unknown mode', () => {
        const config = {
          mode: 'unknown',
          defaultModel: 'fallback'
        };
        
        expect(selectModel(config)).toBe('fallback');
      });

      it('should handle missing mode gracefully', () => {
        const config = {
          defaultModel: 'fallback'
        };
        
        expect(selectModel(config)).toBe('fallback');
      });
    });
  });

  describe('executeWithFailover', () => {
    describe('default mode', () => {
      it('should execute with selected model', async () => {
        const config = {
          mode: 'default',
          defaultModel: 'test-model'
        };
        
        const executor = async (model) => {
          return { usedModel: model };
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(true);
        expect(result.model).toBe('test-model');
        expect(result.result.usedModel).toBe('test-model');
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].model).toBe('test-model');
        expect(result.attempts[0].success).toBe(true);
      });

      it('should fail when no valid model', async () => {
        const config = {
          mode: 'default',
          defaultModel: ''
        };
        
        const executor = async () => ({});
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(false);
        expect(result.error).toBe('No valid model selected');
      });

      it('should handle executor errors', async () => {
        const config = {
          mode: 'default',
          defaultModel: 'test-model'
        };
        
        const executor = async () => {
          throw new Error('API error');
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(false);
        expect(result.error).toBe('API error');
        expect(result.model).toBe('test-model');
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].success).toBe(false);
      });
    });

    describe('prioritised mode', () => {
      it('should try next model on error', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary', retryOn: ['error'] },
            { model: 'backup' }
          ]
        };
        
        let callCount = 0;
        const executor = async (model) => {
          callCount++;
          if (model === 'primary') {
            throw new Error('Primary failed');
          }
          return { usedModel: model };
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(true);
        expect(result.model).toBe('backup');
        expect(result.result.usedModel).toBe('backup');
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[0].model).toBe('primary');
        expect(result.attempts[0].success).toBe(false);
        expect(result.attempts[1].model).toBe('backup');
        expect(result.attempts[1].success).toBe(true);
      });

      it('should fail after exhausting all models', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'model1', retryOn: ['error'] },
            { model: 'model2', retryOn: ['error'] }
          ]
        };
        
        const executor = async () => {
          throw new Error('All models fail');
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(false);
        expect(result.error).toBe('All models fail');
        expect(result.attempts).toHaveLength(2);
      });

      it('should respect retryOn configuration', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary', retryOn: ['timeout'] },
            { model: 'backup' }
          ]
        };
        
        const executor = async () => {
          const error = new Error('API error');
          error.status = 500;
          throw error;
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(false);
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].model).toBe('primary');
      });

      it('should retry on timeout', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary', retryOn: ['timeout'] },
            { model: 'backup' }
          ]
        };
        
        let callCount = 0;
        const executor = async (model) => {
          callCount++;
          if (model === 'primary') {
            const error = new Error('Timeout');
            error.name = 'TimeoutError';
            throw error;
          }
          return { usedModel: model };
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(true);
        expect(result.model).toBe('backup');
        expect(result.attempts).toHaveLength(2);
      });

      it('should retry on rate limit (429)', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary', retryOn: ['rateLimit'] },
            { model: 'backup' }
          ]
        };
        
        let callCount = 0;
        const executor = async (model) => {
          callCount++;
          if (model === 'primary') {
            const error = new Error('Rate limited');
            error.status = 429;
            throw error;
          }
          return { usedModel: model };
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(true);
        expect(result.model).toBe('backup');
        expect(result.attempts).toHaveLength(2);
      });

      it('should not retry on 4xx (non-429)', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary', retryOn: ['error'] },
            { model: 'backup' }
          ]
        };
        
        const executor = async () => {
          const error = new Error('Bad request');
          error.status = 400;
          throw error;
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(false);
        expect(result.attempts).toHaveLength(1);
      });

      it('should use model-specific timeout', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: [
            { model: 'primary', timeout: 100 }
          ]
        };
        
        const executor = async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return {};
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(false);
        expect(result.error).toContain('timeout');
      }, 10000);

      it('should fall back to default model when no priorities', async () => {
        const config = {
          mode: 'prioritised',
          defaultModel: 'fallback',
          priorities: []
        };
        
        const executor = async (model) => ({ usedModel: model });
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(true);
        expect(result.model).toBe('fallback');
      });
    });

    describe('timeout handling', () => {
      it('should timeout long-running requests', async () => {
        const config = {
          mode: 'default',
          defaultModel: 'test-model'
        };
        
        const executor = async () => {
          await new Promise(resolve => setTimeout(resolve, 10000));
          return {};
        };
        
        const result = await executeWithFailover(config, {}, executor, { timeout: 100 });
        
        expect(result.success).toBe(false);
        expect(result.error).toContain('timeout');
      }, 2000);

      it('should use default timeout when not specified', async () => {
        const config = {
          mode: 'default',
          defaultModel: 'test-model'
        };
        
        const executor = async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return {};
        };
        
        const result = await executeWithFailover(config, {}, executor);
        
        expect(result.success).toBe(true);
      }, 1000);
    });
  });

  describe('getNextModel', () => {
    it('should return next model in priority list', () => {
      const config = {
        mode: 'prioritised',
        priorities: [
          { model: 'model1' },
          { model: 'model2' },
          { model: 'model3' }
        ]
      };
      
      expect(getNextModel(config, 'model1')).toBe('model2');
      expect(getNextModel(config, 'model2')).toBe('model3');
    });

    it('should return null for last model', () => {
      const config = {
        mode: 'prioritised',
        priorities: [
          { model: 'model1' },
          { model: 'model2' }
        ]
      };
      
      expect(getNextModel(config, 'model2')).toBe(null);
    });

    it('should return null for unknown model', () => {
      const config = {
        mode: 'prioritised',
        priorities: [
          { model: 'model1' }
        ]
      };
      
      expect(getNextModel(config, 'unknown')).toBe(null);
    });

    it('should return null for non-prioritised mode', () => {
      const config = {
        mode: 'default',
        defaultModel: 'fallback'
      };
      
      expect(getNextModel(config, 'fallback')).toBe(null);
    });
  });

  describe('isRetryableError', () => {
    it('should return true for configured retryable errors', () => {
      const config = {
        mode: 'prioritised',
        priorities: [
          { model: 'test-model', retryOn: ['timeout', 'rateLimit'] }
        ]
      };
      
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      
      const rateLimitError = new Error('Rate limited');
      rateLimitError.status = 429;
      
      expect(isRetryableError(config, 'test-model', timeoutError)).toBe(true);
      expect(isRetryableError(config, 'test-model', rateLimitError)).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      const config = {
        mode: 'prioritised',
        priorities: [
          { model: 'test-model', retryOn: ['timeout'] }
        ]
      };
      
      const error = new Error('API error');
      error.status = 500;
      
      expect(isRetryableError(config, 'test-model', error)).toBe(false);
    });

    it('should return false for unknown model', () => {
      const config = {
        mode: 'prioritised',
        priorities: [
          { model: 'test-model', retryOn: ['error'] }
        ]
      };
      
      const error = new Error('Error');
      
      expect(isRetryableError(config, 'unknown-model', error)).toBe(false);
    });

    it('should return false for non-prioritised mode', () => {
      const config = {
        mode: 'default',
        defaultModel: 'test-model'
      };
      
      const error = new Error('Error');
      
      expect(isRetryableError(config, 'test-model', error)).toBe(false);
    });
  });
});
