import { getOctokitOrNull } from '../github/octokit.js';
import { graphqlWithStoredAuth, ISSUES_ASSIGNED_QUERY } from '../linear/client.js';
import { upsertSyncedItems, listItems, findItem, patchItem } from './store.js';
import { getTrackedRepos } from './settings.js';
import { extractLinearRef } from './dedup.js';
import { mapLinearStateTypeToColumn } from './columns.js';

const mapGitHubLabels = (labels) => (Array.isArray(labels)
  ? labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string' && name)
  : []);

// The automated PR reviewer. PR cards show these comments instead of an AI
// analysis pass, so only this account's comments are collected.
const AI_REVIEW_BOT_LOGIN = 'openchamber-bot[bot]';
const PR_REVIEW_FETCH_CONCURRENCY = 8;

// Sequentially fetching review comments for every open PR makes a sync take
// minutes on repos with hundreds of PRs, so they are fetched with bounded
// concurrency. A failure for one PR leaves that PR's existing comments intact.
async function attachPrReviewComments(octokit, owner, repo, prItems) {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= prItems.length) return;
      const entry = prItems[index];
      try {
        const comments = await octokit.paginate(octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number: entry.number,
          per_page: 100,
        });
        entry.item.reviewComments = (Array.isArray(comments) ? comments : [])
          .filter((comment) => comment?.user?.login === AI_REVIEW_BOT_LOGIN)
          .map((comment) => ({
            body: typeof comment.body === 'string' ? comment.body : '',
            url: comment.html_url || '',
            author: comment.user?.login || '',
            createdAt: comment.created_at ? Date.parse(comment.created_at) : 0,
          }))
          .filter((comment) => comment.body);
      } catch {
        // Best-effort: the PR itself is already synced, and the store keeps
        // any previously fetched comments for this PR.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PR_REVIEW_FETCH_CONCURRENCY, prItems.length) || 0 }, () => worker()),
  );
}

// One repo's failure (private/renamed/rate-limited) must not block the rest —
// each repo is queried independently and failures are reported, not thrown.
async function syncGitHubRepo(octokit, ownerRepo) {
  const [owner, repo] = ownerRepo.split('/');
  const items = [];
  try {
    const allItems = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });
    let issueCount = 0;
    for (const item of (Array.isArray(allItems) ? allItems : [])) {
      if (item.pull_request) continue;
      if (issueCount >= 700) break;
      issueCount++;
      items.push({
        source: 'github',
        sourceId: `${ownerRepo}#${item.number}`,
        repo: ownerRepo,
        type: 'issue',
        title: item.title,
        body: typeof item.body === 'string' ? item.body : '',
        url: item.html_url,
        author: item.user?.login || '',
        labels: mapGitHubLabels(item.labels),
        createdAt: item.created_at ? Date.parse(item.created_at) : Date.now(),
        // GitHub has no workflow-state concept in this integration — every
        // GitHub-sourced item starts in Backlog.
        status: 'backlog',
      });
    }
  } catch (error) {
    console.warn(`[workqueue] Failed to list issues for ${ownerRepo}:`, error?.message || error);
    return { items, failed: true };
  }

  try {
    const allPulls = await octokit.paginate(octokit.rest.pulls.list, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });
    let prCount = 0;
    const prItems = [];
    for (const item of (Array.isArray(allPulls) ? allPulls : [])) {
      if (prCount >= 500) break;
      prCount++;
      const prItem = {
        source: 'github',
        sourceId: `${ownerRepo}#${item.number}`,
        repo: ownerRepo,
        type: 'pr',
        title: item.title,
        body: typeof item.body === 'string' ? item.body : '',
        url: item.html_url,
        author: item.user?.login || '',
        labels: mapGitHubLabels(item.labels),
        createdAt: item.created_at ? Date.parse(item.created_at) : Date.now(),
        reviewComments: [],
        status: 'backlog',
      };
      items.push(prItem);
      prItems.push({ number: item.number, item: prItem });
    }
    await attachPrReviewComments(octokit, owner, repo, prItems);
  } catch (error) {
    console.warn(`[workqueue] Failed to list PRs for ${ownerRepo}:`, error?.message || error);
    return { items, failed: true };
  }

  return { items, failed: false };
}

