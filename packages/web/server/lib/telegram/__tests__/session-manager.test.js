import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager, createSessionManager } from '../session-manager.js';

describe('SessionManager', () => {
  let sessionManager;

  beforeEach(() => {
    sessionManager = createSessionManager({
      baseUrl: 'http://localhost:3000'
    });
  });

  describe('getSession', () => {
    it('should return undefined for non-existent session', () => {
      const session = sessionManager.getSession(12345);
      expect(session).toBeUndefined();
    });
  });

  describe('endSession', () => {
    it('should return error if no session exists', async () => {
      const result = await sessionManager.endSession(12345);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active session');
    });
  });

  describe('sendPrompt', () => {
    it('should return error if no session exists', async () => {
      const result = await sessionManager.sendPrompt(12345, 'Hello');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active session');
    });
  });

  describe('undo/redo', () => {
    it('should return error if no session exists for undo', async () => {
      const result = await sessionManager.undo(12345);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active session');
    });

    it('should return error if no session exists for redo', async () => {
      const result = await sessionManager.redo(12345);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active session');
    });
  });

  describe('listProjects', () => {
    it('should attempt to list projects even without a session (uses temp client)', async () => {
      // listProjects no longer requires an active session;
      // it will use a temporary client. It may fail due to connection,
      // but it won't return a "No active session" error.
      const result = await sessionManager.listProjects(12345);
      // Either succeeds or fails with a connection error, not "No active session"
      if (!result.success) {
        expect(result.error).not.toContain('No active session');
      }
    });

    it('should normalize wrapped project list payloads', async () => {
      sessionManager.getTemporaryClient = () => ({
        project: {
          list: async () => ({
            data: [
              { id: 'p1', path: '/tmp/project-1', label: 'Project One' },
              { id: 'p2', path: '/tmp/project-2', label: 'Project Two' },
            ],
          }),
        },
      });

      const result = await sessionManager.listProjects(12345);
      expect(result.success).toBe(true);
      expect(result.projects).toHaveLength(2);
      expect(result.projects[0].label).toBe('Project One');
    });
  });

  describe('listSessions', () => {
    it('should attempt to list sessions even without a session (uses temp client)', async () => {
      const result = await sessionManager.listSessions(12345);
      if (!result.success) {
        expect(result.error).not.toContain('No active session');
      }
    });

    it('should normalize wrapped session list payloads', async () => {
      sessionManager.getTemporaryClient = () => ({
        session: {
          list: async () => ({
            data: [
              { id: 's1', title: 'Session One' },
              { id: 's2', title: 'Session Two' },
            ],
          }),
        },
      });

      const result = await sessionManager.listSessions(12345);
      expect(result.success).toBe(true);
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[1].title).toBe('Session Two');
    });
  });

  describe('getActiveSessionCount', () => {
    it('should return 0 when no sessions exist', () => {
      expect(sessionManager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('cleanupInactiveSessions', () => {
    it('should remove inactive sessions', () => {
      sessionManager.cleanupInactiveSessions(0);
      expect(sessionManager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('pendingMessages', () => {
    it('should store and retrieve pending message', () => {
      sessionManager.storePendingMessage(12345, 'Hello world');
      const msg = sessionManager.getPendingMessage(12345);
      expect(msg).toBe('Hello world');
    });

    it('should return undefined after retrieval', () => {
      sessionManager.storePendingMessage(12345, 'Test');
      sessionManager.getPendingMessage(12345);
      const msg = sessionManager.getPendingMessage(12345);
      expect(msg).toBeUndefined();
    });
  });

  describe('getTemporaryClient', () => {
    it('should return a client object', () => {
      const client = sessionManager.getTemporaryClient();
      expect(client).toBeDefined();
    });
  });
});
