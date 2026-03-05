import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { JobStore, createJobStore } from '../job-store.js';

describe('JobStore', () => {
  let tempDir;
  let storePath;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-test-'));
    storePath = path.join(tempDir, 'jobs.json');
    store = new JobStore(storePath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('should create empty store if file does not exist', async () => {
      await store.load();
      expect(store.list()).toEqual([]);
    });

    it('should load existing jobs from file', async () => {
      const jobs = [
        {
          jobId: 'test-1',
          name: 'Test Job',
          schedule: { kind: 'cron', expr: '0 * * * * *' },
          sessionTarget: 'isolated',
          payload: { kind: 'agentTurn', message: 'Test' },
        },
      ];
      fs.writeFileSync(storePath, JSON.stringify(jobs));

      await store.load();
      const loaded = store.list();
      expect(loaded.length).toBe(1);
      expect(loaded[0].jobId).toBe('test-1');
    });

    it('should skip invalid jobs', async () => {
      const jobs = [
        {
          jobId: 'valid-1',
          name: 'Valid Job',
          schedule: { kind: 'cron', expr: '0 * * * * *' },
          sessionTarget: 'isolated',
          payload: { kind: 'agentTurn', message: 'Test' },
        },
        { jobId: 'invalid-1' }, // Missing required fields
      ];
      fs.writeFileSync(storePath, JSON.stringify(jobs));

      await store.load();
      const loaded = store.list();
      expect(loaded.length).toBe(1);
      expect(loaded[0].jobId).toBe('valid-1');
    });
  });

  describe('add', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should add a valid job', async () => {
      const job = {
        name: 'New Job',
        schedule: { kind: 'every', everyMs: 60000 },
        sessionTarget: 'isolated',
        payload: { kind: 'systemEvent', text: 'Test event' },
      };

      const added = await store.add(job);
      expect(added.jobId).toBeDefined();
      expect(added.name).toBe('New Job');
      expect(added.enabled).toBe(true);
      expect(added.createdAt).toBeDefined();
      expect(added.updatedAt).toBeDefined();
    });

    it('should reject invalid job', async () => {
      const job = { name: 'Invalid' };

      expect(async () => {
        await store.add(job);
      }).toThrow();
    });

    it('should persist jobs to file', async () => {
      const job = {
        name: 'Persisted Job',
        schedule: { kind: 'cron', expr: '0 0 * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      };

      await store.add(job);

      const fileContent = fs.readFileSync(storePath, 'utf8');
      const saved = JSON.parse(fileContent);
      expect(saved.length).toBe(1);
      expect(saved[0].name).toBe('Persisted Job');
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should update existing job', async () => {
      const added = await store.add({
        name: 'Original',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      });

      const updated = await store.update(added.jobId, { name: 'Updated' });
      expect(updated.name).toBe('Updated');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(added.updatedAt);
    });

    it('should return null for non-existent job', async () => {
      const result = await store.update('non-existent', { name: 'Test' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should delete existing job', async () => {
      const added = await store.add({
        name: 'To Delete',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      });

      const deleted = await store.delete(added.jobId);
      expect(deleted).toBe(true);
      expect(store.get(added.jobId)).toBeNull();
    });

    it('should return false for non-existent job', async () => {
      const result = await store.delete('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should get existing job', async () => {
      const added = await store.add({
        name: 'Test Get',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      });

      const retrieved = store.get(added.jobId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.name).toBe('Test Get');
    });

    it('should return null for non-existent job', () => {
      const result = store.get('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('setEnabled', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should toggle job enabled state', async () => {
      const added = await store.add({
        name: 'Toggle Test',
        schedule: { kind: 'cron', expr: '0 * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      });

      const disabled = await store.setEnabled(added.jobId, false);
      expect(disabled.enabled).toBe(false);

      const enabled = await store.setEnabled(added.jobId, true);
      expect(enabled.enabled).toBe(true);
    });
  });
});

describe('validateJob', () => {
  it('should validate required fields', async () => {
    const store = new JobStore();
    await store.load();

    expect(async () => {
      await store.add({});
    }).toThrow('name is required');

    expect(async () => {
      await store.add({ name: 'Test' });
    }).toThrow('schedule is required');
  });

  it('should validate schedule kinds', async () => {
    const store = new JobStore();
    await store.load();

    expect(async () => {
      await store.add({
        name: 'Test',
        schedule: { kind: 'invalid' },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Test' },
      });
    }).toThrow('schedule.kind must be');
  });

  it('should validate sessionTarget', async () => {
    const store = new JobStore();
    await store.load();

    expect(async () => {
      await store.add({
        name: 'Test',
        schedule: { kind: 'cron', expr: '* * * * * *' },
        sessionTarget: 'invalid',
        payload: { kind: 'agentTurn', message: 'Test' },
      });
    }).toThrow('sessionTarget must be');
  });

  it('should validate payload kind', async () => {
    const store = new JobStore();
    await store.load();

    expect(async () => {
      await store.add({
        name: 'Test',
        schedule: { kind: 'cron', expr: '* * * * * *' },
        sessionTarget: 'isolated',
        payload: { kind: 'invalid' },
      });
    }).toThrow('payload.kind must be');
  });
});
