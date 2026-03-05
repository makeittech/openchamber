import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  RiHeartPulseLine,
  RiRefreshLine,
  RiPlayLine,
} from '@remixicon/react';

interface HeartbeatConfig {
  enabled: boolean;
  every: string;
  target: 'none' | 'last';
  activeHours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  prompt?: string;
}

export function HeartbeatSettings() {
  const [config, setConfig] = useState<HeartbeatConfig>({
    enabled: false,
    every: '30m',
    target: 'none',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchConfig = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/heartbeat');
      if (!response.ok) throw new Error('Failed to fetch heartbeat config');
      const data = await response.json();
      setConfig(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const response = await fetch('/api/heartbeat', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save config');
      }

      setSuccess('Heartbeat settings saved');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    try {
      setError(null);
      const response = await fetch('/api/heartbeat/run', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to trigger heartbeat');
      setSuccess('Heartbeat triggered successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger heartbeat');
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="typography-meta text-muted-foreground">Loading heartbeat settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <RiHeartPulseLine className="w-5 h-5" />
          <h2 className="typography-ui-header font-semibold text-foreground">Heartbeat</h2>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchConfig}
            className="h-7"
          >
            <RiRefreshLine className="w-4 h-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded text-sm text-green-800 dark:text-green-200">
          {success}
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Checkbox
            checked={config.enabled}
            onChange={(checked) => setConfig({ ...config, enabled: checked })}
            ariaLabel="Enable heartbeat"
          />
          <label className="typography-ui-label text-foreground">
            Enable automatic heartbeat checks
          </label>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Interval
          </label>
          <Input
            value={config.every}
            onChange={(e) => setConfig({ ...config, every: e.target.value })}
            placeholder="30m"
            className="h-7"
          />
          <p className="typography-micro text-muted-foreground mt-1">
            How often to check for attention (e.g., "30m", "1h", "0" to disable)
          </p>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Target
          </label>
          <div className="flex gap-2">
            {(['none', 'last'] as const).map((target) => (
              <button
                key={target}
                type="button"
                onClick={() => setConfig({ ...config, target })}
                className={cn(
                  'px-3 py-1 rounded text-sm',
                  config.target === target
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                )}
              >
                {target === 'none' ? 'None' : 'Last Session'}
              </button>
            ))}
          </div>
          <p className="typography-micro text-muted-foreground mt-1">
            Where to deliver heartbeat alerts (if not OK)
          </p>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Active Hours (Optional)
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Input
                value={config.activeHours?.start || ''}
                onChange={(e) => setConfig({
                  ...config,
                  activeHours: {
                    ...config.activeHours,
                    start: e.target.value,
                    end: config.activeHours?.end || '',
                  }
                })}
                placeholder="09:00"
                className="h-7"
              />
              <p className="typography-micro text-muted-foreground mt-1">Start</p>
            </div>
            <div>
              <Input
                value={config.activeHours?.end || ''}
                onChange={(e) => setConfig({
                  ...config,
                  activeHours: {
                    ...config.activeHours,
                    start: config.activeHours?.start || '',
                    end: e.target.value,
                  }
                })}
                placeholder="17:00"
                className="h-7"
              />
              <p className="typography-micro text-muted-foreground mt-1">End</p>
            </div>
          </div>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Timezone (Optional)
          </label>
          <Input
            value={config.activeHours?.timezone || ''}
            onChange={(e) => setConfig({
              ...config,
              activeHours: {
                ...config.activeHours,
                start: config.activeHours?.start || '',
                end: config.activeHours?.end || '',
                timezone: e.target.value,
              }
            })}
            placeholder="America/New_York"
            className="h-7"
          />
          <p className="typography-micro text-muted-foreground mt-1">
            Timezone for active hours (e.g., "America/New_York")
          </p>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Prompt (Optional)
          </label>
          <textarea
            value={config.prompt || ''}
            onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
            placeholder="Read HEARTBEAT.md if it exists. If nothing needs attention, reply HEARTBEAT_OK."
            className="w-full h-24 px-3 py-2 text-sm border rounded-md resize-none"
          />
          <p className="typography-micro text-muted-foreground mt-1">
            Custom prompt for heartbeat checks
          </p>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="h-7"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRunNow}
            className="h-7"
          >
            <RiPlayLine className="w-4 h-4 mr-1" />
            Run Now
          </Button>
        </div>
      </div>
    </div>
  );
}
