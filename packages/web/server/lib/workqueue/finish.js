import { getOctokitOrNull } from '../github/octokit.js';
import { moveIssueToStateType } from '../linear/client.js';
import { patchItem } from './store.js';

// Orchestrates the "Finish" action. Each side effect (GitHub, Linear) is
// attempted independently and reported independently: a Linear failure must
// not block a GitHub merge/close that already succeeded, and vice versa. The
// card is archived once at least one side reports success, or immediately
// when the item has no external lifecycle to close (nothing to fail on).
export async function finishItem(item, { mergePr = false } = {}) {
  const result = { prMerged: false, issueClosedGitHub: false, linearMoved: false, archived: false };

  if (item.source === 'github') {
    const [owner, repo] = (item.repo || '').split('/');
    const numberMatch = item.sourceId.match(/#(\d+)$/);
    const number = numberMatch ? Number(numberMatch[1]) : null;
    const octokit = getOctokitOrNull();

    if (owner && repo && number && octokit) {
      if (item.type === 'pr' && mergePr) {
        try {
          const merged = await octokit.rest.pulls.merge({ owner, repo, pull_number: number });
          result.prMerged = Boolean(merged?.data?.merged);
        } catch (error) {
          console.warn('[workqueue] finish: PR merge failed:', error?.message || error);
        }
      } else if (item.type === 'issue') {
        try {
          await octokit.rest.issues.update({ owner, repo, issue_number: number, state: 'closed' });
          result.issueClosedGitHub = true;
        } catch (error) {
          console.warn('[workqueue] finish: issue close failed:', error?.message || error);
        }
      }
    }
  }

  if (item.source === 'linear' && item.team) {
    try {
      const moved = await moveIssueToStateType({
        issueId: item.sourceId,
        teamId: item.team,
        stateType: 'completed',
      });
      result.linearMoved = Boolean(moved?.changed);
    } catch (error) {
      console.warn('[workqueue] finish: Linear state move failed:', error?.message || error);
    }
  }

  const hasExternalLifecycle = item.type === 'pr' || item.source === 'linear';
  const succeededOrNothingToDo = !hasExternalLifecycle
    || result.prMerged
    || result.issueClosedGitHub
    || result.linearMoved;

  if (succeededOrNothingToDo) {
    patchItem(item.id, { status: 'done', finishedAt: Date.now(), archivedAt: Date.now() });
    result.archived = true;
  }

  return result;
}
