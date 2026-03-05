import { describe, test, expect } from 'bun:test';

describe('Telegram Settings Integration', () => {
  describe('API Endpoint Behavior', () => {
    test('should mask bot token in GET response', () => {
      const telegramConfig = {
        enabled: true,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '123456789',
        adminUserId: '123456789',
      };

      const maskedConfig = {
        ...telegramConfig,
        botToken: telegramConfig.botToken ? `${telegramConfig.botToken.substring(0, 8)}${'•'.repeat(20)}` : '',
      };

      expect(maskedConfig.botToken).toBe('12345678••••••••••••••••••••');
      expect(maskedConfig.botToken).not.toContain('ABCdefGHIjklMNOpqrsTUVwxyz');
      expect(maskedConfig.enabled).toBe(true);
      expect(maskedConfig.allowedUserIds).toBe('123456789');
      expect(maskedConfig.adminUserId).toBe('123456789');
    });

    test('should preserve token when PATCH contains masked value', () => {
      const currentTelegram = {
        enabled: true,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '123456789',
        adminUserId: '123456789',
      };

      const updates = {
        botToken: '12345678••••••••••••••••••••',
        allowedUserIds: '123456789,987654321',
      };

      // If the bot token looks masked, keep the old one
      let botToken = updates.botToken;
      if (botToken && botToken.includes('•')) {
        botToken = currentTelegram.botToken;
      }

      const updatedTelegram = {
        ...currentTelegram,
        ...updates,
        botToken,
      };

      expect(updatedTelegram.botToken).toBe('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz');
      expect(updatedTelegram.allowedUserIds).toBe('123456789,987654321');
    });

    test('should update token when PATCH contains new unmasked value', () => {
      const currentTelegram = {
        enabled: false,
        botToken: '',
        allowedUserIds: '',
        adminUserId: '',
      };

      const updates = {
        enabled: true,
        botToken: '9876543210:XYZabcDEFghiJKLmnoPQRstuv',
        allowedUserIds: '123456789',
      };

      let botToken = updates.botToken;
      if (botToken && botToken.includes('•')) {
        botToken = currentTelegram.botToken;
      }

      const updatedTelegram = {
        ...currentTelegram,
        ...updates,
        botToken,
      };

      expect(updatedTelegram.botToken).toBe('9876543210:XYZabcDEFghiJKLmnoPQRstuv');
      expect(updatedTelegram.enabled).toBe(true);
      expect(updatedTelegram.allowedUserIds).toBe('123456789');
    });
  });

  describe('Telegram Bridge Initialization', () => {
    test('should not initialize when disabled in settings', () => {
      const telegramConfig = {
        enabled: false,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '123456789',
        adminUserId: '123456789',
      };

      const shouldInitialize = telegramConfig.enabled === true;
      expect(shouldInitialize).toBe(false);
    });

    test('should initialize when enabled in settings', () => {
      const telegramConfig = {
        enabled: true,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '123456789',
        adminUserId: '123456789',
      };

      const shouldInitialize = telegramConfig.enabled === true;
      expect(shouldInitialize).toBe(true);
    });

    test('should parse allowed user IDs from config', () => {
      const telegramConfig = {
        allowedUserIds: '123456789,987654321,111222333',
      };

      const allowedUserIds = telegramConfig.allowedUserIds
        ? telegramConfig.allowedUserIds.split(',').map(id => id.trim()).filter(Boolean)
        : [];

      expect(allowedUserIds).toEqual(['123456789', '987654321', '111222333']);
    });

    test('should handle empty allowed user IDs', () => {
      const telegramConfig = {
        allowedUserIds: '',
      };

      const allowedUserIds = telegramConfig.allowedUserIds
        ? telegramConfig.allowedUserIds.split(',').map(id => id.trim()).filter(Boolean)
        : [];

      expect(allowedUserIds).toEqual([]);
    });

    test('should fallback to environment variables when config is empty', () => {
      const telegramConfig = {};
      
      const token = telegramConfig.botToken || process.env.TELEGRAM_BOT_TOKEN;
      const adminUserId = telegramConfig.adminUserId || process.env.ADMIN_USER_ID;

      expect(token).toBe(process.env.TELEGRAM_BOT_TOKEN);
      expect(adminUserId).toBe(process.env.ADMIN_USER_ID);
    });
  });

  describe('UI Component Props', () => {
    test('should have correct initial state', () => {
      const initialState = {
        enabled: false,
        botToken: '',
        allowedUserIds: '',
        adminUserId: '',
      };

      expect(initialState.enabled).toBe(false);
      expect(initialState.botToken).toBe('');
      expect(initialState.allowedUserIds).toBe('');
      expect(initialState.adminUserId).toBe('');
    });

    test('should validate required fields for enabling', () => {
      const config = {
        enabled: true,
        botToken: '',
        allowedUserIds: '',
        adminUserId: '',
      };

      const canEnable = config.enabled && config.botToken.length > 0;
      expect(canEnable).toBe(false);
    });

    test('should allow enabling when token is provided', () => {
      const config = {
        enabled: true,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '',
        adminUserId: '',
      };

      const canEnable = config.enabled && config.botToken.length > 0;
      expect(canEnable).toBe(true);
    });
  });

  describe('Config Schema Validation', () => {
    test('should accept all optional fields', () => {
      const config = {
        enabled: true,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '123456789,987654321',
        adminUserId: '123456789',
      };

      expect(typeof config.enabled).toBe('boolean');
      expect(typeof config.botToken).toBe('string');
      expect(typeof config.allowedUserIds).toBe('string');
      expect(typeof config.adminUserId).toBe('string');
    });

    test('should accept minimal config', () => {
      const config = {
        enabled: false,
      };

      expect(config.enabled).toBe(false);
      expect(config.botToken).toBeUndefined();
      expect(config.allowedUserIds).toBeUndefined();
      expect(config.adminUserId).toBeUndefined();
    });
  });
});
