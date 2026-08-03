import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MAX_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MIN_MS,
  MessengerBridgeStore,
} from './messenger-bridge-store.js';

describe('MessengerBridgeStore — permission mode persistence', () => {
  let dbPath;
  let store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `openchamber-agent-store-${crypto.randomBytes(6).toString('hex')}.sqlite`);
    store = new MessengerBridgeStore({ dbPath });
  });

  afterEach(() => {
    try {
      store.db.close();
    } catch {
      // ignore
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore
      }
    }
  });

  const surface = { type: 'discord', botTokenHash: 'hash', targetKey: 'chan-1' };

  it('round-trips a per-surface permission mode override', () => {
    store.setOverrides({ ...surface, permissionModeOverride: 'yolo' });
    expect(store.lookup(surface)?.permissionModeOverride).toBe('yolo');

    store.setOverrides({ ...surface, permissionModeOverride: null });
    expect(store.lookup(surface)?.permissionModeOverride).toBeNull();
  });

  it('does not clobber other overrides when only setting the permission mode', () => {
    store.setOverrides({ ...surface, modelOverride: 'anthropic/sonnet', verbosityOverride: 'verbose' });
    store.setOverrides({ ...surface, permissionModeOverride: 'agent' });
    const row = store.lookup(surface);
    expect(row.modelOverride).toBe('anthropic/sonnet');
    expect(row.verbosityOverride).toBe('verbose');
    expect(row.permissionModeOverride).toBe('agent');
  });

  it('round-trips the project-default permission mode', () => {
    store.setProjectDefaults({ projectPath: '/proj', projectLabel: 'Proj', permissionModeDefault: 'yolo' });
    expect(store.getProjectDefaults('/proj')?.permissionModeDefault).toBe('yolo');

    // Setting an unrelated project default preserves the permission mode.
    store.setProjectDefaults({ projectPath: '/proj', modelDefault: 'anthropic/sonnet' });
    const pd = store.getProjectDefaults('/proj');
    expect(pd.permissionModeDefault).toBe('yolo');
    expect(pd.modelDefault).toBe('anthropic/sonnet');
  });

  it('round-trips the project auto-worktree default without clobbering other defaults', () => {
    store.setProjectDefaults({ projectPath: '/proj', projectLabel: 'Proj', autoWorktreeDefault: 1 });
    expect(store.getProjectDefaults('/proj')?.autoWorktreeDefault).toBe(1);

    store.setProjectDefaults({ projectPath: '/proj', agentDefault: 'build' });
    const pd = store.getProjectDefaults('/proj');
    expect(pd.autoWorktreeDefault).toBe(1);
    expect(pd.agentDefault).toBe('build');
  });

  it('round-trips the messenger-wide permission mode default', () => {
    expect(store.getPermissionModeDefault('discord')).toBeNull();
    store.setPermissionModeDefault('discord', 'agent');
    expect(store.getPermissionModeDefault('discord')).toBe('agent');
    store.setPermissionModeDefault('discord', null);
    expect(store.getPermissionModeDefault('discord')).toBeNull();
  });

  it('round-trips the notify-on-complete setting', () => {
    expect(store.getNotifyOnComplete('discord')).toBe(false);
    store.setNotifyOnComplete('discord', true);
    expect(store.getNotifyOnComplete('discord')).toBe(true);
    store.setNotifyOnComplete('discord', false);
    expect(store.getNotifyOnComplete('discord')).toBe(false);
  });

  it('keeps critique uploads off by default and round-trips the opt-in', () => {
    // External code sharing must be opt-in: never enabled before the user acts.
    expect(store.getCritiqueEnabled('discord')).toBe(false);
    store.setCritiqueEnabled('discord', true);
    expect(store.getCritiqueEnabled('discord')).toBe(true);
    store.setCritiqueEnabled('discord', false);
    expect(store.getCritiqueEnabled('discord')).toBe(false);
  });

  it('normalizes and persists the interrupt timeout setting', () => {
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS);
    store.setInterruptTimeoutMs('discord', 1234.6);
    expect(store.getInterruptTimeoutMs('discord')).toBe(1235);
    store.setInterruptTimeoutMs('discord', -1);
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_MIN_MS);
    store.setInterruptTimeoutMs('discord', 999999);
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_MAX_MS);
    store.setInterruptTimeoutMs('discord', MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS);
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS);
  });
});

describe('MessengerBridgeStore — worktree bindings', () => {
  let dbPath;
  let store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `openchamber-agent-store-${crypto.randomBytes(6).toString('hex')}.sqlite`);
    store = new MessengerBridgeStore({ dbPath });
  });

  afterEach(() => {
    try {
      store.db.close();
    } catch {
      // ignore
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore
      }
    }
  });

  it('binds and looks up worktrees by path', () => {
    store.bindWorktree({
      botTokenHash: 'hash',
      projectRoot: '/repo',
      worktreePath: '/repo/.worktrees/feature',
      branch: 'feature',
      channelId: 'chan-1',
      threadId: 'thread-1',
    });
    const row = store.lookupWorktreeByPath({
      botTokenHash: 'hash',
      worktreePath: '/repo/.worktrees/feature',
    });
    expect(row?.threadId).toBe('thread-1');
    expect(row?.branch).toBe('feature');
    expect(store.lookupWorktreeByThread({ botTokenHash: 'hash', threadId: 'thread-1' })?.worktreePath).toBe(
      '/repo/.worktrees/feature',
    );
    expect(store.listWorktreesForProject({ botTokenHash: 'hash', projectRoot: '/repo' })).toHaveLength(1);
    store.unbindWorktree({ botTokenHash: 'hash', worktreePath: '/repo/.worktrees/feature' });
    expect(
      store.lookupWorktreeByPath({ botTokenHash: 'hash', worktreePath: '/repo/.worktrees/feature' }),
    ).toBeNull();
  });

  it('preserves worktree context on re-bind without worktree fields', () => {
    const surface = { type: 'discord', botTokenHash: 'hash', targetKey: 'thread-1' };
    store.bind({
      ...surface,
      sessionId: 'ses-1',
      projectPath: '/repo/.worktrees/feature',
      projectLabel: 'Repo (feature)',
      projectRoot: '/repo',
      worktreePath: '/repo/.worktrees/feature',
      branch: 'feature',
    });
    // Older call sites re-bind with only session/project — the worktree
    // columns must survive instead of being nulled.
    store.bind({ ...surface, sessionId: 'ses-2', projectPath: '/repo/.worktrees/feature' });
    const row = store.lookup(surface);
    expect(row.sessionId).toBe('ses-2');
    expect(row.projectRoot).toBe('/repo');
    expect(row.worktreePath).toBe('/repo/.worktrees/feature');
    expect(row.branch).toBe('feature');
  });
});
