/**
 * Composer chip showing how many items of one context kind are attached,
 * with a control to detach them all.
 *
 * Five near-identical copies of this markup lived inline in ChatInput, each
 * styling itself from the theme object instead of CSS variables — which meant
 * they did not follow live theme changes the way the sibling terminal chip did.
 */

import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

type ContextCountChipProps = {
    label: string;
    count: number;
    onRemove: () => void;
    removeLabel: string;
    icon?: IconName;
    /** Extra classes for the icon (e.g. a status tint for failing checks). */
    iconClassName?: string;
};

export const ContextCountChip: React.FC<ContextCountChipProps> = ({
    label,
    count,
    onRemove,
    removeLabel,
    icon,
    iconClassName,
}) => {
    if (count <= 0) return null;

    return (
        <div className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2.5 py-1">
            {icon ? <Icon name={icon} className={iconClassName ?? 'h-3.5 w-3.5 text-muted-foreground'} /> : null}
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className="text-xs font-semibold text-[var(--status-info)]">{count}</span>
            <button
                type="button"
                className="ml-1 inline-flex h-4 w-4 min-h-0 min-w-0 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                onClick={onRemove}
                aria-label={removeLabel}
                title={removeLabel}
            >
                <Icon name="close" className="h-3 w-3" />
            </button>
        </div>
    );
};
