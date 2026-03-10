import { createOpencodeClient } from '@opencode-ai/sdk';

const userSessions = new Map();
const pendingMessages = new Map();

const normalizeListPayload = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
};

export class SessionManager {
  constructor(opencodeConfig = {}) {
    this.opencodeConfig = opencodeConfig;
  }

  getSession(userId) {
    return userSessions.get(userId);
  }

  getTemporaryClient() {
    return createOpencodeClient({
      baseUrl: this.opencodeConfig.baseUrl || `http://localhost:${this.opencodeConfig.port || 3000}`
    });
  }

  storePendingMessage(userId, text) {
    pendingMessages.set(userId, text);
  }

  getPendingMessage(userId) {
    const msg = pendingMessages.get(userId);
    pendingMessages.delete(userId);
    return msg;
  }

  async createSession(userId, title = 'Telegram Session', directory = null) {
    const existingSession = userSessions.get(userId);
    if (existingSession) {
      return {
        success: false,
        error: 'Session already exists. Use /endsession first.',
        session: existingSession
      };
    }

    try {
      const baseUrl = this.opencodeConfig.baseUrl || `http://localhost:${this.opencodeConfig.port || 3000}`;
      const client = createOpencodeClient({
        baseUrl
      });

      const dir = directory || process.cwd();
      const response = await client.session.create({
        body: { title },
        query: { directory: dir }
      });

      // SDK wraps result in { data: ... }
      const session = response?.data || response;

      const sessionData = {
        id: session.id,
        title: session.title || title,
        client,
        baseUrl,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        model: null,
        directory: dir,
        processing: false
      };

      userSessions.set(userId, sessionData);

      return {
        success: true,
        session: sessionData
      };
    } catch (error) {
      console.error('[Telegram] Failed to create session:', error);
      return {
        success: false,
        error: error.message || 'Failed to create OpenCode session'
      };
    }
  }

  async createSessionWithProject(userId, projectPath, projectName) {
    return this.createSession(userId, projectName || 'Project Session', projectPath);
  }

  async createFreeSession(userId) {
    return this.createSession(userId, 'Free Chat');
  }

  async resumeSession(userId, sessionId) {
    const existingSession = userSessions.get(userId);
    if (existingSession) {
      return {
        success: false,
        error: 'Session already exists. Use /endsession first.',
        session: existingSession
      };
    }

    try {
      const baseUrl = this.opencodeConfig.baseUrl || `http://localhost:${this.opencodeConfig.port || 3000}`;
      const client = createOpencodeClient({
        baseUrl
      });

      const sessions = await client.session.list();
      const sessionList = Array.isArray(sessions?.data) ? sessions.data : (Array.isArray(sessions) ? sessions : []);
      const found = sessionList.find(s => s.id === sessionId);

      if (!found) {
        return {
          success: false,
          error: 'Session not found'
        };
      }

      const sessionData = {
        id: found.id,
        title: found.title || 'Resumed Session',
        client,
        baseUrl,
        createdAt: found.time?.created || Date.now(),
        lastActivity: Date.now(),
        model: null,
        directory: found.directory || null
      };

      userSessions.set(userId, sessionData);

      return {
        success: true,
        session: sessionData
      };
    } catch (error) {
      console.error('[Telegram] Failed to resume session:', error);
      return {
        success: false,
        error: error.message || 'Failed to resume session'
      };
    }
  }

