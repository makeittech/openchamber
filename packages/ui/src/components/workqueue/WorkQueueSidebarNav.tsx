import React from 'react';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WorkQueueItem } from '@/lib/api/types';
import type { WorkQueueFilters } from './WorkQueueToolbar';
import { matchesSection, matchesFacetFilters } from './workQueueFilters';

export type WorkQueueNavSection = 'queue' | 'recommended' | 'critical' | 'in_progress' | 'cloud_agents' | 'done';

interface WorkQueueSidebarNavProps {
  items: WorkQueueItem[];
  section: WorkQueueNavSection;
  onSectionChange: (section: WorkQueueNavSection) => void;
  filters: WorkQueueFilters;
  onRepoChange: (repo: string) => void;
}

/** Inline label + count row — unlike SettingsSidebarItem, the count never wraps to its own line. */
const WorkQueueNavRow: React.FC<{
  title: React.ReactNode;
  count: number;
  selected: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
}> = ({ title, count, selected, onSelect, icon }) => (
  <button
    type="button"
    onClick={onSelect}
    className={cn(
      'flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left transition-all duration-200',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
      selected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
    )}
  >
    <span className="flex min-w-0 items-center gap-1.5">
      {icon}
      <span className="typography-ui-label font-normal truncate text-foreground">{title}</span>
    </span>
    <span className="typography-micro text-muted-foreground/60 flex-shrink-0">{count}</span>
  </button>
);

const SECTION_ICONS: Record<WorkQueueNavSection, IconName> = {
  queue: 'list-unordered',
  recommended: 'sparkling',
  critical: 'bug',
  in_progress: 'time',
  cloud_agents: 'cloud',
  done: 'check',
};

const SECTIONS: WorkQueueNavSection[] = ['queue', 'recommended', 'critical', 'in_progress', 'cloud_agents', 'done'];

export const WorkQueueSidebarNav: React.FC<WorkQueueSidebarNavProps> = ({
  items,
  section,
  onSectionChange,
  filters,
  onRepoChange,
}) => {
  const { t } = useI18n();

  // Counts apply the same non-section facet filters as the list itself, so a
  // section's badge always matches what selecting it would actually show.
  const counts = React.useMemo(() => {
    const facetMatched = items.filter((item) => matchesFacetFilters(item, filters));
    const result = {} as Record<WorkQueueNavSection, number>;
    for (const sectionKey of SECTIONS) {
      result[sectionKey] = facetMatched.filter((item) => matchesSection(item, sectionKey)).length;
    }
    return result;
  }, [items, filters]);

  const repoCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      if (!item.repo) continue;
      map.set(item.repo, (map.get(item.repo) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [items]);

  return (
    <SettingsSidebarLayout className="w-full">
      <div className="space-y-0.5">
        {SECTIONS.map((sectionKey) => (
          <WorkQueueNavRow
            key={sectionKey}
            title={t(`workQueue.nav.${sectionKey}` as const)}
            count={counts[sectionKey] ?? 0}
            selected={section === sectionKey}
            onSelect={() => onSectionChange(sectionKey)}
            icon={<Icon name={SECTION_ICONS[sectionKey]} className="h-4 w-4 text-muted-foreground" />}
          />
        ))}
      </div>

      {repoCounts.length > 0 && (
        <div className="mt-4 space-y-0.5">
          <div className="px-1.5 py-1 typography-micro font-medium uppercase tracking-wide text-muted-foreground/60">
            {t('workQueue.nav.repositories')}
          </div>
          {repoCounts.map(([repoName, count]) => (
            <SettingsSidebarItem
              key={repoName}
              title={repoName}
              metadata={String(count)}
              selected={filters.repo === repoName}
              onSelect={() => onRepoChange(filters.repo === repoName ? '' : repoName)}
            />
          ))}
        </div>
      )}
    </SettingsSidebarLayout>
  );
};
