import type {
  LinearAPI,
  LinearAttachSessionInput,
  LinearAttachSessionResult,
  LinearAuthStatus,
  LinearAutomationSettings,
  LinearIssueGetResult,
  LinearIssuesListResult,
  LinearOAuthStart,
  LinearSessionLinksResult,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebLinearAPI = (): LinearAPI => ({
  async authStatus(): Promise<LinearAuthStatus> {
    const response = await runtimeFetch('/api/linear/auth/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<LinearAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Linear status');
    }
    return payload;
  },

  async authStart(redirectUri?: string): Promise<LinearOAuthStart> {
    const response = await runtimeFetch('/api/linear/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(redirectUri ? { redirectUri } : {}),
    });
    const payload = await jsonOrNull<LinearOAuthStart & { error?: string }>(response);
    if (!response.ok || !payload || typeof payload.authorizeUrl !== 'string') {
      throw new Error(payload?.error || response.statusText || 'Failed to start Linear auth');
    }
    return payload;
  },

  async authApiKey(apiKey: string): Promise<LinearAuthStatus> {
    const response = await runtimeFetch('/api/linear/auth/apikey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const payload = await jsonOrNull<LinearAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to connect with the Linear API key');
    }
    return payload;
  },

  async authDisconnect(): Promise<{ removed: boolean }> {
    const response = await runtimeFetch('/api/linear/auth', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ removed?: boolean; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to disconnect Linear');
    }
    return { removed: Boolean(payload?.removed) };
  },

  async updateAutomation(patch: Partial<LinearAutomationSettings>): Promise<{ automation: LinearAutomationSettings }> {
    const response = await runtimeFetch('/api/linear/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await jsonOrNull<{ automation?: LinearAutomationSettings; error?: string }>(response);
    if (!response.ok || !payload?.automation) {
      throw new Error(payload?.error || response.statusText || 'Failed to update Linear automation settings');
    }
    return { automation: payload.automation };
  },

  async issuesList(options?: { query?: string; cursor?: string | null }): Promise<LinearIssuesListResult> {
    const params = new URLSearchParams();
    if (options?.query) {
      params.set('query', options.query);
    }
    if (options?.cursor) {
      params.set('cursor', options.cursor);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await runtimeFetch(`/api/linear/issues${suffix}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<LinearIssuesListResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Linear issues');
    }
    return payload;
  },

  async issueGet(ref: string): Promise<LinearIssueGetResult> {
    const response = await runtimeFetch(`/api/linear/issue?id=${encodeURIComponent(ref)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<LinearIssueGetResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Linear issue');
    }
    return payload;
  },

  async attachSession(input: LinearAttachSessionInput): Promise<LinearAttachSessionResult> {
    const response = await runtimeFetch('/api/linear/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<LinearAttachSessionResult & { error?: string }>(response);
    if (!response.ok || !payload || !payload.link) {
      throw new Error(payload?.error || response.statusText || 'Failed to link the session to Linear');
    }
    return payload;
  },

  async sessionLinks(query: { issueId?: string; sessionId?: string }): Promise<LinearSessionLinksResult> {
    const params = new URLSearchParams();
    if (query.issueId) {
      params.set('issueId', query.issueId);
    }
    if (query.sessionId) {
      params.set('sessionId', query.sessionId);
    }
    const response = await runtimeFetch(`/api/linear/sessions?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<LinearSessionLinksResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Linear session links');
    }
    return payload;
  },
});
