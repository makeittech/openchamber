import type { GitHubPullRequestSummary } from '@/lib/api/types';

export type PrWorktreeConfig = {
  existingBranch?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  prRef?: string;
  prBaseRepoUrl?: string;
  prBaseOwner?: string;
  prBaseRepo?: string;
  prHeadSha?: string;
  sourceLabel: string;
};

const sanitizeRemoteName = (value: string): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'pr-head';
};

const normalizeBranchName = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '');
};

/** Prefer HTTPS for credential-light direct fetch fallbacks. */
export const resolvePrBaseRepoUrl = (pr: GitHubPullRequestSummary): string | undefined => {
  const url = pr.baseRepo?.cloneUrl || pr.baseRepo?.sshUrl || '';
  return url.trim() || undefined;
};

export const commitsMatchPrHead = (candidateCommit: string | undefined, headSha: string | undefined): boolean => {
  const tip = String(candidateCommit || '').trim().toLowerCase();
  const expected = String(headSha || '').trim().toLowerCase();
  if (!tip || !expected) {
    return false;
  }
  return tip === expected || tip.startsWith(expected) || expected.startsWith(tip);
};

const resolvePrHeadRefConfig = (pr: GitHubPullRequestSummary): PrWorktreeConfig => {
  return {
    existingBranch: undefined,
    setUpstream: false,
    upstreamRemote: undefined,
    upstreamBranch: undefined,
    ensureRemoteName: undefined,
    ensureRemoteUrl: undefined,
    prRef: `refs/pull/${pr.number}/head`,
    prBaseRepoUrl: resolvePrBaseRepoUrl(pr),
    prBaseOwner: pr.baseRepo?.owner,
    prBaseRepo: pr.baseRepo?.repo,
    prHeadSha: pr.headSha,
    sourceLabel: `#${pr.number} head`,
  };
};

/**
 * Resolve worktree create inputs for a linked GitHub PR.
 *
 * `pr.headSha` is authoritative. A same-named local/remote branch is reused only
 * when its tip matches that SHA; otherwise we provision the fork remote and/or
 * fall back to `refs/pull/<n>/head` on the base repository.
 */
export const resolvePrWorktreeConfig = (
  pr: GitHubPullRequestSummary,
  localBranches: string[],
  remoteBranches: string[],
  branchCommits: Record<string, string | undefined> = {},
): PrWorktreeConfig => {
  const headBranch = normalizeBranchName(pr.head || '');
  if (!headBranch) {
    throw new Error('PR head branch is missing');
  }

  const headSha = String(pr.headSha || '').trim();
  const prFallback = {
    prRef: `refs/pull/${pr.number}/head` as const,
    prBaseRepoUrl: resolvePrBaseRepoUrl(pr),
    prBaseOwner: pr.baseRepo?.owner,
    prBaseRepo: pr.baseRepo?.repo,
    prHeadSha: pr.headSha,
  };

  if (localBranches.includes(headBranch) && commitsMatchPrHead(branchCommits[headBranch], headSha)) {
    return {
      existingBranch: headBranch,
      setUpstream: undefined,
      upstreamRemote: undefined,
      upstreamBranch: undefined,
      ensureRemoteName: undefined,
      ensureRemoteUrl: undefined,
      prRef: undefined,
      prBaseRepoUrl: undefined,
      prBaseOwner: undefined,
      prBaseRepo: undefined,
      prHeadSha: undefined,
      sourceLabel: headBranch,
    };
  }

  const availableRemoteBranch = remoteBranches.find((remoteBranch) => {
    const slashIndex = remoteBranch.indexOf('/');
    if (slashIndex <= 0 || slashIndex >= remoteBranch.length - 1) {
      return false;
    }
    if (remoteBranch.slice(slashIndex + 1) !== headBranch) {
      return false;
    }
    return commitsMatchPrHead(branchCommits[`remotes/${remoteBranch}`], headSha);
  });

  if (availableRemoteBranch) {
    const slashIndex = availableRemoteBranch.indexOf('/');
    const remoteName = availableRemoteBranch.slice(0, slashIndex);
    return {
      existingBranch: `remotes/${availableRemoteBranch}`,
      setUpstream: true as const,
      upstreamRemote: remoteName,
      upstreamBranch: headBranch,
      ensureRemoteName: undefined,
      ensureRemoteUrl: undefined,
      prRef: undefined,
      prBaseRepoUrl: undefined,
      prBaseOwner: undefined,
      prBaseRepo: undefined,
      prHeadSha: undefined,
      sourceLabel: `${remoteName}/${headBranch}`,
    };
  }

  const ownerFromLabel = String(pr.headLabel || '').split(':')[0]?.trim();
  const remoteSeed = pr.headRepo?.owner || ownerFromLabel || 'pr-head';
  const remoteName = `pr-${sanitizeRemoteName(remoteSeed)}`;
  // Prefer HTTPS for anonymous/public fetches when no matching remote exists.
  const remoteUrl = pr.headRepo?.cloneUrl || pr.headRepo?.sshUrl || '';

  if (!remoteUrl) {
    return resolvePrHeadRefConfig(pr);
  }

  return {
    existingBranch: `remotes/${remoteName}/${headBranch}`,
    setUpstream: true as const,
    upstreamRemote: remoteName,
    upstreamBranch: headBranch,
    ensureRemoteName: remoteName,
    ensureRemoteUrl: remoteUrl,
    ...prFallback,
    sourceLabel: `${remoteName}/${headBranch}`,
  };
};
