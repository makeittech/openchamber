import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  MeasuringStrategy,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { WorkQueueItem, WorkQueueItemStatus } from '@/lib/api/types';
import { WorkQueueCard } from './WorkQueueCard';
import type { WorkQueueSort } from './WorkQueueToolbar';

// No `done` column: finished items are archived from the queue and belong in
// the sidebar's Done section, not on the triage board. Three columns keep
// every card readable even on a ~1000px window with the detail panel open.
const COLUMNS: WorkQueueItemStatus[] = ['backlog', 'todo', 'in_progress'];
const VIRTUALIZE_THRESHOLD = 30;

interface WorkQueueBoardProps {
  items: WorkQueueItem[];
  sort: WorkQueueSort;
  selectedId: string | null;
  onSelect: (item: WorkQueueItem) => void;
  onMove: (id: string, status: WorkQueueItemStatus) => void;
}

const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const sortColumnItems = (items: WorkQueueItem[]) => items.slice().sort((a, b) => {
  const aRank = a.aiAnalysis ? priorityRank[a.aiAnalysis.priority] ?? 4 : 5;
  const bRank = b.aiAnalysis ? priorityRank[b.aiAnalysis.priority] ?? 4 : 5;
  return aRank - bRank;
});

const SortableCard: React.FC<{
  item: WorkQueueItem;
  selected: boolean;
  onSelect: (item: WorkQueueItem) => void;
}> = ({ item, selected, onSelect }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  return (
    <WorkQueueCard
      ref={setNodeRef}
      item={item}
      selected={selected}
      onSelect={onSelect}
      className={cn('touch-none select-none', isDragging && 'z-10 opacity-60')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragHandleProps={{ ...attributes, ...listeners }}
    />
  );
};

const BoardColumn: React.FC<{
  status: WorkQueueItemStatus;
  items: WorkQueueItem[];
  sort: WorkQueueSort;
  selectedId: string | null;
  onSelect: (item: WorkQueueItem) => void;
}> = ({ status, items, sort, selectedId, onSelect }) => {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  // An explicit toolbar sort has already ordered `items` upstream; only fall
  // back to the column's own priority ranking when no sort is chosen.
  const sorted = React.useMemo(() => (sort ? items : sortColumnItems(items)), [items, sort]);
  const shouldVirtualize = sorted.length >= VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: sorted.length,
    enabled: shouldVirtualize,
    getScrollElement: () => scrollRef.current,
    // 104 is only the *starting* estimate for the first measurement pass.
    // Cards are variable height (wrapping titles, badge rows that wrap on
    // narrow columns), so every rendered row is re-measured via
    // `measureElement` below — without that, rows keep the fixed estimate
    // forever and taller cards spill into the next absolutely-positioned
    // row, visually overlapping it.
    estimateSize: () => 104,
    overscan: 6,
    getItemKey: (index) => sorted[index]?.id ?? index,
  });

  return (
    <div
      data-wq-column={status}
      className="flex min-w-[220px] flex-1 flex-col rounded-lg border border-border/40 bg-muted/20"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
        <span className="typography-ui-label font-medium text-foreground">{t(`workQueue.status.${status}` as const)}</span>
        <span className="typography-micro text-muted-foreground">{items.length}</span>
      </div>
      <div
        ref={(node) => {
          setNodeRef(node);
          scrollRef.current = node;
        }}
        className={cn('flex-1 min-h-0 overflow-y-auto p-2', isOver && 'bg-primary/5')}
      >
        <SortableContext items={sorted.map((item) => item.id)} strategy={rectSortingStrategy}>
          {sorted.length === 0 ? (
            <div className="flex h-24 items-center justify-center typography-micro text-muted-foreground/60">
              {t('workQueue.board.emptyColumn')}
            </div>
          ) : shouldVirtualize ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = sorted[virtualRow.index];
                if (!item) return null;
                return (
                  <div
                    key={item.id}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${virtualRow.start}px)`, paddingBottom: 8 }}
                  >
                    <SortableCard item={item} selected={item.id === selectedId} onSelect={onSelect} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {sorted.map((item) => (
                <SortableCard key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} />
              ))}
            </div>
          )}
        </SortableContext>
      </div>
    </div>
  );
};

export const WorkQueueBoard: React.FC<WorkQueueBoardProps> = ({ items, sort, selectedId, onSelect, onMove }) => {
  const itemById = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeItem = itemById.get(String(active.id));
    if (!activeItem) return;

    const overId = String(over.id);
    const targetStatus = (COLUMNS as string[]).includes(overId)
      ? (overId as WorkQueueItemStatus)
      : itemById.get(overId)?.status;
    if (!targetStatus || targetStatus === activeItem.status) return;
    onMove(activeItem.id, targetStatus);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragEnd={handleDragEnd}
    >
      {/* Horizontal scroll on narrow widths: columns keep a readable minimum
          width instead of squeezing cards into unreadable strips. */}
      <div data-wq-board className="flex flex-1 min-h-0 gap-3 overflow-x-auto p-3">
        {COLUMNS.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            items={items.filter((item) => item.status === status)}
            sort={sort}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </DndContext>
  );
};
