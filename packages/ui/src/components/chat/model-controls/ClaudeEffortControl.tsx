/**
 * Claude Code reasoning-effort control (composer chip + mobile panel).
 *
 * Only rendered while the Claude engine is selected; OpenCode uses the model
 * variant selector instead.
 */

import React from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { CLAUDE_EFFORT_LEVELS, type ClaudeEffort } from '@/lib/harness/claude-models';
import type { MobileControlsPanel } from '../mobileControlsUtils';
import { CLAUDE_EFFORT_LABEL_KEYS } from './claudeEffortLabels';

type EffortCommonProps = {
    claudeEffort: ClaudeEffort | undefined;
    onEffortChange: (effort?: ClaudeEffort) => void;
};

type ClaudeEffortSelectorProps = EffortCommonProps & {
    isCompact: boolean;
    isMobile: boolean;
    isDesktop: boolean;
    buttonHeight: string;
    controlIconSize: string;
    controlTextSize: string;
    onOpenMobilePanel: () => void;
};

type ClaudeEffortMobilePanelProps = EffortCommonProps & {
    activeMobilePanel: MobileControlsPanel;
    onClose: () => void;
};

/** Shared label + tint for both surfaces. */
function useEffortDisplay(claudeEffort: ClaudeEffort | undefined) {
    const { t } = useI18n();
    const isDefault = !claudeEffort;
    return {
        label: claudeEffort ? t(CLAUDE_EFFORT_LABEL_KEYS[claudeEffort]) : t('chat.harness.effort.default'),
        isDefault,
        // Same tint as the OpenCode thinking-variant chip next to it: both mark
        // an active reasoning-depth override in the same composer row.
        // `--interactive-selection` is a low-alpha *background* token, so using
        // it as a text color rendered the active level as unreadable grey.
        colorClass: isDefault ? 'text-muted-foreground' : 'text-[color:var(--status-info)]',
    };
}

export const ClaudeEffortSelector: React.FC<ClaudeEffortSelectorProps> = ({
    claudeEffort,
    onEffortChange,
    isCompact,
    isMobile,
    isDesktop,
    buttonHeight,
    controlIconSize,
    controlTextSize,
    onOpenMobilePanel,
}) => {
    const { t } = useI18n();
    const { label, isDefault, colorClass } = useEffortDisplay(claudeEffort);

    if (isCompact) {
        return (
            <button
                type="button"
                onClick={onOpenMobilePanel}
                className={cn(
                    'model-controls__effort-trigger flex items-center gap-1.5 transition-opacity min-w-0 focus:outline-none',
                    buttonHeight,
                    'cursor-pointer hover:bg-transparent hover:opacity-70',
                )}
                aria-label={t('chat.harness.effort.aria', { level: label })}
            >
                <Icon name="brain-ai-3" className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
                <span
                    className={cn(
                        'model-controls__effort-label',
                        controlTextSize,
                        'font-medium min-w-0 truncate',
                        isMobile && 'max-w-[60px]',
                        colorClass,
                    )}
                >
                    {label}
                </span>
            </button>
        );
    }

    return (
        <Tooltip delayDuration={600}>
            <DropdownMenu>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <div
                            className={cn(
                                'model-controls__effort-trigger flex items-center gap-1.5 transition-colors cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                buttonHeight,
                            )}
                            aria-label={t('chat.harness.effort.aria', { level: label })}
                        >
                            <Icon name="brain-ai-3" className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
                            <span
                                className={cn(
                                    'model-controls__effort-label',
                                    controlTextSize,
                                    'font-medium min-w-0 truncate',
                                    isDesktop ? 'max-w-[180px]' : undefined,
                                    colorClass,
                                )}
                            >
                                {label}
                            </span>
                        </div>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <DropdownMenuContent align="end" alignOffset={-40} className="w-[min(180px,calc(100vw-2rem))]">
                    <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
                        {t('chat.harness.effort.label')}
                    </DropdownMenuLabel>
                    <DropdownMenuItem className="typography-meta" onSelect={() => onEffortChange(undefined)}>
                        <div className="flex items-center justify-between gap-2 w-full min-w-0">
                            <span className="typography-meta font-medium text-foreground truncate min-w-0">
                                {t('chat.harness.effort.default')}
                            </span>
                            {isDefault && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                        </div>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {CLAUDE_EFFORT_LEVELS.map((level) => (
                        <DropdownMenuItem
                            key={level}
                            className="typography-meta"
                            onSelect={() => onEffortChange(level)}
                        >
                            <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                <span className="typography-meta font-medium text-foreground truncate min-w-0">
                                    {t(CLAUDE_EFFORT_LABEL_KEYS[level])}
                                </span>
                                {claudeEffort === level && (
                                    <Icon name="check" className="size-4 text-primary flex-shrink-0" />
                                )}
                            </div>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <TooltipContent side="top">
                <p className="typography-meta">{t('chat.harness.effort.tooltip', { level: label })}</p>
            </TooltipContent>
        </Tooltip>
    );
};

export const ClaudeEffortMobilePanel: React.FC<ClaudeEffortMobilePanelProps> = ({
    claudeEffort,
    onEffortChange,
    activeMobilePanel,
    onClose,
}) => {
    const { t } = useI18n();
    const { label } = useEffortDisplay(claudeEffort);

    const select = (effort?: ClaudeEffort) => {
        onEffortChange(effort);
        onClose();
    };

    return (
        <MobileOverlayPanel
            open={activeMobilePanel === 'effort'}
            onClose={onClose}
            title={t('chat.harness.effort.label')}
        >
            <div className="flex flex-col gap-1 p-2">
                <button
                    type="button"
                    className="flex items-center justify-between gap-2 rounded-md px-3 py-2 hover:bg-interactive-hover/50"
                    onClick={() => select(undefined)}
                >
                    <span className="typography-meta font-medium text-foreground">
                        {t('chat.harness.effort.default')}
                    </span>
                    {!claudeEffort ? <Icon name="check" className="size-4 text-primary flex-shrink-0" /> : null}
                </button>
                {CLAUDE_EFFORT_LEVELS.map((level) => (
                    <button
                        key={level}
                        type="button"
                        className="flex items-center justify-between gap-2 rounded-md px-3 py-2 hover:bg-interactive-hover/50"
                        onClick={() => select(level)}
                    >
                        <span className="typography-meta font-medium text-foreground">
                            {t(CLAUDE_EFFORT_LABEL_KEYS[level])}
                        </span>
                        {claudeEffort === level ? (
                            <Icon name="check" className="size-4 text-primary flex-shrink-0" />
                        ) : null}
                    </button>
                ))}
            </div>
            <p className="typography-meta text-muted-foreground px-3 pb-2">
                {t('chat.harness.effort.tooltip', { level: label })}
            </p>
        </MobileOverlayPanel>
    );
};
