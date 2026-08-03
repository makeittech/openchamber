import type { WorkQueueItem } from '@/lib/api/types';
import type { WorkQueueNavSection } from './WorkQueueSidebarNav';
import type { WorkQueueFilters } from './WorkQueueToolbar';
import { deriveIssueType } from './deriveIssueType';

export const matchesSection = (item: WorkQueueItem, section: WorkQueueNavSection): boolean => {
  switch (section) {
    case 'queue':
      return item.status !== 'done';
    case 'recommended':
      return item.status !== 'done' && item.status !== 'in_progress' && Boolean(item.aiAnalysis);
    case 'critical':
      return item.aiAnalysis?.priority === 'critical' && item.status !== 'done';
    case 'in_progress':
      return item.status === 'in_progress';
    case 'cloud_agents':
      return Boolean(item.cloudAgent);
    case 'done':
      return item.status === 'done';
    default:
      return true;
  }
};

/**
 * Facet filters excluding section — shared by the item list (WorkQueueView)
 * and the sidebar section counts (WorkQueueSidebarNav) so a badge count
 * always matches what the list actually shows for that section.
 */
export const matchesFacetFilters = (
  item: WorkQueueItem,
  filters: Pick<WorkQueueFilters, 'repo' | 'assignee' | 'type' | 'issueType' | 'priority' | 'complexity' | 'search'>,
): boolean => {
  if (filters.repo && item.repo !== filters.repo) return false;
  if (filters.assignee && item.assignee !== filters.assignee) return false;
  if (filters.type && item.type !== filters.type) return false;
  if (filters.issueType && deriveIssueType(item) !== filters.issueType) return false;
  if (filters.priority && item.aiAnalysis?.priority !== filters.priority) return false;
  if (filters.complexity && item.aiAnalysis?.complexity !== filters.complexity) return false;
  const search = filters.search.trim().toLowerCase();
  if (search) {
    const haystack = [item.title, item.sourceId, item.identifier, item.repo, item.author, ...item.labels]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
};
