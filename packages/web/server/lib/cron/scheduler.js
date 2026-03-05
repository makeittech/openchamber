import { Cron } from 'croner';
import crypto from 'crypto';

export class CronScheduler {
  constructor(jobStore, options = {}) {
    this.jobStore = jobStore;
    this.options = {
      tickIntervalMs: options.tickIntervalMs || 1000,
      maxConcurrentRuns: options.maxConcurrentRuns || 1,
      buildOpenCodeUrl: options.buildOpenCodeUrl,
      getOpenCodeAuthHeaders: options.getOpenCodeAuthHeaders,
      getSessionId: options.getSessionId,
      createIsolatedSession: options.createIsolatedSession,
      logRun: options.logRun || (() => {}),
    };
    this.running = false;
    this.tickInterval = null;
    this.cronJobs = new Map();
    this.activeRuns = 0;
    this.runHistory = [];
  }

  isSkipped() {
    return process.env.OPENCHAMBER_SKIP_CRON === '1';
  }

  async start() {
    if (this.isSkipped()) {
      console.log('[CronScheduler] Skipped due to OPENCHAMBER_SKIP_CRON=1');
      return;
    }

    if (this.running) {
      return;
    }

    await this.jobStore.load();
    this.running = true;

    const jobs = this.jobStore.list();
    for (const job of jobs) {
      if (job.enabled !== false) {
        this.scheduleJob(job);
      }
    }

    this.tickInterval = setInterval(() => this.tick(), this.options.tickIntervalMs);
    console.log(`[CronScheduler] Started with ${this.cronJobs.size} scheduled jobs`);
  }

  stop() {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    for (const [jobId, cronJob] of this.cronJobs) {
      try {
        cronJob.stop();
      } catch (e) {}
    }
    this.cronJobs.clear();
    console.log('[CronScheduler] Stopped');
  }

  scheduleJob(job) {
    if (this.cronJobs.has(job.jobId)) {
      const existing = this.cronJobs.get(job.jobId);
      try {
        existing.stop();
      } catch (e) {}
      this.cronJobs.delete(job.jobId);
    }

    if (job.enabled === false) {
      return;
    }

    let cronJob = null;
    const schedule = job.schedule;

    try {
      if (schedule.kind === 'cron') {
        cronJob = new Cron(schedule.expr, { timezone: schedule.tz || undefined }, () => {
          this.executeJob(job);
        });
      } else if (schedule.kind === 'every') {
        const intervalSeconds = Math.max(1, Math.floor(schedule.everyMs / 1000));
        cronJob = new Cron(`*/${intervalSeconds} * * * * *`, () => {
          this.executeJob(job);
        });
      } else if (schedule.kind === 'at') {
        const targetDate = new Date(schedule.at);
        if (isNaN(targetDate.getTime())) {
          console.error(`[CronScheduler] Invalid 'at' date for job ${job.jobId}: ${schedule.at}`);
          return;
        }
        const now = new Date();
        if (targetDate <= now) {
          return;
        }
        cronJob = new Cron(targetDate, () => {
          this.executeJob(job);
          if (job.deleteAfterRun) {
            this.jobStore.delete(job.jobId);
          }
        });
      }

      if (cronJob) {
        this.cronJobs.set(job.jobId, cronJob);
      }
    } catch (error) {
      console.error(`[CronScheduler] Failed to schedule job ${job.jobId}:`, error.message);
    }
  }

  unscheduleJob(jobId) {
    if (this.cronJobs.has(jobId)) {
      const cronJob = this.cronJobs.get(jobId);
      try {
        cronJob.stop();
      } catch (e) {}
      this.cronJobs.delete(jobId);
    }
  }

  rescheduleJob(job) {
    this.unscheduleJob(job.jobId);
    if (job.enabled !== false) {
      this.scheduleJob(job);
    }
  }

  async tick() {
    // For now, croner handles scheduling internally
    // This tick is for future enhancements like checking for job store changes
  }

  async executeJob(job) {
    if (this.activeRuns >= this.options.maxConcurrentRuns) {
      console.log(`[CronScheduler] Max concurrent runs reached, skipping job ${job.jobId}`);
      return;
    }

    this.activeRuns++;
    const runId = `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const startTime = Date.now();
    let success = false;
    let output = null;
    let error = null;

    try {
      console.log(`[CronScheduler] Executing job ${job.jobId} (${job.name})`);

      if (job.sessionTarget === 'main') {
        output = await this.executeMainSessionJob(job);
      } else {
        output = await this.executeIsolatedJob(job);
      }

      success = true;
    } catch (err) {
      error = err.message || String(err);
      console.error(`[CronScheduler] Job ${job.jobId} failed:`, error);
    } finally {
      this.activeRuns--;
    }

    const runRecord = {
      runId,
      jobId: job.jobId,
      jobName: job.name,
      startTime,
      endTime: Date.now(),
      success,
      output: output ? String(output).slice(0, 10000) : null,
      error,
    };

    this.runHistory.push(runRecord);
    if (this.runHistory.length > 1000) {
      this.runHistory = this.runHistory.slice(-500);
    }

    this.options.logRun(runRecord);

    if (job.deleteAfterRun && success) {
      await this.jobStore.delete(job.jobId);
      this.unscheduleJob(job.jobId);
    }
  }

  async executeMainSessionJob(job) {
    const sessionId = this.options.getSessionId ? this.options.getSessionId() : null;
    if (!sessionId) {
      throw new Error('No main session available');
    }

    const url = this.options.buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
    const authHeaders = this.options.getOpenCodeAuthHeaders ? this.options.getOpenCodeAuthHeaders() : {};

    let message;
    if (job.payload.kind === 'systemEvent') {
      message = job.payload.text;
    } else {
      message = job.payload.message;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        role: 'user',
        content: message,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenCode API error: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  }

  async executeIsolatedJob(job) {
    if (!this.options.createIsolatedSession) {
      throw new Error('createIsolatedSession callback not configured');
    }

    const session = await this.options.createIsolatedSession(job);
    const sessionId = session.id;

    try {
      const url = this.options.buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
      const authHeaders = this.options.getOpenCodeAuthHeaders ? this.options.getOpenCodeAuthHeaders() : {};

      let message;
      if (job.payload.kind === 'systemEvent') {
        message = job.payload.text;
      } else {
        message = job.payload.message;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          role: 'user',
          content: message,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenCode API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.text();
      return result;
    } finally {
      // Note: Session cleanup would happen here if we had a delete session API
      console.log(`[CronScheduler] Isolated session ${sessionId} completed`);
    }
  }

  async runJobNow(jobId) {
    const job = this.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    await this.executeJob(job);
  }

  getStats() {
    return {
      running: this.running,
      scheduledCount: this.cronJobs.size,
      activeRuns: this.activeRuns,
      runHistoryCount: this.runHistory.length,
    };
  }

  getRunHistory(limit = 50) {
    return this.runHistory.slice(-limit);
  }
}

export function createCronScheduler(jobStore, options) {
  return new CronScheduler(jobStore, options);
}
