import { describe, expect, test } from 'bun:test';
import {
  commitsMatchPrHead,
  resolvePrBaseRepoUrl,
  resolvePrWorktreeConfig,
} from './prWorktreeConfig';
import type { GitHubPullRequestSummary } from '@/lib/api/types';

const basePr = (overrides: Partial<GitHubPullRequestSummary> = {}): GitHubPullRequestSummary => ({
  number: 42,
  title: 'Add login',
  url: 'https://github.com/openchamber/openchamber/pull/42',
  state: 'open',
  draft: false,
  base: 'main',
  head: 'feature/login',
  headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  headLabel: 'alice:feature/login',
  headRepo: {
    owner: 'alice',
    repo: 'openchamber',
    url: 'https://github.com/alice/openchamber',
    cloneUrl: 'https://github.com/alice/openchamber.git',
    sshUrl: 'git@github.com:alice/openchamber.git',
  },
  baseRepo: {
    owner: 'openchamber',
    repo: 'openchamber',
    url: 'https://github.com/openchamber/openchamber',
    cloneUrl: 'https://github.com/openchamber/openchamber.git',
    sshUrl: 'git@github.com:openchamber/openchamber.git',
  },
  ...overrides,
});

describe('resolvePrBaseRepoUrl', () => {
  test('prefers HTTPS cloneUrl over sshUrl for credential-light fallback', () => {
    expect(resolvePrBaseRepoUrl(basePr())).toBe('https://github.com/openchamber/openchamber.git');
  });
});

describe('commitsMatchPrHead', () => {
  test('matches full and abbreviated SHAs', () => {
    expect(commitsMatchPrHead('abcdef1234', 'abcdef1234')).toBe(true);
    expect(commitsMatchPrHead('abcdef1234567890', 'abcdef1234')).toBe(true);
    expect(commitsMatchPrHead('abcdef1234', 'abcdef1234567890')).toBe(true);
    expect(commitsMatchPrHead('aaaaaaaa', 'bbbbbbbb')).toBe(false);
    expect(commitsMatchPrHead('', 'abcdef')).toBe(false);
  });
});

describe('resolvePrWorktreeConfig', () => {
  test('reuses a local branch only when its tip matches headSha', () => {
    const matched = resolvePrWorktreeConfig(
      basePr(),
      ['feature/login'],
      [],
      { 'feature/login': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    );
    expect(matched.existingBranch).toBe('feature/login');
    expect(matched.prRef).toBe(undefined);

    const stale = resolvePrWorktreeConfig(
      basePr(),
      ['feature/login'],
      [],
      { 'feature/login': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    );
    expect(stale.existingBranch).toBe('remotes/pr-alice/feature/login');
    expect(stale.prRef).toBe('refs/pull/42/head');
    expect(stale.prHeadSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(stale.prBaseRepoUrl).toBe('https://github.com/openchamber/openchamber.git');
  });

  test('reuses a remote-tracking branch only when tip matches headSha', () => {
    const matched = resolvePrWorktreeConfig(
      basePr(),
      [],
      ['origin/feature/login'],
      { 'remotes/origin/feature/login': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    );
    expect(matched.existingBranch).toBe('remotes/origin/feature/login');
    expect(matched.prRef).toBe(undefined);

    const stale = resolvePrWorktreeConfig(
      basePr(),
      [],
      ['origin/feature/login'],
      { 'remotes/origin/feature/login': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    );
    expect(stale.ensureRemoteName).toBe('pr-alice');
    expect(stale.prRef).toBe('refs/pull/42/head');
  });

  test('falls back to PR head ref when fork URL is missing', () => {
    const config = resolvePrWorktreeConfig(
      basePr({ headRepo: null }),
      [],
      [],
      {},
    );
    expect(config.prRef).toBe('refs/pull/42/head');
    expect(config.prBaseOwner).toBe('openchamber');
    expect(config.prBaseRepo).toBe('openchamber');
    expect(config.existingBranch).toBe(undefined);
  });
});
