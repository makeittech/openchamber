import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/lib/i18n';
import type { WorkQueueItem } from '@/lib/api/types';
import { WorkQueueCard } from './WorkQueueCard';
import type { WorkQueueSort } from './WorkQueueToolbar';

const ROW_ESTIMATE_PX = 96;
const ROW_GAP_PX = 8;
const VIRTUALIZE_THRESHOLD = 40;

interface WorkQueueListProps {
  items: WorkQueueItem[];
  sort: WorkQueueSort;
  selectedId: string | null;
  onSelect: (item: WorkQueueItem) => void;
}

const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const WorkQueueList: React.FC<WorkQueueListProps> = ({ items, sort, selectedId, onSelect }) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // An explicit toolbar sort has already ordered `items` upstream; only fall
  // back to the list's own priority/confidence ranking when no sort is chosen.
  const sorted = React.useMemo(() => {
    if (sort) return items;
    return items.slice().sort((a, b) => {
      const aRank = a.aiAnalysis ? priorityRank[a.aiAnalysis.priority] ?? 4 : 5;
      const bRank = b.aiAnalysis ? priorityRank[b.aiAnalysis.priority] ?? 4 : 5;
      if (aRank !== bRank) return aRank - bRank;
      const aConfidence = a.aiAnalysis?.confidence ?? 0;
      const bConfidence = b.aiAnalysis?.confidence ?? 0;
      return bConfidence - aConfidence;
    });
  }, [items, sort]);

  const shouldVirtualize = sorted.length >= VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: sorted.length,
    enabled: shouldVirtualize,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX + ROW_GAP_PX,
    overscan: 8,
    getItemKey: (index) => sorted[index]?.id ?? index,
  });

  if (sorted.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground typography-ui-label">
        {t('workQueue.list.empty')}
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-2">
          {sorted.map((item) => (
            <WorkQueueCard key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = sorted[virtualRow.index];
          if (!item) return null;
          return (
            <WorkQueueCard
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onSelect={onSelect}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
};
