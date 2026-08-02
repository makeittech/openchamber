import { getOctokitOrNull } from '../github/octokit.js';
import { moveIssueToStateType } from '../linear/client.js';
import { patchItem } from './store.js';

// GitHub's own `state_reason` values on a closed issue; there is no
// "duplicate" reason in the GitHub API, so a duplicate close uses
// 'not_planned' (the same reason GitHub's own UI uses) plus an explicit
// comment linking to the issue it duplicates.
const GITHUB_STATE_REASON_BY_CLOSE_REASON = {
  completed: 'completed',
  duplicate: 'not_planned',
  not_planned: 'not_planned',
};

// Linear models "duplicate" and "won't fix" as distinctly-named states of
// the 'canceled' type (teams commonly have both). Prefer the state whose
// name actually says so; fall back to the team's first 'canceled' state (or
// 'completed', for a plain finish) when no such name exists.
const LINEAR_STATE_BY_CLOSE_REASON = {
  completed: { stateType: 'completed', preferNameMatch: null },
  duplicate: { stateType: 'canceled', preferNameMatch: /duplicate/i },
  not_planned: { stateType: 'canceled', preferNameMatch: /(won.?t.?fix|not.?planned|cancel)/i },
};

// Orchestrates the "Finish" action. Each side effect (GitHub, Linear) is
// attempted independently and reported independently: a Linear failure must
// not block a GitHub merge/close that already succeeded, and vice versa. The
// card is archived once at least one side reports success, or immediately
// when the item has no external lifecycle to close (nothing to fail on).
//
// `closeReason` mirrors GitHub's own close reasons ('completed' | 'duplicate'
// | 'not_planned', defaulting to 'completed'); `duplicateOfUrl` is posted as
// a GitHub comment / used by the caller for context when closing as a
// duplicate, falling back to the item's own AI-flagged duplicate when unset.
export async function finishItem(item, { mergePr = false, closeReason = 'completed', duplicateOfUrl } = {}) {
  const reason = GITHUB_STATE_REASON_BY_CLOSE_REASON[closeReason] ? closeReason : 'completed';
  const result = { prMerged: false, issueClosedGitHub: false, linearMoved: false, archived: false };
  const resolvedDuplicateOfUrl = duplicateOfUrl || item.aiAnalysis?.duplicateOfUrl || '';

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
          if (reason === 'duplicate' && resolvedDuplicateOfUrl) {
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: number,
              body: `Closing as a duplicate of ${resolvedDuplicateOfUrl}`,
            });
          }
          await octokit.rest.issues.update({
            owner,
            repo,
            issue_number: number,
            state: 'closed',
            state_reason: GITHUB_STATE_REASON_BY_CLOSE_REASON[reason],
          });
          result.issueClosedGitHub = true;
        } catch (error) {
          console.warn('[workqueue] finish: issue close failed:', error?.message || error);
        }
      }
    }
  }

  // A Linear-sourced item moves itself; a GitHub item that was mirrored into
  // Linear (see routes.js's mirrorGithubItemToLinear) moves that linked
  // issue instead, so Finish closes both sides of the pair together.
  const linearIssueId = item.source === 'linear' ? item.sourceId : item.linkedLinearId;
  if (linearIssueId && item.team) {
    const { stateType, preferNameMatch } = LINEAR_STATE_BY_CLOSE_REASON[reason];
    try {
      const moved = await moveIssueToStateType({
        issueId: linearIssueId,
        teamId: item.team,
        stateType,
        preferNameMatch: preferNameMatch || undefined,
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
    patchItem(item.id, { status: 'done', closeReason: reason, finishedAt: Date.now(), archivedAt: Date.now() });
    result.archived = true;
  }

  return result;
}
