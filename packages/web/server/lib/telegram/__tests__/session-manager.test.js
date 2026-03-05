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
    it('should return error if no session exists', async () => {
      const result = await sessionManager.listProjects(12345);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active session');
    });
  });

  describe('listSessions', () => {
    it('should return error if no session exists', async () => {
      const result = await sessionManager.listSessions(12345);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active session');
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
});
