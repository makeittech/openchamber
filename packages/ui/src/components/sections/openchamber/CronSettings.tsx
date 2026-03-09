import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectLabel,
  SelectSeparator,
} from '@/components/ui/select';
import {
  RiTimeLine,
  RiAddLine,
  RiDeleteBinLine,
  RiPlayLine,
  RiRefreshLine,
} from '@remixicon/react';

interface CronJob {
  jobId: string;
  name: string;
  description?: string;
  schedule: {
    kind: 'at' | 'every' | 'cron';
    at?: string;
    everyMs?: number;
    expr?: string;
    tz?: string;
  };
  sessionTarget: 'main' | 'isolated';
  payload: {
    kind: 'systemEvent' | 'agentTurn';
    text?: string;
    message?: string;
    model?: string;
  };
  enabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland',
];

function presetToCronExpression(preset: string): string {
  const presetMap: Record<string, string> = {
    'hourly-1': '0 0 * * * *',
    'hourly-2': '0 0 */2 * * *',
    'hourly-6': '0 0 */6 * * *',
    'hourly-12': '0 0 */12 * * *',
    'daily-9': '0 0 9 * * *',
    'daily-12': '0 0 12 * * *',
    'daily-17': '0 0 17 * * *',
    'daily-21': '0 0 21 * * *',
    'weekly-mon': '0 0 9 * * 1',
    'weekly-tue': '0 0 9 * * 2',
    'weekly-wed': '0 0 9 * * 3',
    'weekly-thu': '0 0 9 * * 4',
    'weekly-fri': '0 0 9 * * 5',
    'weekly-weekdays': '0 0 9 * * 1-5',
    'weekly-weekends': '0 0 9 * * 0,6',
    'monthly-1': '0 0 9 1 * *',
    'monthly-15': '0 0 9 15 * *',
    'monthly-last': '0 0 9 L * *',
  };
  return presetMap[preset] || '0 0 * * * *';
}

