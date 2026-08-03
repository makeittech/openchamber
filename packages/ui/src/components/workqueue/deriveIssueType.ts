import type { WorkQueueItem } from '@/lib/api/types';

/**
 * There is no structured issue-category field synced from GitHub/Linear, so
 * the type badge and quick-filter chips both derive it from labels — kept as
 * a single shared function so the two call sites can't drift.
 */
export type WorkQueueIssueType = 'bug' | 'feature' | 'enhancement' | 'question' | 'documentation' | 'other';

const TYPE_PATTERNS: Array<[WorkQueueIssueType, RegExp]> = [
  ['bug', /^(bug|regression|defect)$/i],
  ['documentation', /^(docs?|documentation)$/i],
  ['question', /^question$/i],
  ['enhancement', /^enhancement$/i],
  ['feature', /^feature$/i],
];

export const deriveIssueType = (item: WorkQueueItem): WorkQueueIssueType => {
  if (item.type === 'pr') return 'other';
  for (const [issueType, pattern] of TYPE_PATTERNS) {
    if (item.labels.some((label) => pattern.test(label))) return issueType;
  }
  return 'other';
};
