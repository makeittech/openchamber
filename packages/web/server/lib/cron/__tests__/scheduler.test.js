import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CronScheduler, createCronScheduler } from '../scheduler.js';
import { JobStore } from '../job-store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CronScheduler', () => {
  let tempDir;
  let storePath;
  let jobStore;
  let scheduler;
  let mockFetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-scheduler-test-'));
    storePath = path.join(tempDir, 'jobs.json');
    jobStore = new JobStore(storePath);
    
    mockFetch = mock(() => {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
        json: () => Promise.resolve({ id: 'test-session' }),
      });
    });
    
    global.fetch = mockFetch;
    
    delete process.env.OPENCHAMBER_SKIP_CRON;
  });

  afterEach(async () => {
    if (scheduler) {
      scheduler.stop();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete global.fetch;
  });

  describe('start', () => {
    it('should skip when OPENCHAMBER_SKIP_CRON=1', async () => {
      process.env.OPENCHAMBER_SKIP_CRON = '1';
      
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
      
      await scheduler.start();
      expect(scheduler.running).toBe(false);
    });

    it('should load jobs and start scheduler', async () => {
      await jobStore.load();
      await jobStore.add({
        name: 'Test Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      });
      
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
      
      await scheduler.start();
      expect(scheduler.running).toBe(true);
      expect(scheduler.cronJobs.size).toBe(1);
    });

    it('should not schedule disabled jobs', async () => {
      await jobStore.load();
      await jobStore.add({
        name: 'Disabled Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: false,
      });
      
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
      
      await scheduler.start();
      expect(scheduler.cronJobs.size).toBe(0);
    });
  });

  describe('stop', () => {
    it('should stop scheduler and clear cron jobs', async () => {
      await jobStore.load();
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
      
      await scheduler.start();
      scheduler.stop();
      
      expect(scheduler.running).toBe(false);
      expect(scheduler.cronJobs.size).toBe(0);
    });
  });

  describe('scheduleJob', () => {
    beforeEach(async () => {
      await jobStore.load();
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
    });

    it('should schedule cron job', async () => {
      const job = {
        jobId: 'test-cron',
        name: 'Cron Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: true,
      };
      
      scheduler.scheduleJob(job);
      expect(scheduler.cronJobs.has('test-cron')).toBe(true);
    });

    it('should schedule every job', async () => {
      const job = {
        jobId: 'test-every',
        name: 'Every Job',
        schedule: { kind: 'every', everyMs: 60000 },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: true,
      };
      
      scheduler.scheduleJob(job);
      expect(scheduler.cronJobs.has('test-every')).toBe(true);
    });

    it('should schedule one-time at job', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const job = {
        jobId: 'test-at',
        name: 'At Job',
        schedule: { kind: 'at', at: futureDate },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: true,
      };
      
      scheduler.scheduleJob(job);
      expect(scheduler.cronJobs.has('test-at')).toBe(true);
    });

    it('should skip past at jobs', async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      const job = {
        jobId: 'test-past',
        name: 'Past Job',
        schedule: { kind: 'at', at: pastDate },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: true,
      };
      
      scheduler.scheduleJob(job);
      expect(scheduler.cronJobs.has('test-past')).toBe(false);
    });
  });

  describe('unscheduleJob', () => {
    beforeEach(async () => {
      await jobStore.load();
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
    });

    it('should remove scheduled job', async () => {
      const job = {
        jobId: 'to-remove',
        name: 'Remove Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: true,
      };
      
      scheduler.scheduleJob(job);
      expect(scheduler.cronJobs.has('to-remove')).toBe(true);
      
      scheduler.unscheduleJob('to-remove');
      expect(scheduler.cronJobs.has('to-remove')).toBe(false);
    });
  });

  describe('rescheduleJob', () => {
    beforeEach(async () => {
      await jobStore.load();
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
    });

    it('should replace existing schedule', async () => {
      const job = {
        jobId: 'reschedule-test',
        name: 'Reschedule Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: true,
      };
      
      scheduler.scheduleJob(job);
      
      const updatedJob = {
        ...job,
        schedule: { kind: 'cron', expr: '0 0 * * * *' },
      };
      
      scheduler.rescheduleJob(updatedJob);
      expect(scheduler.cronJobs.has('reschedule-test')).toBe(true);
    });
  });

  describe('executeJob', () => {
    it('should call OpenCode API for isolated job', async () => {
      await jobStore.load();
      
      let fetchCalled = false;
      mockFetch.mockImplementation((url, options) => {
        fetchCalled = true;
        if (url.includes('/session')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve('OK'),
            json: () => Promise.resolve({ id: 'test-session-id' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('OK'),
        });
      });
      
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        createIsolatedSession: async () => ({ id: 'isolated-session' }),
      });
      
      const job = {
        jobId: 'execute-test',
        name: 'Execute Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test message' },
        enabled: true,
      };
      
      await scheduler.executeJob(job);
      
      expect(fetchCalled).toBe(true);
      expect(scheduler.runHistory.length).toBe(1);
      expect(scheduler.runHistory[0].success).toBe(true);
    });

    it('should record failed runs', async () => {
      await jobStore.load();
      
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });
      });
      
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        createIsolatedSession: async () => ({ id: 'isolated-session' }),
      });
      
      const job = {
        jobId: 'fail-test',
        name: 'Fail Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
        enabled: true,
      };
      
      await scheduler.executeJob(job);
      
      expect(scheduler.runHistory.length).toBe(1);
      expect(scheduler.runHistory[0].success).toBe(false);
      expect(scheduler.runHistory[0].error).toBeDefined();
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await jobStore.load();
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
    });

    it('should return scheduler stats', async () => {
      await scheduler.start();
      
      const stats = scheduler.getStats();
      expect(stats.running).toBe(true);
      expect(stats.scheduledCount).toBe(0);
      expect(stats.activeRuns).toBe(0);
    });
  });

  describe('getRunHistory', () => {
    beforeEach(async () => {
      await jobStore.load();
      scheduler = createCronScheduler(jobStore, {
        buildOpenCodeUrl: (path) => `http://localhost:3000${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        createIsolatedSession: async () => ({ id: 'test' }),
      });
    });

    it('should return run history', async () => {
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true, text: () => Promise.resolve('OK') }));
      
      const job = {
        jobId: 'history-test',
        name: 'History Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      };
      
      await scheduler.executeJob(job);
      
      const history = scheduler.getRunHistory();
      expect(history.length).toBe(1);
      expect(history[0].jobId).toBe('history-test');
    });

    it('should limit history results', async () => {
      mockFetch.mockImplementation(() => Promise.resolve({ ok: true, text: () => Promise.resolve('OK') }));
      
      const job = {
        jobId: 'limit-test',
        name: 'Limit Job',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      };
      
      for (let i = 0; i < 10; i++) {
        await scheduler.executeJob(job);
      }
      
      const history = scheduler.getRunHistory(5);
      expect(history.length).toBe(5);
    });
  });
});