export function CronSettings() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [globalTimezone, setGlobalTimezone] = useState('UTC');

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    scheduleMode: 'preset' as 'preset' | 'custom' | 'cron',
    presetSchedule: 'hourly-1',
    customDate: '',
    customTime: '09:00',
    cronExpression: '',
    sessionTarget: 'isolated' as 'main' | 'isolated',
    payloadKind: 'agentTurn' as 'systemEvent' | 'agentTurn',
    payloadText: '',
  });

  const fetchJobs = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/cron');
      if (!response.ok) throw new Error('Failed to fetch jobs');
      const data = await response.json();
      setJobs(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let schedule: CronJob['schedule'];

    if (formData.scheduleMode === 'preset') {
      schedule = {
        kind: 'cron',
        expr: presetToCronExpression(formData.presetSchedule),
        tz: globalTimezone,
      };
    } else if (formData.scheduleMode === 'custom') {
      const dateTime = new Date(`${formData.customDate}T${formData.customTime}`);
      schedule = {
        kind: 'at',
        at: dateTime.toISOString(),
        tz: globalTimezone,
      };
    } else {
      schedule = {
        kind: 'cron',
        expr: formData.cronExpression,
        tz: globalTimezone,
      };
    }

    const job: Partial<CronJob> = {
      name: formData.name,
      description: formData.description,
      sessionTarget: formData.sessionTarget,
      schedule,
      payload: {
        kind: formData.payloadKind,
        ...(formData.payloadKind === 'systemEvent' && { text: formData.payloadText }),
        ...(formData.payloadKind === 'agentTurn' && { message: formData.payloadText }),
      },
    };

    try {
      const url = editingJob ? `/api/cron/${editingJob.jobId}` : '/api/cron';
      const method = editingJob ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job),
      });

      if (!response.ok) throw new Error('Failed to save job');

      await fetchJobs();
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save job');
    }
  };

  const handleToggle = async (jobId: string, enabled: boolean) => {
    try {
      const response = await fetch(`/api/cron/${jobId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error('Failed to update job');
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update job');
    }
  };

  const handleDelete = async (jobId: string) => {
    if (!confirm('Delete this job?')) return;
    
    try {
      const response = await fetch(`/api/cron/${jobId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete job');
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete job');
    }
  };

  const handleRunNow = async (jobId: string) => {
    try {
      const response = await fetch(`/api/cron/${jobId}/run`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to run job');
      alert('Job triggered successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run job');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      scheduleMode: 'preset',
      presetSchedule: 'hourly-1',
      customDate: '',
      customTime: '09:00',
      cronExpression: '',
      sessionTarget: 'isolated',
      payloadKind: 'agentTurn',
      payloadText: '',
    });
    setShowForm(false);
    setEditingJob(null);
  };

  const editJob = (job: CronJob) => {
    let scheduleMode: 'preset' | 'custom' | 'cron' = 'cron';
    const presetSchedule = 'hourly-1';
    let customDate = '';
    let customTime = '09:00';
    let cronExpression = '';
    
    if (job.schedule.kind === 'cron' && job.schedule.expr) {
      cronExpression = job.schedule.expr;
      scheduleMode = 'cron';
    } else if (job.schedule.kind === 'at' && job.schedule.at) {
      const [date, time] = job.schedule.at.split('T');
      customDate = date || '';
      customTime = time?.substring(0, 5) || '09:00';
      scheduleMode = 'custom';
    }
    
    setFormData({
      name: job.name,
      description: job.description || '',
      scheduleMode,
      presetSchedule,
      customDate,
      customTime,
      cronExpression,
      sessionTarget: job.sessionTarget,
      payloadKind: job.payload.kind,
      payloadText: job.payload.text || job.payload.message || '',
    });
    setEditingJob(job);
    setShowForm(true);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="typography-meta text-muted-foreground">Loading cron jobs...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <RiTimeLine className="w-5 h-5" />
            <h2 className="typography-ui-header font-semibold text-foreground">Cron Jobs</h2>
          </div>
          <Select value={globalTimezone} onValueChange={setGlobalTimezone}>
            <SelectTrigger size="sm" className="h-7" aria-label="Select timezone for cron jobs">
              <SelectValue placeholder="Select timezone" />
            </SelectTrigger>
            <SelectContent>
              {COMMON_TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchJobs}
            className="h-7"
          >
            <RiRefreshLine className="w-4 h-4 mr-1" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => setShowForm(!showForm)}
            className="h-7"
          >
            <RiAddLine className="w-4 h-4 mr-1" />
            Add Job
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-lg bg-muted/20">
          <div>
            <label className="typography-ui-label text-foreground block mb-1">Name *</label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="My scheduled task"
              required
              className="h-7"
            />
          </div>

          <div>
            <label className="typography-ui-label text-foreground block mb-1">Description</label>
            <Input
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Optional description"
              className="h-7"
            />
          </div>

          <div>
            <label className="typography-ui-label text-foreground block mb-1">Schedule Mode</label>
            <div className="flex gap-2">
              {(['preset', 'custom', 'cron'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setFormData({ ...formData, scheduleMode: mode })}
                  className={cn(
                    'px-3 py-1 rounded text-sm',
                    formData.scheduleMode === mode
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  {mode === 'preset' ? 'Presets' : mode === 'custom' ? 'Custom Date/Time' : 'Cron Expression'}
                </button>
              ))}
            </div>
          </div>

          {formData.scheduleMode === 'preset' && (
            <div>
              <label className="typography-ui-label text-foreground block mb-1">Preset Schedule</label>
              <Select
                value={formData.presetSchedule}
                onValueChange={(value) => setFormData({ ...formData, presetSchedule: value })}
              >
                <SelectTrigger size="sm" className="h-7 w-full">
                  <SelectValue placeholder="Select a preset schedule" />
                </SelectTrigger>
                <SelectContent>
                  <SelectLabel>Hourly</SelectLabel>
                  <SelectItem value="hourly-1">Every hour</SelectItem>
                  <SelectItem value="hourly-2">Every 2 hours</SelectItem>
                  <SelectItem value="hourly-6">Every 6 hours</SelectItem>
                  <SelectItem value="hourly-12">Every 12 hours</SelectItem>
                  <SelectSeparator />
                  <SelectLabel>Daily</SelectLabel>
                  <SelectItem value="daily-9">Daily at 9:00 AM</SelectItem>
                  <SelectItem value="daily-12">Daily at 12:00 PM</SelectItem>
                  <SelectItem value="daily-17">Daily at 5:00 PM</SelectItem>
                  <SelectItem value="daily-21">Daily at 9:00 PM</SelectItem>
                  <SelectSeparator />
                  <SelectLabel>Weekly</SelectLabel>
                  <SelectItem value="weekly-mon">Every Monday</SelectItem>
                  <SelectItem value="weekly-tue">Every Tuesday</SelectItem>
                  <SelectItem value="weekly-wed">Every Wednesday</SelectItem>
                  <SelectItem value="weekly-thu">Every Thursday</SelectItem>
                  <SelectItem value="weekly-fri">Every Friday</SelectItem>
                  <SelectItem value="weekly-weekdays">Weekdays (Mon-Fri)</SelectItem>
                  <SelectItem value="weekly-weekends">Weekends (Sat-Sun)</SelectItem>
                  <SelectSeparator />
                  <SelectLabel>Monthly</SelectLabel>
                  <SelectItem value="monthly-1">1st of every month</SelectItem>
                  <SelectItem value="monthly-15">15th of every month</SelectItem>
                  <SelectItem value="monthly-last">Last day of month</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {formData.scheduleMode === 'custom' && (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="typography-ui-label text-foreground block mb-1">Date</label>
                <Input
                  type="date"
                  value={formData.customDate}
                  onChange={(e) => setFormData({ ...formData, customDate: e.target.value })}
                  required
                  className="h-7"
                />
              </div>
              <div className="flex-1">
                <label className="typography-ui-label text-foreground block mb-1">Time</label>
                <Input
                  type="time"
                  value={formData.customTime}
                  onChange={(e) => setFormData({ ...formData, customTime: e.target.value })}
                  required
                  className="h-7"
                />
              </div>
            </div>
          )}

          {formData.scheduleMode === 'cron' && (
            <div>
              <label className="typography-ui-label text-foreground block mb-1">Cron Expression</label>
              <Input
                value={formData.cronExpression}
                onChange={(e) => setFormData({ ...formData, cronExpression: e.target.value })}
                placeholder="0 * * * * *"
                required
                className="h-7"
              />
            </div>
          )}

          <div>
            <label className="typography-ui-label text-foreground block mb-1">Session Target</label>
            <div className="flex gap-2">
              {(['isolated', 'main'] as const).map((target) => (
                <button
                  key={target}
                  type="button"
                  onClick={() => setFormData({ ...formData, sessionTarget: target })}
                  className={cn(
                    'px-3 py-1 rounded text-sm',
                    formData.sessionTarget === target
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  {target === 'isolated' ? 'Isolated' : 'Main Session'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="typography-ui-label text-foreground block mb-1">Payload Type</label>
            <div className="flex gap-2">
              {(['agentTurn', 'systemEvent'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setFormData({ ...formData, payloadKind: kind })}
                  className={cn(
                    'px-3 py-1 rounded text-sm',
                    formData.payloadKind === kind
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  {kind === 'agentTurn' ? 'Agent Turn' : 'System Event'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="typography-ui-label text-foreground block mb-1">
              {formData.payloadKind === 'agentTurn' ? 'Message' : 'Event Text'}
            </label>
            <textarea
              value={formData.payloadText}
              onChange={(e) => setFormData({ ...formData, payloadText: e.target.value })}
              placeholder="Your message or event text"
              required
              className="w-full h-24 px-3 py-2 text-sm border rounded-md resize-none"
            />
          </div>

          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-7">
              {editingJob ? 'Update' : 'Create'} Job
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={resetForm} className="h-7">
              Cancel
            </Button>
          </div>
        </form>
      )}

      {jobs.length === 0 ? (
        <div className="typography-meta text-muted-foreground text-center py-8">
          No cron jobs configured. Click "Add Job" to create one.
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.jobId}
              className="flex items-start justify-between p-3 border rounded-lg hover:bg-muted/20"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Checkbox
                    checked={job.enabled !== false}
                    onChange={(checked) => handleToggle(job.jobId, checked)}
                    ariaLabel={`Enable ${job.name}`}
                  />
                  <span className="typography-ui-label text-foreground font-medium">
                    {job.name}
                  </span>
                  <span className="typography-meta text-muted-foreground">
                    ({job.schedule.kind})
                  </span>
                </div>
                {job.description && (
                  <div className="typography-meta text-muted-foreground text-sm mb-1">
                    {job.description}
                  </div>
                )}
                <div className="typography-meta text-muted-foreground text-xs">
                  Target: {job.sessionTarget} • Payload: {job.payload.kind}
                </div>
              </div>
              <div className="flex gap-1 ml-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => editJob(job)}
                  className="h-7 w-7 p-0"
                  aria-label="Edit"
                >
                  ✏️
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRunNow(job.jobId)}
                  className="h-7 w-7 p-0"
                  aria-label="Run now"
                >
                  <RiPlayLine className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(job.jobId)}
                  className="h-7 w-7 p-0 text-red-600 hover:text-red-700"
                  aria-label="Delete"
                >
                  <RiDeleteBinLine className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
