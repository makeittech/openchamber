import { describe, it, expect, vi } from 'vitest';
import { createTelegramBot } from '../bot.js';

describe('bot', () => {
  describe('createTelegramBot', () => {
    it('should throw error without token', () => {
      expect(() => createTelegramBot({})).toThrow('TELEGRAM_BOT_TOKEN is required');
    });

    it('should create bot with token', () => {
      const mockSessionManager = {
        createSession: vi.fn(),
        getSession: vi.fn(),
        endSession: vi.fn()
      };

      const bot = createTelegramBot({
        token: 'test-token',
        sessionManager: mockSessionManager
      });

      expect(bot).toBeDefined();
    });

    it('should accept allowed user IDs', () => {
      const mockSessionManager = {
        createSession: vi.fn(),
        getSession: vi.fn(),
        endSession: vi.fn()
      };

      const bot = createTelegramBot({
        token: 'test-token',
        allowedUserIds: ['123', '456'],
        sessionManager: mockSessionManager
      });

      expect(bot).toBeDefined();
    });
  });
});
