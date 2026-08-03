/**
 * Card shell used by the mobile long-press detail panels (model + agent).
 * Both panels repeated this wrapper and its optional caption ten times.
 */

import React from 'react';
import { cn } from '@/lib/utils';

type MobileInfoCardProps = {
    /** Optional caption rendered above the card body. */
    caption?: string;
    /** Tighter caption spacing for single-line bodies. */
    tightCaption?: boolean;
    className?: string;
    children: React.ReactNode;
};

export const MobileInfoCard: React.FC<MobileInfoCardProps> = ({
    caption,
    tightCaption = false,
    className,
    children,
}) => (
    <div className={cn('rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5', className)}>
        {caption ? (
            <div className={cn('typography-micro text-muted-foreground', tightCaption ? 'mb-0.5' : 'mb-1')}>
                {caption}
            </div>
        ) : null}
        {children}
    </div>
);