  async endSession(userId) {
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session found'
      };
    }

    try {
      userSessions.delete(userId);
      return {
        success: true,
        message: 'Session ended successfully'
      };
    } catch (error) {
      console.error('[Telegram] Failed to end session:', error);
      return {
        success: false,
        error: error.message || 'Failed to end session'
      };
    }
  }

  async sendPrompt(userId, prompt, onProgress = null) {
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session. Use /opencode to start a session.'
      };
    }

    if (session.processing) {
      return {
        success: false,
        error: 'I am still thinking about your previous message. Please wait a moment.'
      };
    }

    try {
      session.processing = true;
      session.lastActivity = Date.now();

      const base = session.baseUrl.replace(/\/+$/, '');

      // Helper to build URLs with optional directory param
      const buildUrl = (path) => {
        const url = new URL(`${base}${path}`);
        if (session.directory) {
          url.searchParams.set('directory', session.directory);
        }
        return url.toString();
      };

      // Snapshot existing message IDs so we can detect new ones
      let existingIds = new Set();
      try {
        const snapRes = await fetch(buildUrl(`/session/${encodeURIComponent(session.id)}/message`));
        if (snapRes.ok) {
          const snapPayload = await snapRes.json().catch(() => []);
          const snapshotMsgs = normalizeListPayload(snapPayload);
          existingIds = new Set(snapshotMsgs.map(m => m?.info?.id).filter(Boolean));
        }
      } catch (e) {
        console.error('[Telegram] Failed to snapshot messages:', e);
      }

      // Build prompt body
      const promptBody = {
        parts: [{ type: 'text', text: prompt }]
      };
      if (session.model) {
        promptBody.model = {
          providerID: session.model.providerId,
          modelID: session.model.modelId
        };
      }

      // Fire prompt_async — returns 204 No Content (no body)
      const promptUrl = buildUrl(`/session/${encodeURIComponent(session.id)}/prompt_async`);
      const promptRes = await fetch(promptUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(promptBody)
      });

      if (!promptRes.ok) {
        let detail = '';
        try { detail = await promptRes.text(); } catch {}
        throw new Error(`prompt_async failed (${promptRes.status}): ${detail}`);
      }
      // Drain response body (204 has no body, but drain just in case)
      try { await promptRes.text(); } catch {}

      // Poll until the model finishes
      const MAX_POLL_MS = 5 * 60 * 1000; // 5 min
      const POLL_INTERVAL_MS = 1200;
      const INITIAL_DELAY_MS = 600;       // short initial delay to let server register
      const NO_ACTIVITY_TIMEOUT_MS = 30 * 1000; // 30s timeout if no sign of processing
      const startTime = Date.now();
      let lastProgressStatus = '';
      let hasSeenBusy = false;
      let consecutiveIdleOrMissing = 0;

      // Short initial delay so the session has time to transition to busy
      await new Promise(r => setTimeout(r, INITIAL_DELAY_MS));

      while (Date.now() - startTime < MAX_POLL_MS) {
        // --- 1. Check session status ---
        let sessionStatus = 'unknown';
        try {
          const statusResponse = await fetch(buildUrl('/session/status'), {
            headers: { 'Accept': 'application/json' }
          });
          if (statusResponse.ok) {
            const statusData = await statusResponse.json().catch(() => null);
            if (statusData && typeof statusData === 'object') {
              const entry = statusData[session.id];
              if (entry) {
                sessionStatus = entry.type || 'unknown';
                if (sessionStatus === 'busy') {
                  hasSeenBusy = true;
                  consecutiveIdleOrMissing = 0;
                }
              } else {
                // Session not in status map = idle or not yet started
                consecutiveIdleOrMissing++;
                if (hasSeenBusy) {
                  sessionStatus = 'idle';
                }
              }
            }
          }
        } catch (e) {
          // Status check failed, rely on message polling
        }

        // --- 2. Fetch messages for progress + completion detection ---
        let assistantMsg = null;
        let messages = [];
        try {
          const msgsResponse = await fetch(
            buildUrl(`/session/${encodeURIComponent(session.id)}/message`),
            { headers: { 'Accept': 'application/json' } }
          );
          if (msgsResponse.ok) {
            const messagesPayload = await msgsResponse.json().catch(() => []);
            messages = normalizeListPayload(messagesPayload);
            // Find the newest assistant message that didn't exist before
            assistantMsg = [...messages].reverse().find(m =>
              m?.info?.role === 'assistant' && !existingIds.has(m?.info?.id)
            );
          }
        } catch (e) {
          // ignore
        }

        // If we found an assistant message, we know the session WAS processing
        if (assistantMsg) {
          hasSeenBusy = true;
        }

        // --- 3. Update progress callback ---
        if (onProgress && assistantMsg) {
          try {
            const parts = assistantMsg.parts || [];
            let currentProgressStatus = '⏳ Processing...';

            for (let i = parts.length - 1; i >= 0; i--) {
              const p = parts[i];
              if (p.type === 'tool' && p.state) {
                const toolName = p.tool || 'unknown';
                const status = p.state.status || 'running';
                if (status === 'running' || status === 'pending') {
                  const title = p.state.title || toolName;
                  currentProgressStatus = `🛠️ ${title}`;
                } else if (status === 'completed') {
                  currentProgressStatus = `✅ Completed: ${p.state.title || toolName}`;
                }
                break;
              } else if (p.type === 'step-start') {
                currentProgressStatus = '🔄 Starting new step...';
                break;
              } else if (p.type === 'reasoning') {
                const preview = (p.text || '').trim().slice(-80).replace(/\n/g, ' ');
                currentProgressStatus = preview
                  ? `💭 Thinking: ...${preview}`
                  : '💭 Thinking...';
                break;
              } else if (p.type === 'text' && p.text && !p.time?.end) {
                const preview = p.text.trim().slice(-60).replace(/\n/g, ' ');
                currentProgressStatus = `✍️ Writing: ...${preview}`;
                break;
              }
            }

            if (currentProgressStatus !== lastProgressStatus) {
              lastProgressStatus = currentProgressStatus;
              await onProgress(currentProgressStatus);
            }
          } catch (e) {
            // ignore progress errors
          }
        }

        // --- 4. Check completion conditions ---

        // (a) Session status is explicitly idle
        if (sessionStatus === 'idle') {
          break;
        }

        // (b) Assistant message has a completed time
        if (assistantMsg?.info?.time?.completed) {
          break;
        }

        // (c) Assistant message has an error (model failed)
        if (assistantMsg?.info?.error) {
          break;
        }

        // (d) If session is not in status map for several consecutive polls
        //     and we have an assistant message with completed text parts, consider done
        if (assistantMsg && consecutiveIdleOrMissing >= 3) {
          const parts = assistantMsg.parts || [];
          const lastTextPart = [...parts].reverse().find(p => p.type === 'text' && p.text);
          if (lastTextPart?.time?.end) {
            break;
          }
        }

        // (e) No-activity timeout: if we haven't seen ANY sign of processing
        //     (no busy status, no assistant message) after NO_ACTIVITY_TIMEOUT_MS, give up
        if (!hasSeenBusy && (Date.now() - startTime) > NO_ACTIVITY_TIMEOUT_MS) {
          console.warn('[Telegram] No activity detected after', NO_ACTIVITY_TIMEOUT_MS, 'ms — aborting poll');
          break;
        }

        // (f) Session not in status map for many consecutive polls, and no assistant message
        //     This handles the case where prompt_async was accepted but nothing ever happened
        if (!assistantMsg && consecutiveIdleOrMissing >= 10) {
          console.warn('[Telegram] Session missing from status map for too long with no assistant message');
          break;
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      // --- Final fetch of messages ---
      let finalMessages = [];
      try {
        const finalMsgsResponse = await fetch(
          buildUrl(`/session/${encodeURIComponent(session.id)}/message`),
          { headers: { 'Accept': 'application/json' } }
        );
        if (finalMsgsResponse.ok) {
          const data = await finalMsgsResponse.json().catch(() => []);
          finalMessages = normalizeListPayload(data);
        }
      } catch (e) {
        console.error('[Telegram] Failed to fetch final messages:', e);
      }

      // Find the assistant response
      let assistantMsg = [...finalMessages].reverse().find(m =>
        m?.info?.role === 'assistant' && !existingIds.has(m?.info?.id)
      );

      if (!assistantMsg) {
        // Broader fallback: just get the very last assistant message
        assistantMsg = [...finalMessages].reverse().find(m =>
          m?.info?.role === 'assistant'
        );
      }

      if (!assistantMsg) {
        console.error('[Telegram] No assistant message found. Total messages:', finalMessages.length,
          'Existing IDs:', existingIds.size);
        return {
          success: true,
          response: 'The model completed but I could not find its response. Please try sending your message again.',
          session
        };
      }

      // Check if the assistant message has an error
      if (assistantMsg.info?.error) {
        const err = assistantMsg.info.error;
        const errMsg = err.data?.message || err.name || 'Model error';
        return {
          success: false,
          error: `Model error: ${errMsg}`
        };
      }

      return this._constructPromptResult(assistantMsg, session);
    } catch (error) {
      console.error('[Telegram] Failed to send prompt:', error);
      return {
        success: false,
        error: error.message || 'Failed to send prompt to OpenCode'
      };
    } finally {
      session.processing = false;
    }
  }

  _constructPromptResult(assistantMsg, session) {
    const parts = assistantMsg.parts || [];
    const responseTextParts = [];
    for (const p of parts) {
      if (!p) continue;
      if (p.type === 'text' && p.text && !p.synthetic) {
        responseTextParts.push(p.text.trim());
      }
    }

    let responseText = responseTextParts.join('\n').trim();
    if (!responseText) {
      // Fallback: try to get any text including from tool outputs
      const fallbackParts = [];
      for (const p of parts) {
        if (!p) continue;
        if (p.type === 'text' && p.text) {
          fallbackParts.push(p.text.trim());
        }
      }
      responseText = fallbackParts.join('\n').trim();
    }

    if (!responseText) {
      responseText = 'The model completed but produced no text output.';
    }

    return {
      success: true,
      response: responseText,
      session
    };
  }

  async undo(userId) {
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session'
      };
    }

    try {
      await session.client.session.undo(session.id);
      session.lastActivity = Date.now();
      
      return {
        success: true,
        message: 'Undo successful'
      };
    } catch (error) {
      console.error('[Telegram] Failed to undo:', error);
      return {
        success: false,
        error: error.message || 'Failed to undo'
      };
    }
  }

  async redo(userId) {
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session'
      };
    }

    try {
      await session.client.session.redo(session.id);
      session.lastActivity = Date.now();
      
      return {
        success: true,
        message: 'Redo successful'
      };
    } catch (error) {
      console.error('[Telegram] Failed to redo:', error);
      return {
        success: false,
        error: error.message || 'Failed to redo'
      };
    }
  }

  async listProjects(userId) {
    let client;
    const session = userSessions.get(userId);
    if (session) {
      client = session.client;
    } else {
      client = this.getTemporaryClient();
    }

    try {
      const response = await client.project.list();
      const rawProjects = normalizeListPayload(response);

      // The Project type has: id, worktree, vcsDir?, vcs?, time
      // Derive a user-friendly name and path from 'worktree'
      const projects = rawProjects.map(p => {
        const worktree = p.worktree || p.path || '';
        // Prefer existing name/label, fall back to basename of worktree
        const derivedName = worktree ? worktree.split('/').filter(Boolean).pop() : 'Unnamed';
        const name = p.name || p.label || derivedName;
        return {
          ...p,
          name,
          label: p.label || name,
          path: worktree || p.path || ''
        };
      });

      return {
        success: true,
        projects
      };
    } catch (error) {
      console.error('[Telegram] Failed to list projects:', error);
      return {
        success: false,
        error: error.message || 'Failed to list projects'
      };
    }
  }

  async listSessions(userId) {
    let client;
    const session = userSessions.get(userId);
    if (session) {
      client = session.client;
    } else {
      client = this.getTemporaryClient();
    }

    try {
      const sessions = await client.session.list();
      return {
        success: true,
        sessions: normalizeListPayload(sessions)
      };
    } catch (error) {
      console.error('[Telegram] Failed to list sessions:', error);
      return {
        success: false,
        error: error.message || 'Failed to list sessions'
      };
    }
  }

  async listProviders(userId) {
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session. Use /opencode to start a session.'
      };
    }

    try {
      const response = await session.client.config.providers();
      // API returns { providers: Array<Provider>, default: { ... } }
      // SDK wraps in { data: ... }
      const rawData = response?.data || response;
      const providersArray = rawData?.providers || [];
      const defaults = rawData?.default || {};

      // providersArray is Array<Provider>, each has:
      //   id: string, name: string, models: { [modelId]: Model }
      const providersList = (Array.isArray(providersArray) ? providersArray : []).map(provider => ({
        id: provider.id,
        name: provider.name || provider.id,
        models: Object.entries(provider.models || {}).map(([modelId, model]) => ({
          id: modelId,
          name: model.name || modelId
        }))
      })).filter(p => p.models.length > 0);

      return {
        success: true,
        providers: providersList,
        defaults,
        currentModel: session.model
      };
    } catch (error) {
      console.error('[Telegram] Failed to list providers:', error);
      return {
        success: false,
        error: error.message || 'Failed to list providers'
      };
    }
  }

  setSessionModel(userId, providerId, modelId) {
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session'
      };
    }

    session.model = { providerId, modelId };
    session.lastActivity = Date.now();

    return {
      success: true,
      model: { providerId, modelId }
    };
  }

  getActiveSessionCount() {
    return userSessions.size;
  }

  cleanupInactiveSessions(maxInactiveMs = 30 * 60 * 1000) {
    const now = Date.now();
    const toDelete = [];
    
    for (const [userId, session] of userSessions.entries()) {
      if (now - session.lastActivity > maxInactiveMs) {
        toDelete.push(userId);
      }
    }

    for (const userId of toDelete) {
      userSessions.delete(userId);
    }

    return toDelete.length;
  }
}

export function createSessionManager(opencodeConfig) {
  return new SessionManager(opencodeConfig);
}
