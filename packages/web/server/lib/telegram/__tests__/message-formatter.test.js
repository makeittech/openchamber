import { describe, it, expect } from 'vitest';
import {
  formatMessage,
  formatHelpMessage,
  formatWelcomeMessage,
  formatSessionInfo,
  formatProjectsList,
  formatSessionsList,
  formatErrorResponse,
  escapeMarkdown,
  formatFileUploadInfo
} from '../message-formatter.js';

describe('message-formatter', () => {
  describe('formatMessage', () => {
    it('should handle null/undefined input', () => {
      expect(formatMessage(null)).toEqual(['No content']);
      expect(formatMessage(undefined)).toEqual(['No content']);
    });

    it('should return single chunk for short messages', () => {
      const text = 'Short message';
      const result = formatMessage(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text);
    });

    it('should split long messages into chunks', () => {
      const text = 'a'.repeat(5000);
      const result = formatMessage(text);
      expect(result.length).toBeGreaterThan(1);
      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      });
    });
  });

  describe('formatHelpMessage', () => {
    it('should return help message with commands', () => {
      const help = formatHelpMessage();
      expect(help).toContain('/start');
      expect(help).toContain('/opencode');
      expect(help).toContain('/endsession');
    });
  });

  describe('formatWelcomeMessage', () => {
    it('should return welcome message with options', () => {
      const welcome = formatWelcomeMessage();
      expect(welcome).toContain('Welcome');
      expect(welcome).toContain('Open a project');
      expect(welcome).toContain('Resume a session');
      expect(welcome).toContain('Chat freely');
    });
  });

  describe('formatSessionInfo', () => {
    it('should handle null session', () => {
      expect(formatSessionInfo(null)).toBe('No active session');
    });

    it('should format session info correctly', () => {
      const session = {
        id: 'test-id',
        title: 'Test Session',
        createdAt: Date.now() - 65000
      };
      const info = formatSessionInfo(session);
      expect(info).toContain('test-id');
      expect(info).toContain('Test Session');
      expect(info).toContain('1m');
    });
  });

  describe('formatProjectsList', () => {
    it('should handle empty list', () => {
      expect(formatProjectsList([])).toBe('No projects found');
      expect(formatProjectsList(null)).toBe('No projects found');
    });

    it('should format project list', () => {
      const projects = [
        { name: 'Project 1' },
        { name: 'Project 2' }
      ];
      const result = formatProjectsList(projects);
      expect(result).toContain('Project 1');
      expect(result).toContain('Project 2');
    });

    it('should prefer project label over name/path', () => {
      const projects = [
        { label: 'My Friendly Project', name: 'fallback-name', path: '/tmp/fallback-path' }
      ];
      const result = formatProjectsList(projects);
      expect(result).toContain('My Friendly Project');
      expect(result).not.toContain('fallback-name');
    });

    it('should limit to 20 projects', () => {
      const projects = Array(25).fill(null).map((_, i) => ({ name: `Project ${i}` }));
      const result = formatProjectsList(projects);
      expect(result).toContain('and 5 more');
    });
  });

  describe('formatSessionsList', () => {
    it('should handle empty list', () => {
      expect(formatSessionsList([])).toBe('No sessions found');
      expect(formatSessionsList(null)).toBe('No sessions found');
    });

    it('should format session list', () => {
      const sessions = [
        { id: 'session-1', title: 'Session 1' },
        { id: 'session-2', title: 'Session 2' }
      ];
      const result = formatSessionsList(sessions);
      expect(result).toContain('Session 1');
      expect(result).toContain('Session 2');
    });
  });

  describe('formatErrorResponse', () => {
    it('should handle string error', () => {
      const result = formatErrorResponse('Test error');
      expect(result).toContain('Test error');
      expect(result).toContain('Error');
    });

    it('should handle Error object', () => {
      const error = new Error('Error message');
      const result = formatErrorResponse(error);
      expect(result).toContain('Error message');
    });
  });

  describe('escapeMarkdown', () => {
    it('should escape special characters', () => {
      expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*');
      expect(escapeMarkdown('_italic_')).toBe('\\_italic\\_');
      expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
    });

    it('should handle empty string', () => {
      expect(escapeMarkdown('')).toBe('');
    });
  });

  describe('formatFileUploadInfo', () => {
    it('should format file upload info', () => {
      const result = formatFileUploadInfo('/tmp/test.txt', 'test.txt');
      expect(result).toContain('test.txt');
      expect(result).toContain('/tmp/test.txt');
    });
  });
});
