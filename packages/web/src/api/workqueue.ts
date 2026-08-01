import type {
  WorkQueueAPI,
  WorkQueueBulkAnalysisResult,
  WorkQueueCloudAgentDraft,
  WorkQueueCursorAuthStatus,
  WorkQueueFinishResult,
  WorkQueueItem,
  WorkQueueItemStatus,
  WorkQueueStalenessResult,
  WorkQueueSyncResult,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebWorkQueueAPI = (): WorkQueueAPI => ({
  async itemsList(options) {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.repo) params.set('repo', options.repo);
    if (options?.assignee) params.set('assignee', options.assignee);
    if (options?.type) params.set('type', options.type);
    if (options?.source) params.set('source', options.source);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await runtimeFetch(`/api/workqueue/items${suffix}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ items?: WorkQueueItem[]; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load work queue items');
    }
    return { items: payload.items || [] };
  },

  async itemGet(id: string) {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ item?: WorkQueueItem; error?: string }>(response);
    if (!response.ok || !payload?.item) {
      throw new Error(payload?.error || response.statusText || 'Failed to load work queue item');
    }
    return { item: payload.item };
  },

  async sync(): Promise<WorkQueueSyncResult> {
    const response = await runtimeFetch('/api/workqueue/sync', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<WorkQueueSyncResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to sync work queue');
    }
    return payload;
  },

  async analyze(id: string, directory?: string) {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(directory ? { directory } : {}),
    });
    const payload = await jsonOrNull<{ item?: WorkQueueItem; error?: string }>(response);
    if (!response.ok || !payload?.item) {
      throw new Error(payload?.error || response.statusText || 'Failed to analyze work queue item');
    }
    return { item: payload.item };
  },

  async analyzeBulk(directory?: string): Promise<WorkQueueBulkAnalysisResult> {
    const response = await runtimeFetch('/api/workqueue/analyze-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(directory ? { directory } : {}),
    });
    const payload = await jsonOrNull<WorkQueueBulkAnalysisResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to run bulk analysis');
    }
    return payload;
  },

  async patch(id: string, patch: { status?: WorkQueueItemStatus; assignee?: string; linkedSessionId?: string; attachedPrUrl?: string }) {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await jsonOrNull<{ item?: WorkQueueItem; linearSyncWarning?: string; assigneeSyncWarning?: string; error?: string }>(response);
    if (!response.ok || !payload?.item) {
      throw new Error(payload?.error || response.statusText || 'Failed to update work queue item');
    }
    return { item: payload.item, linearSyncWarning: payload.linearSyncWarning, assigneeSyncWarning: payload.assigneeSyncWarning };
  },

  async staleness(id: string, directory: string): Promise<WorkQueueStalenessResult> {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}/staleness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ directory }),
    });
    const payload = await jsonOrNull<WorkQueueStalenessResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to check staleness');
    }
    return payload;
  },

  async finish(id: string, options?: { mergePr?: boolean }): Promise<WorkQueueFinishResult> {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(options || {}),
    });
    const payload = await jsonOrNull<WorkQueueFinishResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to finish work queue item');
    }
    return payload;
  },

  async cloudAgentDraft(id: string): Promise<WorkQueueCloudAgentDraft> {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}/cloud-agent/draft`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<WorkQueueCloudAgentDraft & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to load cloud agent draft');
    }
    return payload;
  },

  async launchCloudAgent(id: string, options?: { prompt?: string; model?: string; repository?: string }) {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}/cloud-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(options || {}),
    });
    const payload = await jsonOrNull<{ item?: WorkQueueItem; error?: string }>(response);
    if (!response.ok || !payload?.item) {
      throw new Error(payload?.error || response.statusText || 'Failed to launch cloud agent');
    }
    return { item: payload.item };
  },

  async cloudAgentStatus(id: string) {
    const response = await runtimeFetch(`/api/workqueue/items/${encodeURIComponent(id)}/cloud-agent/status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ cloudAgent?: WorkQueueItem['cloudAgent']; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to fetch cloud agent status');
    }
    return { cloudAgent: payload?.cloudAgent ?? null };
  },

  async reposList() {
    const response = await runtimeFetch('/api/workqueue/settings/repos', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ repos?: string[]; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to load tracked repos');
    }
    return { repos: payload?.repos || [] };
  },

  async reposSet(repos: string[]) {
    const response = await runtimeFetch('/api/workqueue/settings/repos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ repos }),
    });
    const payload = await jsonOrNull<{ repos?: string[]; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to update tracked repos');
    }
    return { repos: payload?.repos || [] };
  },

  async cursorAuthStatus(): Promise<WorkQueueCursorAuthStatus> {
    const response = await runtimeFetch('/api/workqueue/settings/cursor-auth', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<WorkQueueCursorAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to load Cursor status');
    }
    return payload;
  },

  async cursorAuthConnect(apiKey: string) {
    const response = await runtimeFetch('/api/workqueue/settings/cursor-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const payload = await jsonOrNull<{ connected?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to connect Cursor');
    }
    return { connected: Boolean(payload.connected) };
  },

  async cursorAuthDisconnect() {
    const response = await runtimeFetch('/api/workqueue/settings/cursor-auth', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ removed?: boolean; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to disconnect Cursor');
    }
    return { removed: Boolean(payload?.removed) };
  },

  async cursorApiVersionSet(apiVersion) {
    const response = await runtimeFetch('/api/workqueue/settings/cursor-version', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiVersion }),
    });
    const payload = await jsonOrNull<{ apiVersion?: string; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to update Cursor API version');
    }
    const version = payload.apiVersion ?? 'v0';
    return { apiVersion: (version === 'v1' ? 'v1' : 'v0') as import('@openchamber/ui/lib/api/types').CursorApiVersion };
  },
});
