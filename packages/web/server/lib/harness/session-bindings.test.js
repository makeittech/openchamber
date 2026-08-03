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

/** @type {string[]} */
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bindings-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetSessionBindings({ clearDisk: true });
  configureSessionBindings({ persist: false, load: false });
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('sanitizeSessionBinding', () => {
  it('drops secret-like fields and keeps sticky identity', () => {
    const binding = sanitizeSessionBinding({
      sessionId: 'ses_1',
      harnessId: 'claude-code',
      directory: '/project',
      target: {
        harnessId: 'claude-code',
        modelRef: 'sonnet',
        token: 'secret',
        authorization: 'Bearer x',
      },
      apiKey: 'nope',
      foreignSessionId: 'claude-sess',
      createdAt: 1,
      updatedAt: 2,
    });

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
  it('bindSession on a new session persists agentsMode, agentName, and claudeAgentName', () => {
    const { binding, created } = bindSession({
      sessionId: 'ses_new_agent',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });

    expect(created).toBe(true);
    expect(binding).toMatchObject({
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });
  });

  it('drops an invalid agentsMode value', () => {
    const { binding } = bindSession({
      sessionId: 'ses_bad_mode',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'bogus',
    });

    expect(binding.agentsMode).toBeUndefined();
  });

  it('trims agentName and caps it at 200 characters', () => {
    const long = `  ${'a'.repeat(250)}  `;
    const { binding } = bindSession({
      sessionId: 'ses_long_name',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentName: long,
    });

    expect(binding.agentName).toBe('a'.repeat(200));
    expect(binding.agentName).toHaveLength(200);
  });

  it('replaces agentName when re-binding the same session with a new value', () => {
    bindSession({
      sessionId: 'ses_restamp',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentName: 'build',
    });

    const { binding, created } = bindSession({
      sessionId: 'ses_restamp',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentName: 'plan',
    });

    expect(created).toBe(false);
    expect(binding.agentName).toBe('plan');
  });

  it('removes the stored agentName when re-binding with a whitespace-only value', () => {
    bindSession({
      sessionId: 'ses_clear',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentName: 'build',
    });

    const { binding } = bindSession({
      sessionId: 'ses_clear',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentName: '   ',
    });

    expect(binding.agentName).toBeUndefined();
    expect('agentName' in binding).toBe(false);
  });

  it('leaves previously stored agent fields intact when re-binding without them', () => {
    bindSession({
      sessionId: 'ses_keep',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });

    const { binding } = bindSession({
      sessionId: 'ses_keep',
      harnessId: 'claude-code',
      directory: '/project2',
      target: { harnessId: 'claude-code', modelRef: 'opus' },
    });

    expect(binding).toMatchObject({
      directory: '/project2',
      agentsMode: 'claude',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });
  });

  it('round-trips agent fields through sanitizeSessionBinding and drops a non-string agentName', () => {
    const clean = sanitizeSessionBinding({
      sessionId: 'ses_roundtrip',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code' },
      createdAt: 1,
      updatedAt: 2,
      agentsMode: 'opencode',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });

    expect(clean).toMatchObject({
      agentsMode: 'opencode',
      agentName: 'build',
      claudeAgentName: 'Explore',
    });

    const dirty = sanitizeSessionBinding({
      sessionId: 'ses_roundtrip2',
      harnessId: 'claude-code',
      directory: '/project',
      target: { harnessId: 'claude-code' },
      createdAt: 1,
      updatedAt: 2,
      agentName: 42,
      claudeAgentName: { nested: true },
    });

    expect(dirty.agentName).toBeUndefined();
    expect(dirty.claudeAgentName).toBeUndefined();
  });
});

describe('durable session bindings', () => {
  it('round-trips persist and load', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'harness-session-bindings.json');

    configureSessionBindings({
      filePath,
      persist: true,
      debounceMs: 0,
      load: true,
    });

    bindSession({
      sessionId: 'ses_persist',
      harnessId: 'claude-code',
      directory: '/tmp/project',
      target: {
        harnessId: 'claude-code',
        modelRef: 'opus',
        permissionMode: 'default',
        effort: 'high',
      },
      foreignSessionId: 'foreign_1',
    });
    updateSessionBinding('ses_persist', {
      lastError: { code: 'X', message: 'y', at: 123 },
    });
    flushSessionBindings();

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.bindings).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toMatch(/token|secret|Bearer|apiKey/i);

    resetSessionBindings();
    configureSessionBindings({
      filePath,
      persist: true,
      debounceMs: 0,
      load: true,
    });

    const loaded = getSessionBinding('ses_persist');
    expect(loaded).toMatchObject({
      sessionId: 'ses_persist',
      harnessId: 'claude-code',
      directory: '/tmp/project',
      foreignSessionId: 'foreign_1',
      target: {
        harnessId: 'claude-code',
        modelRef: 'opus',
        permissionMode: 'default',
        effort: 'high',
      },
      lastError: { code: 'X', message: 'y', at: 123 },
    });
  });

  it('prunes oldest bindings by updatedAt when over max', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'bindings.json');
    configureSessionBindings({
      filePath,
      persist: true,
      debounceMs: 0,
      maxBindings: 2,
      load: true,
    });

    bindSession({
      sessionId: 'ses_old',
      harnessId: 'claude-code',
      directory: '/a',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    // Ensure distinct updatedAt ordering.
    const old = getSessionBinding('ses_old');
    old.updatedAt = 1;
    bindSession({
      sessionId: 'ses_mid',
      harnessId: 'claude-code',
      directory: '/b',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    getSessionBinding('ses_mid').updatedAt = 2;
    bindSession({
      sessionId: 'ses_new',
      harnessId: 'claude-code',
      directory: '/c',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    });
    getSessionBinding('ses_new').updatedAt = 3;
    flushSessionBindings();

    resetSessionBindings();
    initSessionBindings({ filePath, persist: true, debounceMs: 0 });
    expect(getSessionBinding('ses_old')).toBeNull();
    expect(getSessionBinding('ses_mid')?.sessionId).toBe('ses_mid');
    expect(getSessionBinding('ses_new')?.sessionId).toBe('ses_new');
  });

  it('resetSessionBindings can clear disk', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'bindings.json');
    configureSessionBindings({ filePath, persist: true, debounceMs: 0, load: true });
    bindSession({
      sessionId: 'ses_x',
      harnessId: 'opencode',
      directory: '/p',
      target: { harnessId: 'opencode', providerId: 'a', modelId: 'b' },
    });
    flushSessionBindings();
    expect(fs.existsSync(filePath)).toBe(true);

    resetSessionBindings({ clearDisk: true });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(getSessionBinding('ses_x')).toBeNull();
  });
});
