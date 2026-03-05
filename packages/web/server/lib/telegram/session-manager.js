import { createOpencodeClient } from '@opencode-ai/sdk';

const userSessions = new Map();

export class SessionManager {
  constructor(opencodeConfig = {}) {
    this.opencodeConfig = opencodeConfig;
  }

  getSession(userId) {
    return userSessions.get(userId);
  }

  async createSession(userId, title = 'Telegram Session') {
    const existingSession = userSessions.get(userId);
    if (existingSession) {
      return {
        success: false,
        error: 'Session already exists. Use /endsession first.',
        session: existingSession
      };
    }

    try {
      const client = createOpencodeClient({
        baseUrl: this.opencodeConfig.baseUrl || `http://localhost:${this.opencodeConfig.port || 3000}`
      });

      const session = await client.session.create({
        title,
        directory: process.cwd()
      });

      const sessionData = {
        id: session.id,
        title: session.title || title,
        client,
        createdAt: Date.now(),
        lastActivity: Date.now()
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

  async sendPrompt(userId, prompt) {
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session. Use /opencode to start a session.'
      };
    }

    try {
      session.lastActivity = Date.now();
      
      const response = await session.client.message.create({
        sessionId: session.id,
        content: prompt,
        role: 'user'
      });

      return {
        success: true,
        response: response.content || response.message || 'No response',
        session
      };
    } catch (error) {
      console.error('[Telegram] Failed to send prompt:', error);
      return {
        success: false,
        error: error.message || 'Failed to send prompt to OpenCode'
      };
    }
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
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session'
      };
    }

    try {
      const projects = await session.client.project.list();
      return {
        success: true,
        projects: projects || []
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
    const session = userSessions.get(userId);
    if (!session) {
      return {
        success: false,
        error: 'No active session'
      };
    }

    try {
      const sessions = await session.client.session.list();
      return {
        success: true,
        sessions: sessions || []
      };
    } catch (error) {
      console.error('[Telegram] Failed to list sessions:', error);
      return {
        success: false,
        error: error.message || 'Failed to list sessions'
      };
    }
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
