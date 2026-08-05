import type { IconName } from '@/components/icon/icons';
import type { WorkQueueItem } from '@/lib/api/types';
import type { WorkQueueFilters } from './WorkQueueToolbar';
import { deriveIssueType } from './deriveIssueType';

export type WorkQueueNavSection = 'queue' | 'recommended' | 'critical' | 'in_progress' | 'cloud_agents' | 'done';

// Section constants live here (not in WorkQueueSidebarNav.tsx) because
// react-refresh/only-export-components forbids non-component exports from a
// component file; the sidebar, the mobile strip, and the filters all share
// them.
export const SECTION_ICONS: Record<WorkQueueNavSection, IconName> = {
  queue: 'list-unordered',
  recommended: 'sparkling',
  critical: 'bug',
  in_progress: 'time',
  cloud_agents: 'cloud',
  done: 'check',
};

export const SECTIONS: WorkQueueNavSection[] = ['queue', 'recommended', 'critical', 'in_progress', 'cloud_agents', 'done'];

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
 * Per-section counts after the shared facet filters, so a badge count always
 * matches what the section would actually show. Used by the sidebar nav and
 * the mobile section strip.
 */
export const countItemsBySection = (
  items: WorkQueueItem[],
  filters: Pick<WorkQueueFilters, 'repo' | 'assignee' | 'type' | 'issueType' | 'priority' | 'complexity' | 'search'>,
  sections: WorkQueueNavSection[],
): Record<WorkQueueNavSection, number> => {
  const facetMatched = items.filter((item) => matchesFacetFilters(item, filters));
  const result = {} as Record<WorkQueueNavSection, number>;
  for (const sectionKey of sections) {
    result[sectionKey] = facetMatched.filter((item) => matchesSection(item, sectionKey)).length;
  }
  return result;
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
