import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindSession,
  configureSessionBindings,
  flushSessionBindings,
  getSessionBinding,
  initSessionBindings,
  resetSessionBindings,
  sanitizeSessionBinding,
  updateSessionBinding,
} from './session-bindings.js';

const tempDirs = [];
const bindingInput = (sessionId, overrides = {}) => ({
  sessionId,
  harnessId: 'claude-code',
  directory: '/project',
  target: { harnessId: 'claude-code', modelRef: 'sonnet' },
  ...overrides,
});

function tempFile(name = 'bindings.json') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bindings-'));
  tempDirs.push(directory);
  return path.join(directory, name);
}

afterEach(() => {
  resetSessionBindings({ clearDisk: true });
  configureSessionBindings({ persist: false, load: false });
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('sanitizeSessionBinding', () => {
  it('keeps allowlisted identity and drops secret fields', () => {
    const binding = sanitizeSessionBinding(bindingInput('ses_1', {
      foreignSessionId: 'claude-sess',
      target: {
        harnessId: 'claude-code',
        modelRef: 'sonnet',
        token: 'secret',
        authorization: 'Bearer x',
      },
      apiKey: 'nope',
      createdAt: 1,
      updatedAt: 2,
    }));
    expect(binding).toMatchObject({
      sessionId: 'ses_1',
      harnessId: 'claude-code',
      directory: '/project',
      foreignSessionId: 'claude-sess',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    expect(binding.target.token).toBeUndefined();
    expect(binding.apiKey).toBeUndefined();
  });
});

describe('agent selection persistence', () => {
  it('stores valid agent fields on creation', () => {
    const result = bindSession(bindingInput('ses_agent', {
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    }));
    expect(result.created).toBe(true);
    expect(result.binding).toMatchObject({
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });
  });

  const invalidCases = [
    ['invalid mode', { agentsMode: 'bogus' }, 'agentsMode'],
    ['non-string OpenCode agent', { agentName: 42 }, 'agentName'],
    ['non-string Claude agent', { claudeAgentName: {} }, 'claudeAgentName'],
  ];
  for (const [name, input, field] of invalidCases) {
    it(`drops ${name}`, () => {
      expect(bindSession(bindingInput(`ses_${field}`, input)).binding[field]).toBeUndefined();
    });
  }

  it('trims and caps agent names', () => {
    const { binding } = bindSession(bindingInput('ses_long', { agentName: `  ${'a'.repeat(250)}  ` }));
    expect(binding.agentName).toBe('a'.repeat(200));
  });

  it('re-stamps supplied names and clears whitespace-only names', () => {
    bindSession(bindingInput('ses_restamp', { agentName: 'build', claudeAgentName: 'Explore' }));
    expect(bindSession(bindingInput('ses_restamp', { agentName: 'plan' })).binding).toMatchObject({
      agentName: 'plan',
      claudeAgentName: 'Explore',
    });
    const { binding } = bindSession(bindingInput('ses_restamp', { agentName: '   ' }));
    expect(binding.agentName).toBeUndefined();
    expect(binding.claudeAgentName).toBe('Explore');
  });

  it('retains omitted agent fields when updating another binding field', () => {
    bindSession(bindingInput('ses_keep', {
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    }));
    expect(bindSession(bindingInput('ses_keep', {
      directory: '/project2',
      target: { harnessId: 'claude-code', modelRef: 'opus' },
    })).binding).toMatchObject({
      directory: '/project2',
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });
  });
});

describe('durable session bindings', () => {
  it('round-trips the allowlisted payload with secure file permissions', () => {
    const filePath = tempFile('harness-session-bindings.json');
    configureSessionBindings({ filePath, persist: true, debounceMs: 0, load: true });
    bindSession(bindingInput('ses_persist', {
      directory: '/tmp/project',
      target: {
        harnessId: 'claude-code',
        modelRef: 'opus',
        permissionMode: 'default',
        effort: 'high',
      },
      foreignSessionId: 'foreign_1',
    }));
    updateSessionBinding('ses_persist', { lastError: { code: 'X', message: 'y', at: 123 } });
    flushSessionBindings();

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(raw).toMatchObject({ version: 1, bindings: [{ sessionId: 'ses_persist' }] });
    expect(JSON.stringify(raw)).not.toMatch(/token|secret|Bearer|apiKey/i);

    resetSessionBindings();
    configureSessionBindings({ filePath, persist: true, debounceMs: 0, load: true });
    expect(getSessionBinding('ses_persist')).toMatchObject({
      directory: '/tmp/project',
      foreignSessionId: 'foreign_1',
      target: { modelRef: 'opus', permissionMode: 'default', effort: 'high' },
      lastError: { code: 'X', message: 'y', at: 123 },
    });
  });

  it('prunes the oldest bindings by updatedAt', () => {
    const filePath = tempFile();
    configureSessionBindings({ filePath, persist: true, debounceMs: 0, maxBindings: 2, load: true });
    for (const [index, id] of ['old', 'mid', 'new'].entries()) {
      bindSession(bindingInput(`ses_${id}`, { directory: `/${id}` }));
      getSessionBinding(`ses_${id}`).updatedAt = index + 1;
    }
    flushSessionBindings();
    resetSessionBindings();
    initSessionBindings({ filePath, persist: true, debounceMs: 0 });
    expect(getSessionBinding('ses_old')).toBeNull();
    expect(getSessionBinding('ses_mid')).not.toBeNull();
    expect(getSessionBinding('ses_new')).not.toBeNull();
  });

  it('can clear persisted and in-memory bindings', () => {
    const filePath = tempFile();
    configureSessionBindings({ filePath, persist: true, debounceMs: 0, load: true });
    bindSession(bindingInput('ses_x'));
    flushSessionBindings();
    resetSessionBindings({ clearDisk: true });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(getSessionBinding('ses_x')).toBeNull();
  });
});
