import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_CODE_MODELS,
  getHarnessCapabilities,
  getHarnessDescriptor,
  HARNESS_IDS,
  isKnownHarnessId,
  listHarnessDescriptors,
} from './registry.js';

describe('harness registry', () => {
  it('lists opencode, claude-code, and cursor', () => {
    expect([...HARNESS_IDS]).toEqual(['opencode', 'claude-code', 'cursor']);
    const ids = listHarnessDescriptors().map((d) => d.id);
    expect(ids).toEqual(['opencode', 'claude-code', 'cursor']);
  });

  it('exposes Claude Code subscription auth and capability matrix', () => {
    const claude = getHarnessDescriptor('claude-code');
    expect(claude.displayName).toBe('Claude Code');
    expect(claude.auth.mode).toBe('subscription-cli');
    expect(claude.install.binaryNames).toContain('claude');
    expect(claude.capabilities.prompt).toBe('full');
    expect(claude.capabilities.multirun).toBe('none');
    expect(claude.capabilities.goal).toBe('none');
    expect(claude.capabilities['openchamber-tool']).toBe('none');
    expect(CLAUDE_CODE_MODELS.length).toBeGreaterThan(0);
  });

  it('exposes Cursor subscription-oauth auth without a CLI binary', () => {
    const cursor = getHarnessDescriptor('cursor');
    expect(cursor).not.toBeNull();
    expect(cursor.displayName).toBe('Cursor');
    expect(cursor.auth.mode).toBe('subscription-oauth');
    expect(cursor.install.binaryNames).toEqual([]);
    expect(cursor.capabilities.prompt).toBe('full');
    expect(cursor.capabilities['streaming-tools']).toBe('full');
    expect(cursor.capabilities.shell).toBe('full');
    expect(cursor.capabilities.mcp).toBe('partial');
    expect(cursor.capabilities.permissions).toBe('none');
    expect(isKnownHarnessId('cursor')).toBe(true);
  });

  it('exposes OpenCode provider auth mode', () => {
    const opencode = getHarnessDescriptor('opencode');
    expect(opencode.auth.mode).toBe('opencode-providers');
    expect(getHarnessCapabilities('opencode').multirun).toBe('full');
  });

  it('rejects unknown harness ids', () => {
    expect(isKnownHarnessId('codex-cli')).toBe(false);
    expect(getHarnessDescriptor('nope')).toBeNull();
    expect(getHarnessCapabilities('nope')).toBeNull();
  });
});
