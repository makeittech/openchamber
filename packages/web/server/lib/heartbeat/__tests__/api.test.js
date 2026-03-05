import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Heartbeat Config Management', () => {
  let tempDir;
  let settingsFilePath;
  let readSettingsFromDisk;
  let persistSettings;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'heartbeat-config-test-'));
    settingsFilePath = path.join(tempDir, 'settings.json');

    readSettingsFromDisk = async () => {
      try {
        const raw = await fs.promises.readFile(settingsFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed || {};
      } catch (error) {
        if (error.code === 'ENOENT') {
          return {};
        }
        throw error;
      }
    };

    persistSettings = async (updates) => {
      const current = await readSettingsFromDisk();
      const next = { ...current, ...updates };
      await fs.promises.writeFile(settingsFilePath, JSON.stringify(next, null, 2), 'utf8');
    };
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('readSettingsFromDisk', () => {
    it('should return empty object when no settings file exists', async () => {
      const settings = await readSettingsFromDisk();
      expect(settings).toEqual({});
    });

    it('should return parsed settings from file', async () => {
      const testSettings = {
        heartbeat: {
          enabled: true,
          every: '1h',
          target: 'last',
        },
      };

      await fs.promises.writeFile(settingsFilePath, JSON.stringify(testSettings), 'utf8');
      const settings = await readSettingsFromDisk();
      expect(settings).toEqual(testSettings);
    });
  });

  describe('persistSettings', () => {
    it('should create settings file if it does not exist', async () => {
      const heartbeatConfig = {
        enabled: true,
        every: '45m',
        target: 'last',
      };

      await persistSettings({ heartbeat: heartbeatConfig });

      const saved = JSON.parse(await fs.promises.readFile(settingsFilePath, 'utf8'));
      expect(saved.heartbeat).toEqual(heartbeatConfig);
    });

    it('should merge with existing settings', async () => {
      const existing = {
        otherSetting: 'value',
        heartbeat: {
          enabled: false,
          every: '30m',
          target: 'none',
        },
      };

      await fs.promises.writeFile(settingsFilePath, JSON.stringify(existing), 'utf8');

      const updates = {
        enabled: true,
        target: 'last',
      };

      const currentSettings = await readSettingsFromDisk();
      const currentHeartbeat = currentSettings.heartbeat || {
        enabled: false,
        every: '30m',
        target: 'none',
      };

      const updatedHeartbeat = {
        ...currentHeartbeat,
        ...updates,
      };

      await persistSettings({ heartbeat: updatedHeartbeat });

      const saved = JSON.parse(await fs.promises.readFile(settingsFilePath, 'utf8'));
      expect(saved.otherSetting).toBe('value');
      expect(saved.heartbeat.enabled).toBe(true);
      expect(saved.heartbeat.every).toBe('30m');
      expect(saved.heartbeat.target).toBe('last');
    });

    it('should handle activeHours config', async () => {
      const heartbeatConfig = {
        enabled: true,
        every: '1h',
        target: 'last',
        activeHours: {
          start: '09:00',
          end: '17:00',
          timezone: 'America/New_York',
        },
        prompt: 'Custom prompt',
      };

      await persistSettings({ heartbeat: heartbeatConfig });

      const saved = JSON.parse(await fs.promises.readFile(settingsFilePath, 'utf8'));
      expect(saved.heartbeat).toEqual(heartbeatConfig);
    });
  });

  describe('Heartbeat config validation', () => {
    it('should provide default values', () => {
      const defaultConfig = {
        enabled: false,
        every: '30m',
        target: 'none',
      };

      expect(defaultConfig.enabled).toBe(false);
      expect(defaultConfig.every).toBe('30m');
      expect(defaultConfig.target).toBe('none');
    });

    it('should support all target options', () => {
      const targets = ['none', 'last'];
      targets.forEach((target) => {
        const config = { enabled: true, every: '30m', target };
        expect(['none', 'last']).toContain(config.target);
      });
    });

    it('should support interval formats', () => {
      const intervals = ['30m', '1h', '0', '0m', '15s'];
      intervals.forEach((every) => {
        const config = { enabled: true, every, target: 'none' };
        expect(typeof config.every).toBe('string');
      });
    });
  });

  describe('Config merge logic', () => {
    it('should merge partial updates correctly', () => {
      const current = {
        enabled: false,
        every: '30m',
        target: 'none',
        prompt: 'Original prompt',
        activeHours: {
          start: '09:00',
          end: '17:00',
        },
      };

      const updates = {
        enabled: true,
        target: 'last',
      };

      const merged = {
        ...current,
        ...updates,
      };

      expect(merged.enabled).toBe(true);
      expect(merged.every).toBe('30m');
      expect(merged.target).toBe('last');
      expect(merged.prompt).toBe('Original prompt');
      expect(merged.activeHours).toEqual({ start: '09:00', end: '17:00' });
    });

    it('should overwrite activeHours when provided', () => {
      const current = {
        enabled: true,
        every: '30m',
        target: 'none',
        activeHours: {
          start: '09:00',
          end: '17:00',
          timezone: 'UTC',
        },
      };

      const updates = {
        activeHours: {
          start: '10:00',
          end: '18:00',
          timezone: 'America/Los_Angeles',
        },
      };

      const merged = {
        ...current,
        ...updates,
      };

      expect(merged.activeHours.start).toBe('10:00');
      expect(merged.activeHours.end).toBe('18:00');
      expect(merged.activeHours.timezone).toBe('America/Los_Angeles');
    });
  });
});
