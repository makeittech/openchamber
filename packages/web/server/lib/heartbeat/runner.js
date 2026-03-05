const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const HEARTBEAT_OK_MARKER = 'HEARTBEAT_OK';

export class HeartbeatRunner {
  constructor(options = {}) {
    this.options = {
      buildOpenCodeUrl: options.buildOpenCodeUrl,
      getOpenCodeAuthHeaders: options.getOpenCodeAuthHeaders,
      getSessionId: options.getSessionId,
      getConfig: options.getConfig || (() => null),
      logHeartbeat: options.logHeartbeat || (() => {}),
    };
    this.running = false;
    this.heartbeatInterval = null;
    this.lastHeartbeatTime = null;
    this.heartbeatHistory = [];
  }

  isSkipped() {
    return process.env.OPENCHAMBER_SKIP_HEARTBEAT === '1';
  }

  parseInterval(intervalStr) {
    if (!intervalStr || typeof intervalStr !== 'string') {
      return DEFAULT_HEARTBEAT_INTERVAL_MS;
    }

    const trimmed = intervalStr.trim();
    if (trimmed === '0m' || trimmed === '0') {
      return 0;
    }

    const match = trimmed.match(/^(\d+)(m|h|s)?$/);
    if (!match) {
      return DEFAULT_HEARTBEAT_INTERVAL_MS;
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || 'm';

    switch (unit) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      default:
        return DEFAULT_HEARTBEAT_INTERVAL_MS;
    }
  }

  parseTimeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') {
      return null;
    }

    const trimmed = timeStr.trim();
    const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      return null;
    }

    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }

    return hours * 60 + minutes;
  }

  isInActiveHours(activeHours, timezone) {
    if (!activeHours || typeof activeHours !== 'object') {
      return true;
    }

    const startMinutes = this.parseTimeToMinutes(activeHours.start);
    const endMinutes = this.parseTimeToMinutes(activeHours.end);

    if (startMinutes === null || endMinutes === null) {
      return true;
    }

    const now = new Date();
    
    let currentTimeMinutes;
    if (timezone) {
      try {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const hourPart = parts.find(p => p.type === 'hour');
        const minutePart = parts.find(p => p.type === 'minute');
        
        if (hourPart && minutePart) {
          const hours = parseInt(hourPart.value, 10);
          const minutes = parseInt(minutePart.value, 10);
          currentTimeMinutes = hours * 60 + minutes;
        } else {
          currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
        }
      } catch (error) {
        currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
      }
    } else {
      currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
    }

    if (startMinutes <= endMinutes) {
      return currentTimeMinutes >= startMinutes && currentTimeMinutes <= endMinutes;
    } else {
      return currentTimeMinutes >= startMinutes || currentTimeMinutes <= endMinutes;
    }
  }

  parseHeartbeatOk(response) {
    if (!response || typeof response !== 'string') {
      return false;
    }

    const trimmed = response.trim();
    
    if (trimmed.startsWith(HEARTBEAT_OK_MARKER) || trimmed.endsWith(HEARTBEAT_OK_MARKER)) {
      return true;
    }

    const lines = trimmed.split('\n');
    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (lineTrimmed === HEARTBEAT_OK_MARKER) {
        return true;
      }
    }

    return false;
  }

  async start() {
    if (this.isSkipped()) {
      console.log('[HeartbeatRunner] Skipped due to OPENCHAMBER_SKIP_HEARTBEAT=1');
      return;
    }

    if (this.running) {
      return;
    }

    this.running = true;
    this.scheduleNextHeartbeat();
    console.log('[HeartbeatRunner] Started');
  }

  scheduleNextHeartbeat() {
    if (!this.running) {
      return;
    }

    const config = this.options.getConfig ? this.options.getConfig() : null;
    const intervalMs = this.parseInterval(config?.every);

    if (intervalMs === 0) {
      console.log('[HeartbeatRunner] Disabled via config (every: "0m")');
      return;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => this.tick(), intervalMs);
    console.log(`[HeartbeatRunner] Scheduled heartbeat every ${intervalMs / 1000 / 60} minutes`);
  }

  stop() {
    this.running = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    console.log('[HeartbeatRunner] Stopped');
  }

  async tick() {
    if (!this.running) {
      return;
    }

    const config = this.options.getConfig ? this.options.getConfig() : null;
    
    if (config?.activeHours && !this.isInActiveHours(config.activeHours, config.activeHours?.timezone)) {
      console.log('[HeartbeatRunner] Skipping heartbeat - outside active hours');
      return;
    }

    await this.executeHeartbeat(config);
  }

  async executeHeartbeat(config) {
    const startTime = Date.now();
    let success = false;
    let output = null;
    let error = null;
    let heartbeatOk = false;

    try {
      console.log('[HeartbeatRunner] Executing heartbeat');

      const sessionId = this.options.getSessionId ? this.options.getSessionId() : null;
      if (!sessionId) {
        throw new Error('No main session available');
      }

      const url = this.options.buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
      const authHeaders = this.options.getOpenCodeAuthHeaders ? this.options.getOpenCodeAuthHeaders() : {};

      const prompt = config?.prompt || 'Read HEARTBEAT.md if it exists. If nothing needs attention, reply HEARTBEAT_OK.';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          role: 'user',
          content: prompt,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenCode API error: ${response.status} ${response.statusText}`);
      }

      output = await response.text();
      heartbeatOk = this.parseHeartbeatOk(output);
      success = true;

      if (heartbeatOk) {
        console.log('[HeartbeatRunner] Heartbeat OK received');
      } else {
        console.log('[HeartbeatRunner] Heartbeat response did not contain HEARTBEAT_OK');
      }

      if (config?.target && config.target !== 'none') {
        await this.deliverToTarget(config, output, heartbeatOk);
      }
    } catch (err) {
      error = err.message || String(err);
      console.error('[HeartbeatRunner] Heartbeat failed:', error);
    }

    this.lastHeartbeatTime = startTime;

    const record = {
      startTime,
      endTime: Date.now(),
      success,
      heartbeatOk,
      output: output ? String(output).slice(0, 10000) : null,
      error,
    };

    this.heartbeatHistory.push(record);
    if (this.heartbeatHistory.length > 1000) {
      this.heartbeatHistory = this.heartbeatHistory.slice(-500);
    }

    if (this.options.logHeartbeat) {
      this.options.logHeartbeat(record);
    }

    return record;
  }

  async deliverToTarget(config, output, heartbeatOk) {
    const target = config?.target;
    
    if (!target || target === 'none') {
      return;
    }

    console.log(`[HeartbeatRunner] Delivering heartbeat to target: ${target}`);

    if (target === 'last') {
      const sessionId = this.options.getSessionId ? this.options.getSessionId() : null;
      if (!sessionId) {
        console.warn('[HeartbeatRunner] Cannot deliver to last - no main session');
        return;
      }

      const url = this.options.buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
      const authHeaders = this.options.getOpenCodeAuthHeaders ? this.options.getOpenCodeAuthHeaders() : {};

      try {
        const deliveryMessage = heartbeatOk
          ? 'Heartbeat check passed. All systems operational.'
          : `Heartbeat alert: ${output?.slice(0, 300) || 'No response'}`;

        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            role: 'user',
            content: deliveryMessage,
          }),
        });

        console.log('[HeartbeatRunner] Heartbeat delivered to last session');
      } catch (err) {
        console.error('[HeartbeatRunner] Failed to deliver heartbeat:', err.message);
      }
    } else {
      console.log(`[HeartbeatRunner] Target channel delivery not yet implemented: ${target}`);
    }
  }

  async runHeartbeatNow() {
    const config = this.options.getConfig ? this.options.getConfig() : null;
    return await this.executeHeartbeat(config);
  }

  getStats() {
    return {
      running: this.running,
      lastHeartbeatTime: this.lastHeartbeatTime,
      heartbeatHistoryCount: this.heartbeatHistory.length,
    };
  }

  getHeartbeatHistory(limit = 50) {
    return this.heartbeatHistory.slice(-limit);
  }
}

export function createHeartbeatRunner(options) {
  return new HeartbeatRunner(options);
}
