import React from 'react';
import { HarnessLogo } from '@/components/ui/HarnessLogo';
import { cn } from '@/lib/utils';

export type ModelPickerHarnessOption = {
  id: string;
  name: string;
  statusLabel?: string;
  selected: boolean;
};

type HarnessTabsProps = {
  harnesses: ModelPickerHarnessOption[];
  onSelect?: (harnessId: string) => void;
  /** Group label for assistive tech; the visible tabs carry the harness names. */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
};

/**
 * Harness switcher rendered as a tab strip above the model list. Tabs stay
 * visible while searching so switching harness is a one-click, always-present
 * action rather than a row buried in the model list.
 */
export function HarnessTabs({
  harnesses,
  onSelect,
  ariaLabel,
  disabled = false,
  className,
}: HarnessTabsProps): React.ReactNode {
  if (harnesses.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5',
        className,
      )}
    >
      {harnesses.map((harness) => (
        <button
          key={harness.id}
          type="button"
          role="tab"
          aria-selected={harness.selected}
          disabled={disabled}
          onClick={() => onSelect?.(harness.id)}
          className={cn(
            'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 typography-meta font-medium transition-colors',
            harness.selected
              ? 'bg-interactive-selection text-interactive-selection-foreground'
              : 'text-muted-foreground',
            !disabled && !harness.selected && 'cursor-pointer hover:bg-interactive-hover/50 hover:text-foreground',
            !disabled && harness.selected && 'cursor-pointer',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <HarnessLogo harnessId={harness.id} className="size-3.5 flex-shrink-0" />
          <span className="truncate">{harness.name}</span>
          {harness.statusLabel ? (
            <span className="typography-micro flex-shrink-0 opacity-70">{harness.statusLabel}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
