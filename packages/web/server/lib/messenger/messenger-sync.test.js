import { describe, expect, it } from 'vitest';
import {
  findBindingForPath,
  mergeProjectBindings,
  normalizeMessengerPath,
  resolveProjectChannel,
} from './messenger-sync.js';

describe('mergeProjectBindings (per-server project sync)', () => {
  it('accumulates bindings across servers instead of replacing them', () => {
    // Server A synced project /proj into channel a1.
    const afterServerA = mergeProjectBindings(undefined, [
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
    expect(afterServerA).toEqual([
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);

    // Server B syncs the SAME project into a different channel b1 — the earlier
    // server's binding must survive so inbound routing keeps working for both.
    const afterServerB = mergeProjectBindings(afterServerA, [
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
    expect(afterServerB).toEqual([
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
  });

  it('does not shrink when a later save knows only the primary server', () => {
    const prev = [
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ];
    // A frequent saveDiscordConfig only carries the primary channel a1.
    const merged = mergeProjectBindings(prev, [
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj (renamed)' },
    ]);
    // b1 preserved; a1 updated with the incoming label.
    expect(merged).toEqual([
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj (renamed)' },
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
  });

  it('dedupes by channelId and drops malformed entries', () => {
    const merged = mergeProjectBindings(
      [{ channelId: 'a1', projectPath: '/one' }],
      [
        { channelId: 'a1', projectPath: '/one-updated' },
        { channelId: '', projectPath: '/bad' },
        { projectPath: '/no-channel' },
        null,
      ],
    );
    expect(merged).toEqual([{ channelId: 'a1', projectPath: '/one-updated', projectLabel: undefined }]);
  });

  it('returns an empty list for empty input', () => {
    expect(mergeProjectBindings(undefined, undefined)).toEqual([]);
    expect(mergeProjectBindings(null, [])).toEqual([]);
  });
});

describe('normalizeMessengerPath', () => {
  it('trims, normalizes slashes, and strips trailing separators', () => {
    expect(normalizeMessengerPath('  /proj/foo\\bar/  ')).toBe('/proj/foo/bar');
    expect(normalizeMessengerPath('/')).toBe('/');
    expect(normalizeMessengerPath('')).toBe('');
    expect(normalizeMessengerPath(null)).toBe('');
  });
});

describe('findBindingForPath', () => {
  const bindings = [
    { channelId: 'root', projectPath: '/proj', projectLabel: 'Proj' },
    { channelId: 'nested', projectPath: '/proj/nested', projectLabel: 'Nested' },
  ];

  it('prefers an exact match, then the longest containing project path', () => {
    expect(findBindingForPath(bindings, '/proj/nested')).toEqual(bindings[1]);
    expect(findBindingForPath(bindings, '/proj/nested/src')).toEqual(bindings[1]);
    expect(findBindingForPath(bindings, '/proj/other')).toEqual(bindings[0]);
  });

  it('returns null when the path is outside every binding', () => {
    expect(findBindingForPath(bindings, '/other')).toBeNull();
    expect(findBindingForPath(bindings, '')).toBeNull();
  });
});

describe('resolveProjectChannel (worktree → primary project)', () => {
  const discord = {
    projectBindings: [
      { channelId: 'proj-channel', projectPath: '/home/user/openchamber', projectLabel: 'OpenChamber' },
      { channelId: 'other-channel', projectPath: '/home/user/other', projectLabel: 'Other' },
    ],
    defaultChannelId: 'general',
  };

  it('matches an exact project binding', async () => {
    const result = await resolveProjectChannel({
      discord,
      projectPath: '/home/user/openchamber',
      resolvePrimaryRoot: async () => null,
    });
    expect(result).toEqual({ channelId: 'proj-channel', projectLabel: 'OpenChamber' });
  });

  it('routes linked worktrees through the git primary root binding', async () => {
    // OpenCode linked worktrees live under a data dir outside the project tree,
    // so exact path match fails and previously fell through to #general.
    const worktreePath =
      '/home/ubuntu/.local/share/opencode/worktree/abc123/origin-cursor-feature';
    const result = await resolveProjectChannel({
      discord,
      projectPath: worktreePath,
      resolvePrimaryRoot: async (directory) => {
        expect(directory).toBe(worktreePath);
        return '/home/user/openchamber';
      },
    });
    expect(result).toEqual({ channelId: 'proj-channel', projectLabel: 'OpenChamber' });
  });

  it('falls back to bridge-store bindings for the primary root', async () => {
    const worktreePath = '/tmp/opencode-worktrees/feature-x';
    const bridgeStore = {
      list: () => [
        {
          type: 'discord',
          targetKey: 'store-channel',
          sessionId: '',
          projectPath: '/home/user/openchamber',
          projectLabel: 'FromStore',
        },
      ],
    };
    const result = await resolveProjectChannel({
      discord: { projectBindings: [], defaultChannelId: 'general' },
      projectPath: worktreePath,
      bridgeStore,
      resolvePrimaryRoot: async () => '/home/user/openchamber',
    });
    expect(result).toEqual({ channelId: 'store-channel', projectLabel: 'FromStore' });
  });

  it('returns null when neither the path nor its primary root is bound', async () => {
    const result = await resolveProjectChannel({
      discord,
      projectPath: '/tmp/unrelated-worktree',
      resolvePrimaryRoot: async () => '/tmp/unrelated-primary',
    });
    expect(result).toBeNull();
  });
});
