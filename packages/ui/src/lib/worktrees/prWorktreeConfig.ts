import type { CreateGitWorktreePullRequest, GitHubPullRequestSummary } from '@/lib/api/types';

export type PrWorktreeConfig = {
  pullRequest: CreateGitWorktreePullRequest;
  sourceLabel: string;
};

const sanitizeRemoteSeed = (value: string): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'head';
};

const normalizeBranchName = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '');
};

/** Prefer HTTPS for credential-light direct fetches when no matching remote exists. */
export const resolvePrBaseRepoUrl = (pr: GitHubPullRequestSummary): string => {
  const url = pr.baseRepo?.cloneUrl || pr.baseRepo?.sshUrl || '';
  return url.trim();
};

/**
 * Linked-PR worktree inputs: the server always checks out `refs/pull/<n>/head`
 * from the base repository. Fork URL is optional and used only for best-effort
 * upstream tracking after create.
 */
export const resolvePrWorktreeConfig = (pr: GitHubPullRequestSummary): PrWorktreeConfig => {
  const baseRepoUrl = resolvePrBaseRepoUrl(pr);
  if (!baseRepoUrl) {
    throw new Error('PR base repository URL is unavailable');
  }

  const headBranch = normalizeBranchName(pr.head || '') || undefined;
  const ownerFromLabel = String(pr.headLabel || '').split(':')[0]?.trim();
  const headOwner = pr.headRepo?.owner || ownerFromLabel || undefined;
  const headRepoUrl = (pr.headRepo?.cloneUrl || pr.headRepo?.sshUrl || '').trim() || undefined;

  return {
    pullRequest: {
      number: pr.number,
      baseRepoUrl,
      ...(pr.baseRepo?.owner ? { baseOwner: pr.baseRepo.owner } : {}),
      ...(pr.baseRepo?.repo ? { baseRepo: pr.baseRepo.repo } : {}),
      ...(headBranch ? { headBranch } : {}),
      ...(headRepoUrl ? { headRepoUrl } : {}),
      ...(headOwner ? { headOwner: sanitizeRemoteSeed(headOwner) } : {}),
    },
    sourceLabel: `#${pr.number} head`,
  };
};
