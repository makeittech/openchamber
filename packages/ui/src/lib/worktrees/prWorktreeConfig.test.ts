import { describe, expect, test } from 'bun:test';
import { resolvePrBaseRepoUrl, resolvePrWorktreeConfig } from './prWorktreeConfig';
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
  test('prefers HTTPS cloneUrl over sshUrl', () => {
    expect(resolvePrBaseRepoUrl(basePr())).toBe('https://github.com/openchamber/openchamber.git');
  });
});

describe('resolvePrWorktreeConfig', () => {
  test('always sends pullRequest identity; fork URL is optional upstream only', () => {
    const withFork = resolvePrWorktreeConfig(basePr());
    expect(withFork.sourceLabel).toBe('#42 head');
    expect(withFork.pullRequest).toEqual({
      number: 42,
      baseRepoUrl: 'https://github.com/openchamber/openchamber.git',
      baseOwner: 'openchamber',
      baseRepo: 'openchamber',
      headBranch: 'feature/login',
      headRepoUrl: 'https://github.com/alice/openchamber.git',
      headOwner: 'alice',
    });

    const deletedFork = resolvePrWorktreeConfig(basePr({ headRepo: null }));
    expect(deletedFork.pullRequest.number).toBe(42);
    expect(deletedFork.pullRequest.baseRepoUrl).toBe('https://github.com/openchamber/openchamber.git');
    expect(deletedFork.pullRequest.headRepoUrl).toBe(undefined);
    expect(deletedFork.pullRequest.headBranch).toBe('feature/login');
  });

  test('throws when base repository URL is missing', () => {
    expect(() => resolvePrWorktreeConfig(basePr({ baseRepo: null }))).toThrow('PR base repository URL is unavailable');
  });
});
