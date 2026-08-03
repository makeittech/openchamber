import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { getAgentDisplayName } from './mobileControlsUtils';
import { getAgentColor } from '@/lib/agentColors';
import { useI18n } from '@/lib/i18n';
import { useClaudeAgentsStore } from '@/stores/useClaudeAgentsStore';
import { useClaudeNativeAgentsActive } from '@/lib/harness/use-claude-agents-mode';
import { resolveActiveHarnessTarget } from '@/lib/harness/resolve-execution-target';

interface MobileAgentButtonProps {
    onCycleAgent: () => void;
    onOpenAgentPanel: () => void;
    className?: string;
}

const LONG_PRESS_MS = 500;

// NOTE: Use pointer events instead of onClick to keep soft keyboard open on mobile
export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onCycleAgent, onOpenAgentPanel, className }) => {
    const { t } = useI18n();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const sessionAgentName = useSelectionStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );
    const sessionTarget = useSelectionStore((state) =>
        currentSessionId ? state.sessionTargets.get(currentSessionId) ?? null : null
    );
    const pendingHandoffTarget = useSelectionStore((state) =>
        currentSessionId ? state.pendingHandoffTargets.get(currentSessionId) ?? null : null
    );
    const lastUsedTarget = useSelectionStore((state) => state.lastUsedTarget);
    const claudeSelectedAgentName = useClaudeAgentsStore((state) => state.getSelected(currentSessionId));

    // Same target resolution the model picker uses, so this chip cannot label a
    // different session's harness than the picker is acting on.
    const activeHarnessTarget = resolveActiveHarnessTarget({
        sessionId: currentSessionId,
        sessionTarget,
        pendingHandoffTarget,
        lastUsedTarget,
    });
    // Claude sessions in native agents mode name a Claude agent, not an
    // OpenCode one — showing the OpenCode agent here would label the chip with
    // something the turn never uses.
    const claudeNativeAgentsActive = useClaudeNativeAgentsActive(activeHarnessTarget?.harnessId);

    const agents = getVisibleAgents();
    const uiAgentName = currentSessionId ? (sessionAgentName || currentAgentName) : currentAgentName;
    const agentLabel = claudeNativeAgentsActive
        ? (claudeSelectedAgentName || t('chat.modelControls.claudeAgents.defaultAgent'))
        : getAgentDisplayName(agents, uiAgentName);
    const agentColor = getAgentColor(claudeNativeAgentsActive ? claudeSelectedAgentName : uiAgentName);

    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const isLongPressRef = React.useRef(false);

    const handlePointerDown = (event: React.PointerEvent) => {
        // Same pattern as PermissionAutoAcceptButton: block the focus transfer
        // iOS performs on touch so cycling the agent keeps the keyboard open.
        if (event.pointerType === 'touch') {
            event.preventDefault();
        }
        isLongPressRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
            isLongPressRef.current = true;
            onOpenAgentPanel();
        }, LONG_PRESS_MS);
    };

    // Use onPointerUp (not onClick) to prevent focus transfer that closes mobile keyboard
    const handlePointerUp = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        if (!isLongPressRef.current) {
            // Cycling walks OpenCode primary agents; with Claude's own set
            // selected there is nothing to cycle, so a tap opens the picker.
            if (claudeNativeAgentsActive) {
                onOpenAgentPanel();
                return;
            }
            onCycleAgent();
        }
    };

    const handlePointerLeave = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    React.useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
            }
        };
    }, []);

    return (
        <button
            type="button"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp} // Don't use onClick - it closes mobile keyboard
            onPointerLeave={handlePointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
                'inline-flex min-w-0 items-stretch select-none',
                'rounded-lg',
                'typography-micro font-medium',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                'touch-none',
                className
            )}
            style={{
                height: '26px',
                maxHeight: '26px',
                minHeight: '26px',
                color: `var(${agentColor.var})`,
            }}
            title={agentLabel}
        >
            <span className="flex h-full w-full min-w-0 items-center">
                <span className="truncate">{agentLabel}</span>
            </span>
        </button>
    );
};