// Runs after Linear has already synced this pass: a GitHub item whose body
// references a Linear identifier (e.g. "Closes OPE-123") is merged into that
// Linear card instead of being shown as a second, duplicate item. A GitHub
// item previously synced standalone that is only now discovered to be linked
// is archived rather than deleted, consistent with the store's "never infer
// deletion" invariant.
function applyLinearDedup(githubItems) {
  const linearByIdentifier = new Map(
    listItems({ source: 'linear' })
      .filter((linearItem) => linearItem.identifier)
      .map((linearItem) => [linearItem.identifier.toUpperCase(), linearItem]),
  );
  if (linearByIdentifier.size === 0) return githubItems;

  const visible = [];
  for (const item of githubItems) {
    const ref = extractLinearRef(item.body);
    const matched = ref ? linearByIdentifier.get(ref) : null;
    if (!matched) {
      visible.push(item);
      continue;
    }
    patchItem(matched.id, { linkedGithubUrl: item.url });
    const existing = findItem('github', item.sourceId);
    if (existing && !existing.archivedAt) {
      patchItem(existing.id, { archivedAt: Date.now() });
    }
  }
  return visible;
}

async function syncGitHub() {
  const repos = getTrackedRepos();
  if (repos.length === 0) {
    return { connected: null, added: 0, updated: 0, failedRepos: [] };
  }
  const octokit = getOctokitOrNull();
  if (!octokit) {
    return { connected: false, added: 0, updated: 0, failedRepos: [] };
  }

  const results = await Promise.all(repos.map((repo) => syncGitHubRepo(octokit, repo)));
  const items = applyLinearDedup(results.flatMap((result) => result.items));
  const failedRepos = repos.filter((_repo, index) => results[index].failed);
  const { added, updated } = upsertSyncedItems(items);
  return { connected: true, added, updated, failedRepos };
}

async function syncLinear() {
  let data;
  try {
    data = await graphqlWithStoredAuth({
      query: ISSUES_ASSIGNED_QUERY,
      variables: { first: 100, after: null },
    });
  } catch (error) {
    if (error?.code === 'LINEAR_NOT_CONNECTED') {
      return { connected: false, added: 0, updated: 0 };
    }
    console.warn('[workqueue] Linear sync failed:', error?.message || error);
    return { connected: true, added: 0, updated: 0, failed: true };
  }

  const nodes = Array.isArray(data?.issues?.nodes) ? data.issues.nodes : [];
  const items = nodes.map((issue) => ({
    source: 'linear',
    sourceId: issue.id,
    repo: issue.team?.key || '',
    team: issue.team?.id || '',
    type: 'issue',
    title: issue.title || '',
    body: typeof issue.description === 'string' ? issue.description : '',
    url: issue.url || '',
    author: issue.creator?.displayName || issue.creator?.name || '',
    labels: Array.isArray(issue.labels?.nodes)
      ? issue.labels.nodes.map((label) => label?.name).filter(Boolean)
      : [],
    createdAt: issue.createdAt ? Date.parse(issue.createdAt) : Date.now(),
    identifier: issue.identifier || '',
    status: mapLinearStateTypeToColumn(issue.state?.type),
  }));
  const { added, updated } = upsertSyncedItems(items);
  return { connected: true, added, updated };
}

// Linear syncs first so applyLinearDedup() has this pass's Linear identifiers
// available when GitHub items are matched against them.
export async function syncAll() {
  const linear = await syncLinear();
  const github = await syncGitHub();
  return { github, linear };
}
