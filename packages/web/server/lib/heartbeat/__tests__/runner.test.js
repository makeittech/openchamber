import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { HeartbeatRunner, createHeartbeatRunner } from '../runner.js';

describe('HeartbeatRunner', () => {
  let runner;
  let mockFetch;
  let mockGetConfig;

  beforeEach(() => {
    mockFetch = mock(() => {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('HEARTBEAT_OK'),
      });
    });

    global.fetch = mockFetch;

    mockGetConfig = mock(() => ({
      every: '30m',
      prompt: 'Test prompt',
      target: 'none',
    }));

    delete process.env.OPENCHAMBER_SKIP_HEARTBEAT;
  });

  afterEach(async () => {
    if (runner) {
      runner.stop();
    }
    delete global.fetch;
  });

  describe('start', () => {
    it('should skip when OPENCHAMBER_SKIP_HEARTBEAT=1', async () => {
      process.env.OPENCHAMBER_SKIP_HEARTBEAT = '1';

      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      await runner.start();
      expect(runner.running).toBe(false);
    });

    it('should start runner with interval', async () => {
      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      await runner.start();
      expect(runner.running).toBe(true);
      expect(runner.heartbeatInterval).toBeDefined();
    });

    it('should disable when every is "0m"', async () => {
      mockGetConfig = mock(() => ({
        every: '0m',
      }));

      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      await runner.start();
      expect(runner.running).toBe(true);
      expect(runner.heartbeatInterval).toBeNull();
    });
  });

  describe('stop', () => {
    it('should stop runner and clear interval', async () => {
      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      await runner.start();
      expect(runner.running).toBe(true);

      runner.stop();
      expect(runner.running).toBe(false);
      expect(runner.heartbeatInterval).toBeNull();
    });
  });

  describe('parseInterval', () => {
    it('should parse minutes', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseInterval('30m')).toBe(30 * 60 * 1000);
    });

    it('should parse hours', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseInterval('2h')).toBe(2 * 60 * 60 * 1000);
    });

    it('should parse seconds', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseInterval('90s')).toBe(90 * 1000);
    });

    it('should default to minutes if no unit', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseInterval('30')).toBe(30 * 60 * 1000);
    });

    it('should return 0 for "0m"', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseInterval('0m')).toBe(0);
    });

    it('should return default for invalid input', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseInterval('invalid')).toBe(30 * 60 * 1000);
    });
  });

  describe('parseTimeToMinutes', () => {
    it('should parse valid time', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseTimeToMinutes('09:00')).toBe(9 * 60);
      expect(runner.parseTimeToMinutes('17:30')).toBe(17 * 60 + 30);
    });

    it('should return null for invalid time', () => {
      runner = createHeartbeatRunner({});
      expect(runner.parseTimeToMinutes('25:00')).toBeNull();
      expect(runner.parseTimeToMinutes('09:60')).toBeNull();
      expect(runner.parseTimeToMinutes('invalid')).toBeNull();
    });
  });

  describe('isInActiveHours', () => {
    beforeEach(() => {
      runner = createHeartbeatRunner({});
    });

    it('should return true if no activeHours config', () => {
      expect(runner.isInActiveHours(null)).toBe(true);
      expect(runner.isInActiveHours(undefined)).toBe(true);
    });

    it('should return true if activeHours is missing start or end', () => {
      expect(runner.isInActiveHours({ start: '09:00' })).toBe(true);
      expect(runner.isInActiveHours({ end: '17:00' })).toBe(true);
    });

    it('should check if current time is within active hours', () => {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();

      const activeHoursBefore = {
        start: '00:00',
        end: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      };

      const activeHoursAfter = {
        start: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        end: '23:59',
      };

      expect(runner.isInActiveHours(activeHoursBefore)).toBe(true);
      expect(runner.isInActiveHours(activeHoursAfter)).toBe(true);
    });
  });

  describe('parseHeartbeatOk', () => {
    beforeEach(() => {
      runner = createHeartbeatRunner({});
    });

    it('should detect HEARTBEAT_OK at start', () => {
      expect(runner.parseHeartbeatOk('HEARTBEAT_OK')).toBe(true);
      expect(runner.parseHeartbeatOk('HEARTBEAT_OK something else')).toBe(true);
    });

    it('should detect HEARTBEAT_OK at end', () => {
      expect(runner.parseHeartbeatOk('something HEARTBEAT_OK')).toBe(true);
      expect(runner.parseHeartbeatOk('something else HEARTBEAT_OK')).toBe(true);
    });

    it('should detect HEARTBEAT_OK on its own line', () => {
      expect(runner.parseHeartbeatOk('some text\nHEARTBEAT_OK\nmore text')).toBe(true);
    });

    it('should return false if HEARTBEAT_OK is not present', () => {
      expect(runner.parseHeartbeatOk('something else')).toBe(false);
      expect(runner.parseHeartbeatOk('HEARTBEAT OK')).toBe(false);
      expect(runner.parseHeartbeatOk('heartbeat_ok')).toBe(false);
    });

    it('should return false for null or undefined', () => {
      expect(runner.parseHeartbeatOk(null)).toBe(false);
      expect(runner.parseHeartbeatOk(undefined)).toBe(false);
    });
  });

  describe('executeHeartbeat', () => {
    it('should send heartbeat prompt to main session', async () => {
      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      const record = await runner.executeHeartbeat({ prompt: 'Test prompt' });

      expect(record.success).toBe(true);
      expect(record.heartbeatOk).toBe(true);
      expect(mockFetch).toHaveBeenCalled();

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('http://localhost:3000/session/test-session/message');
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].body).toContain('Test prompt');
    });

    it('should throw error if no session available', async () => {
      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => null,
        getConfig: mockGetConfig,
      });

      const record = await runner.executeHeartbeat({});

      expect(record.success).toBe(false);
      expect(record.error).toContain('No main session available');
    });

    it('should handle API errors', async () => {
      mockFetch = mock(() => {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });
      });

      global.fetch = mockFetch;

      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      const record = await runner.executeHeartbeat({});

      expect(record.success).toBe(false);
      expect(record.error).toContain('500');
    });
  });

  describe('getStats', () => {
    it('should return runner stats', async () => {
      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      await runner.start();
      const stats = runner.getStats();

      expect(stats.running).toBe(true);
      expect(stats.lastHeartbeatTime).toBeNull();
      expect(stats.heartbeatHistoryCount).toBe(0);
    });
  });

  describe('getHeartbeatHistory', () => {
    it('should return heartbeat history', async () => {
      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      await runner.runHeartbeatNow();
      const history = runner.getHeartbeatHistory();

      expect(history.length).toBe(1);
      expect(history[0].success).toBe(true);
      expect(history[0].heartbeatOk).toBe(true);
    });

    it('should limit history results', async () => {
      runner = createHeartbeatRunner({
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSessionId: () => 'test-session',
        getConfig: mockGetConfig,
      });

      for (let i = 0; i < 10; i++) {
        await runner.runHeartbeatNow();
      }

      const history = runner.getHeartbeatHistory(5);
      expect(history.length).toBe(5);
    });
  });
});
