import { describe, expect, test } from 'bun:test';

import { getVisiblePermissionPatterns } from './permissionCardPatterns';
import { isPermissionFromSubagent } from './permissionCardSubagent';

describe('getVisiblePermissionPatterns', () => {
  test('omits a pattern already rendered as the bash command', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns([command], command)).toEqual([]);
  });

  test('preserves distinct permission patterns', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns(['bunx eslint *', command], command)).toEqual(['bunx eslint *']);
  });
});

describe('isPermissionFromSubagent', () => {
  const permission = (sessionID: string, metadata: Record<string, unknown> = {}) => ({
    id: 'perm_1',
    sessionID,
    permission: 'bash',
    patterns: [],
    metadata,
    always: [],
  });

  test('trusts the ask metadata over session-list lineage', () => {
    const synthetic = permission('ses_claude_sub_12345_toolu_a', {
      fromSubagent: true,
      parentSessionID: 'ses_parent',
    });
    expect(isPermissionFromSubagent(synthetic, 'ses_parent', [])).toBe(true);
    // Even when the child id is not present in the visible session list.
    expect(isPermissionFromSubagent(synthetic, 'ses_parent', [
      { id: 'ses_other', parentID: null },
    ])).toBe(true);
  });

  test('resolves OpenCode task children through the session parentID link', () => {
    expect(isPermissionFromSubagent(
      permission('ses_child'),
      'ses_parent',
      [{ id: 'ses_child', parentID: 'ses_parent' }],
    )).toBe(true);

    expect(isPermissionFromSubagent(
      permission('ses_child'),
      'ses_parent',
      [{ id: 'ses_child', parentID: 'ses_other' }],
    )).toBe(false);
  });

  test('returns false for the current session or unknown sessions', () => {
    expect(isPermissionFromSubagent(permission('ses_parent'), 'ses_parent', [])).toBe(false);
    expect(isPermissionFromSubagent(permission('ses_unknown'), 'ses_parent', [])).toBe(false);
    expect(isPermissionFromSubagent(permission('ses_unknown'), undefined, [])).toBe(false);
  });
});
