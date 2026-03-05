import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
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

export function CronSettings() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    scheduleKind: 'cron' as 'at' | 'every' | 'cron',
    scheduleValue: '',
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
    
    const job: Partial<CronJob> = {
      name: formData.name,
      description: formData.description,
      sessionTarget: formData.sessionTarget,
      schedule: {
        kind: formData.scheduleKind,
        ...(formData.scheduleKind === 'at' && { at: formData.scheduleValue }),
        ...(formData.scheduleKind === 'every' && { everyMs: parseInt(formData.scheduleValue, 10) }),
        ...(formData.scheduleKind === 'cron' && { expr: formData.scheduleValue }),
      },
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
      scheduleKind: 'cron',
      scheduleValue: '',
      sessionTarget: 'isolated',
      payloadKind: 'agentTurn',
      payloadText: '',
    });
    setShowForm(false);
    setEditingJob(null);
  };

  const editJob = (job: CronJob) => {
    setFormData({
      name: job.name,
      description: job.description || '',
      scheduleKind: job.schedule.kind,
      scheduleValue: job.schedule.at || String(job.schedule.everyMs || '') || job.schedule.expr || '',
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
        <div className="flex items-center gap-2">
          <RiTimeLine className="w-5 h-5" />
          <h2 className="typography-ui-header font-semibold text-foreground">Cron Jobs</h2>
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
            <label className="typography-ui-label text-foreground block mb-1">Schedule Type</label>
            <div className="flex gap-2">
              {(['cron', 'every', 'at'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setFormData({ ...formData, scheduleKind: kind })}
                  className={cn(
                    'px-3 py-1 rounded text-sm',
                    formData.scheduleKind === kind
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  {kind === 'cron' ? 'Cron' : kind === 'every' ? 'Interval' : 'One-time'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="typography-ui-label text-foreground block mb-1">
              {formData.scheduleKind === 'cron' && 'Cron Expression'}
              {formData.scheduleKind === 'every' && 'Interval (milliseconds)'}
              {formData.scheduleKind === 'at' && 'Run At (ISO date string)'}
            </label>
            <Input
              value={formData.scheduleValue}
              onChange={(e) => setFormData({ ...formData, scheduleValue: e.target.value })}
              placeholder={formData.scheduleKind === 'cron' ? '0 * * * *' : formData.scheduleKind === 'every' ? '3600000' : '2024-01-01T00:00:00Z'}
              required
              className="h-7"
            />
          </div>

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
