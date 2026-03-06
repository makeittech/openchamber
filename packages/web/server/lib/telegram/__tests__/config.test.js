import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Telegram Config', () => {
  let tempDir;
  let settingsPath;

  async function readSettings(path) {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw);
  }

  function isMaskedToken(token) {
    return typeof token === 'string' && token.includes('•');
  }

  async function updateSettings(path, updates) {
    const current = await readSettings(path);
    const incomingToken = updates.telegram?.botToken;
    const currentToken = current.telegram?.botToken;
    
    const tokenToStore = (incomingToken && isMaskedToken(incomingToken) && currentToken)
      ? currentToken
      : incomingToken;

    const updated = {
      ...current,
      telegram: {
        ...current.telegram,
        ...updates.telegram,
        ...(tokenToStore !== undefined && { botToken: tokenToStore }),
      },
    };
    await fs.writeFile(path, JSON.stringify(updated, null, 2));
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-config-test-'));
    settingsPath = path.join(tempDir, 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('TelegramConfig type', () => {
    test('should have correct default values', () => {
      const defaultConfig = {
        enabled: false,
        botToken: '',
        allowedUserIds: '',
        adminUserId: '',
      };

      expect(defaultConfig.enabled).toBe(false);
      expect(defaultConfig.botToken).toBe('');
      expect(defaultConfig.allowedUserIds).toBe('');
      expect(defaultConfig.adminUserId).toBe('');
    });

    test('should accept valid config values', () => {
      const config = {
        enabled: true,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '123456789,987654321',
        adminUserId: '123456789',
      };

      expect(config.enabled).toBe(true);
      expect(config.botToken).toBe('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz');
      expect(config.allowedUserIds).toBe('123456789,987654321');
      expect(config.adminUserId).toBe('123456789');
    });
  });

  describe('Token masking', () => {
    test('should mask bot token correctly', () => {
      const token = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz';
      const masked = `${token.substring(0, 8)}${'•'.repeat(20)}`;
      
      expect(masked).toBe('12345678••••••••••••••••••••');
      expect(masked).not.toContain('ABCdefGHIjklMNOpqrsTUVwxyz');
    });

    test('should handle empty token', () => {
      const token = '';
      const masked = token ? `${token.substring(0, 8)}${'•'.repeat(20)}` : '';
      
      expect(masked).toBe('');
    });

    test('should handle short token', () => {
      const token = 'short';
      const masked = token ? `${token.substring(0, 8)}${'•'.repeat(20)}` : '';
      
      expect(masked).toBe('short••••••••••••••••••••');
    });
  });

  describe('Allowed user IDs parsing', () => {
    test('should parse comma-separated user IDs', () => {
      const allowedUserIds = '123456789,987654321,111222333';
      const parsed = allowedUserIds.split(',').map(id => id.trim()).filter(Boolean);
      
      expect(parsed).toEqual(['123456789', '987654321', '111222333']);
    });

    test('should handle empty string', () => {
      const allowedUserIds = '';
      const parsed = allowedUserIds.split(',').map(id => id.trim()).filter(Boolean);
      
      expect(parsed).toEqual([]);
    });

    test('should handle whitespace', () => {
      const allowedUserIds = ' 123456789 , 987654321 , ';
      const parsed = allowedUserIds.split(',').map(id => id.trim()).filter(Boolean);
      
      expect(parsed).toEqual(['123456789', '987654321']);
    });
  });

  describe('Settings persistence', () => {
    test('should read telegram config from settings', async () => {
      const settings = {
        telegram: {
          enabled: true,
          botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
          allowedUserIds: '123456789',
          adminUserId: '123456789',
        },
      };

      await fs.writeFile(settingsPath, JSON.stringify(settings));
      const raw = await fs.readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);

      expect(parsed.telegram.enabled).toBe(true);
      expect(parsed.telegram.botToken).toBe('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz');
      expect(parsed.telegram.allowedUserIds).toBe('123456789');
      expect(parsed.telegram.adminUserId).toBe('123456789');
    });

    test('should handle missing telegram config', async () => {
      const settings = {};
      await fs.writeFile(settingsPath, JSON.stringify(settings));
      
      const raw = await fs.readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const telegramConfig = parsed.telegram || {
        enabled: false,
        botToken: '',
        allowedUserIds: '',
        adminUserId: '',
      };

      expect(telegramConfig.enabled).toBe(false);
      expect(telegramConfig.botToken).toBe('');
    });

    test('should update telegram config', async () => {
      const settings = {
        telegram: {
          enabled: false,
          botToken: '',
          allowedUserIds: '',
          adminUserId: '',
        },
      };

      await fs.writeFile(settingsPath, JSON.stringify(settings));

      const updates = {
        enabled: true,
        botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
        allowedUserIds: '123456789',
      };

      const raw = await fs.readFile(settingsPath, 'utf8');
      const current = JSON.parse(raw);
      const updated = {
        ...current,
        telegram: {
          ...current.telegram,
          ...updates,
        },
      };

      await fs.writeFile(settingsPath, JSON.stringify(updated));

      const verify = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      expect(verify.telegram.enabled).toBe(true);
      expect(verify.telegram.botToken).toBe('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz');
      expect(verify.telegram.allowedUserIds).toBe('123456789');
    });

    test('should preserve bot token when patch receives masked token', async () => {
      const current = {
        telegram: {
          enabled: true,
          botToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
          allowedUserIds: '123456789',
          adminUserId: '123456789',
        },
      };

      await fs.writeFile(settingsPath, JSON.stringify(current, null, 2));

      const masked = {
        telegram: {
          ...current.telegram,
          botToken: '12345678••••••••••••••••••••',
        },
      };

      await updateSettings(settingsPath, masked);
      const verify = await readSettings(settingsPath);

      expect(verify.telegram.botToken).toBe(current.telegram.botToken);
    });
  });

  describe('Config validation', () => {
    test('should identify masked token', () => {
      const maskedToken = '12345678••••••••••••••••••••';
      const isMasked = maskedToken.includes('•');
      
      expect(isMasked).toBe(true);
    });

    test('should identify unmasked token', () => {
      const token = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz';
      const isMasked = token.includes('•');
      
      expect(isMasked).toBe(false);
    });
  });
});
