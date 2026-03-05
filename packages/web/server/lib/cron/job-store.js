import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_STORE_PATH = '~/.openchamber/cron/jobs.json';

function expandPath(filepath) {
  if (!filepath || typeof filepath !== 'string') {
    return filepath;
  }
  if (filepath === '~') {
    return os.homedir();
  }
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

function validateJob(job) {
  if (!job || typeof job !== 'object') {
    return { valid: false, error: 'Job must be an object' };
  }
  if (!job.jobId || typeof job.jobId !== 'string') {
    return { valid: false, error: 'jobId is required and must be a string' };
  }
  if (!job.name || typeof job.name !== 'string') {
    return { valid: false, error: 'name is required and must be a string' };
  }
  if (!job.schedule || typeof job.schedule !== 'object') {
    return { valid: false, error: 'schedule is required and must be an object' };
  }
  if (!['at', 'every', 'cron'].includes(job.schedule.kind)) {
    return { valid: false, error: 'schedule.kind must be "at", "every", or "cron"' };
  }
  if (job.schedule.kind === 'at' && !job.schedule.at) {
    return { valid: false, error: 'schedule.at is required for "at" kind' };
  }
  if (job.schedule.kind === 'every' && typeof job.schedule.everyMs !== 'number') {
    return { valid: false, error: 'schedule.everyMs is required for "every" kind' };
  }
  if (job.schedule.kind === 'cron' && !job.schedule.expr) {
    return { valid: false, error: 'schedule.expr is required for "cron" kind' };
  }
  if (!['main', 'isolated'].includes(job.sessionTarget)) {
    return { valid: false, error: 'sessionTarget must be "main" or "isolated"' };
  }
  if (!job.payload || typeof job.payload !== 'object') {
    return { valid: false, error: 'payload is required' };
  }
  if (!['systemEvent', 'agentTurn'].includes(job.payload.kind)) {
    return { valid: false, error: 'payload.kind must be "systemEvent" or "agentTurn"' };
  }
  return { valid: true };
}

export class JobStore {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = expandPath(storePath);
    this.jobs = new Map();
    this.loaded = false;
  }

  getStoreDir() {
    return path.dirname(this.storePath);
  }

  async ensureStoreDir() {
    const dir = this.getStoreDir();
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  async load() {
    try {
      const data = await fs.promises.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        this.jobs.clear();
        this.loaded = true;
        return;
      }
      this.jobs.clear();
      for (const job of parsed) {
        const validation = validateJob(job);
        if (validation.valid) {
          this.jobs.set(job.jobId, { ...job, updatedAt: job.updatedAt || Date.now() });
        }
      }
      this.loaded = true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.jobs.clear();
        this.loaded = true;
      } else {
        throw error;
      }
    }
  }

  async save() {
    await this.ensureStoreDir();
    const jobsArray = Array.from(this.jobs.values());
    await fs.promises.writeFile(this.storePath, JSON.stringify(jobsArray, null, 2), 'utf8');
  }

  list() {
    return Array.from(this.jobs.values());
  }

  get(jobId) {
    return this.jobs.get(jobId) || null;
  }

  async add(job) {
    if (!job.jobId) {
      job.jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    }
    const validation = validateJob(job);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    const now = Date.now();
    const newJob = {
      ...job,
      enabled: job.enabled !== false,
      createdAt: job.createdAt || now,
      updatedAt: now,
    };
    this.jobs.set(newJob.jobId, newJob);
    await this.save();
    return newJob;
  }

  async update(jobId, updates) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return null;
    }
    const updated = {
      ...existing,
      ...updates,
      jobId: existing.jobId,
      updatedAt: Date.now(),
    };
    const validation = validateJob(updated);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    this.jobs.set(jobId, updated);
    await this.save();
    return updated;
  }

  async delete(jobId) {
    const existed = this.jobs.delete(jobId);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  async setEnabled(jobId, enabled) {
    return this.update(jobId, { enabled });
  }
}

export function createJobStore(storePath) {
  return new JobStore(storePath);
}
