import React from 'react';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { applyFavoriteExecutionTarget } from '@/lib/harness/apply-favorite-target';
import { executionTargetsMatchIdentity } from '@/lib/harness/favorite-targets';

export const useMiniChatKeyboardShortcuts = () => {
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);

  React.useEffect(() => {
    const combo = (actionId: string) => getEffectiveShortcutCombo(actionId, shortcutOverrides);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, combo('focus_input'))) {
        event.preventDefault();
        focusChatInput();
        return;
      }

      if (canUseElectronDesktopIPC() && eventMatchesShortcut(event, combo('new_mini_chat'))) {
        event.preventDefault();
        void invokeDesktop('desktop_open_draft_mini_chat_window', {
          directory: currentDirectory || activeProject?.path || '',
          projectId: activeProject?.id ?? null,
        })?.catch((error) => {
          console.warn('[mini-chat-shortcuts] failed to open draft mini chat window', error);
        });
        return;
      }

      if (eventMatchesShortcut(event, combo('new_chat'))) {
        event.preventDefault();
        openNewSessionDraft({
          selectedProjectId: activeProject?.id ?? null,
          directoryOverride: currentDirectory || activeProject?.path || null,
          preserveDirectoryOverride: Boolean(currentDirectory || activeProject?.path),
        });
        focusChatInput();
        return;
      }

      if (eventMatchesShortcut(event, combo('open_model_selector'))) {
        event.preventDefault();
        const { isModelSelectorOpen, setModelSelectorOpen } = useUIStore.getState();
        setModelSelectorOpen(!isModelSelectorOpen);
        return;
      }

      if (eventMatchesShortcut(event, combo('cycle_thinking_variant'))) {
        const configState = useConfigStore.getState();
        const variants = configState.getCurrentModelVariants();
        if (variants.length === 0) {
          return;
        }

        event.preventDefault();
        configState.cycleCurrentVariant();

        const nextVariant = useConfigStore.getState().currentVariant;
        const sessionId = useSessionUIStore.getState().currentSessionId;
        const agentName = useConfigStore.getState().currentAgentName;
        const providerId = useConfigStore.getState().currentProviderId;
        const modelId = useConfigStore.getState().currentModelId;

        if (sessionId && agentName && providerId && modelId) {
          useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, nextVariant);
        }
        return;
      }

      const cyclesForward = eventMatchesShortcut(event, combo('cycle_favorite_model_forward'));
      const cyclesBackward = eventMatchesShortcut(event, combo('cycle_favorite_model_backward'));
      if (cyclesForward || cyclesBackward) {
        const { favoriteTargets } = useUIStore.getState();
        if (favoriteTargets.length === 0) {
          return;
        }

        event.preventDefault();
        const { currentProviderId, currentModelId } = useConfigStore.getState();
        const currentSessionId = useSessionUIStore.getState().currentSessionId;
        const sessionTarget = currentSessionId
          ? useSelectionStore.getState().getSessionTarget(currentSessionId)
          : null;
        const pendingHandoff = currentSessionId
          ? useSelectionStore.getState().getPendingHandoffTarget(currentSessionId)
          : null;
        const activeTarget = pendingHandoff ?? sessionTarget ?? (
          currentProviderId && currentModelId
            ? {
                harnessId: 'opencode' as const,
                providerId: currentProviderId,
                modelId: currentModelId,
              }
            : null
        );
        const currentIndex = activeTarget
          ? favoriteTargets.findIndex((favorite) => executionTargetsMatchIdentity(favorite, activeTarget))
          : -1;
        const delta = cyclesForward ? 1 : -1;
        const next = favoriteTargets[(currentIndex + delta + favoriteTargets.length) % favoriteTargets.length];
        if (!next) return;
        applyFavoriteExecutionTarget(next);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeProject?.id, activeProject?.path, currentDirectory, openNewSessionDraft, shortcutOverrides]);
};
