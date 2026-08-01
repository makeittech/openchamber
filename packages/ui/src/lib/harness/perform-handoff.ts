import type { ExecutionTarget, HarnessId } from '@/types/harness';
import { getDirectoryState, getSyncSessionStatus } from '@/sync/sync-refs';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { harnessPrompt } from '@/lib/harness/client';
import { fetchMessagesForSession, waitForConnectionOrThrow } from '@/sync/session-actions';
import {
  buildHandoffSeedText,
  clearPendingHandoffTarget,
  extractCompactionSummary,
} from '@/lib/harness/session-handoff';
import { buildHandoffContextText, type HandoffContextMode } from '@/lib/harness/handoff-context';
import { persistSessionExecutionTarget } from '@/lib/harness/resolve-execution-target';
import { useSessionUIStore } from '@/sync/session-ui-store';

const CLAUDE_COMPACT_TIMEOUT_MS = 180_000;
const CLAUDE_COMPACT_POLL_MS = 1_200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function summarizeOpenCodeSource(
  sourceSessionId: string,
  directory: string | null,
): Promise<string> {
  await waitForConnectionOrThrow();
  const selection = useSelectionStore.getState().getSessionModelSelection(sourceSessionId);
  const config = useConfigStore.getState();
  const providerID = selection?.providerId ?? config.currentProviderId;
  const modelID = selection?.modelId ?? config.currentModelId;
  if (!providerID || !modelID) {
    throw new Error('No model available to summarize this session');
  }
  await opencodeClient.summarizeSession(
    sourceSessionId,
    providerID,
    modelID,
    directory ?? undefined,
  );
  await fetchMessagesForSession(sourceSessionId, directory);
  const summary = extractCompactionSummary(sourceSessionId, directory);
  if (!summary) {
    throw new Error('Summarize finished without producing a summary');
  }
  return summary;
}

async function summarizeClaudeSource(args: {
  sourceSessionId: string;
  directory: string;
  sourceTarget: ExecutionTarget;
}): Promise<string> {
  const before = extractCompactionSummary(args.sourceSessionId, args.directory);
  await harnessPrompt({
    sessionId: args.sourceSessionId,
    directory: args.directory,
    target: args.sourceTarget,
    text: '/compact',
  });
  const deadline = Date.now() + CLAUDE_COMPACT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(CLAUDE_COMPACT_POLL_MS);
    const status = getSyncSessionStatus(args.sourceSessionId, args.directory);
    const busy = Boolean(status?.type && status.type !== 'idle');
    if (busy) continue;
    const summary = extractCompactionSummary(args.sourceSessionId, args.directory);
    if (summary && summary !== before) {
      return summary;
    }
  }
  throw new Error('Timed out waiting for Claude /compact to finish');
}

async function postContextMessage(args: {
  sessionId: string;
  directory: string | null;
  target: ExecutionTarget;
  contextText: string;
}): Promise<void> {
  if (args.target.harnessId === 'claude-code') {
    if (!args.directory) {
      throw new Error('directory is required for Claude Code');
    }
    void harnessPrompt({
      sessionId: args.sessionId,
      directory: args.directory,
      target: args.target,
      text: args.contextText,
    }).catch(() => {
      // The switch already succeeded; stream events surface prompt failures.
    });
    return;
  }
  await opencodeClient.postContextMessage({
    id: args.sessionId,
    text: args.contextText,
    directory: args.directory,
  });
}

export type HarnessHandoffArgs = {
  sourceSessionId: string;
  directory: string | null;
  sourceHarnessId: HarnessId;
  target: ExecutionTarget;
  mode: HandoffContextMode;
};

export async function performHarnessHandoff(args: HarnessHandoffArgs): Promise<void> {
  const sourceLabel = args.sourceHarnessId === 'claude-code' ? 'Claude Code' : 'OpenCode';

  // Summarize before creation so failure leaves the source session untouched.
  let body: string;
  if (args.mode === 'summarize') {
    body = args.sourceHarnessId === 'claude-code'
      ? await summarizeClaudeSource({
        sourceSessionId: args.sourceSessionId,
        directory: args.directory ?? '',
        sourceTarget: useSelectionStore.getState().getSessionTarget(args.sourceSessionId)
          ?? { harnessId: 'claude-code', modelRef: 'sonnet' },
      })
      : await summarizeOpenCodeSource(args.sourceSessionId, args.directory);
  } else {
    const seed = buildHandoffSeedText(
      args.sourceSessionId,
      args.directory,
      undefined,
      args.sourceHarnessId,
    );
    if (!seed.text) {
      throw new Error('Nothing to transfer from this session');
    }
    body = seed.text;
  }

  const store = useSessionUIStore.getState();
  const isSource = (session: { id: string }) => session.id === args.sourceSessionId;
  const globalSessions = useGlobalSessionsStore.getState();
  const sourceTitleCandidate = getDirectoryState(args.directory ?? undefined)?.session?.find(isSource)?.title
    ?? globalSessions.activeSessions.find(isSource)?.title
    ?? globalSessions.archivedSessions.find(isSource)?.title;
  const title = typeof sourceTitleCandidate === 'string' && sourceTitleCandidate.trim()
    ? sourceTitleCandidate.trim()
    : undefined;
  const created = await store.createSession(title, args.directory);
  if (!created?.id) {
    throw new Error('Failed to create the destination session');
  }
  const directory = created.directory ?? args.directory;

  persistSessionExecutionTarget(created.id, args.target);
  const providerID = args.target.harnessId === 'claude-code' ? 'claude-code' : args.target.providerId;
  const modelID = args.target.harnessId === 'claude-code' ? args.target.modelRef : args.target.modelId;
  useSelectionStore.getState().saveSessionModelSelection(created.id, providerID, modelID);

  clearPendingHandoffTarget(args.sourceSessionId);

  store.setCurrentSession(created.id, directory);
  const contextText = buildHandoffContextText({
    sourceLabel,
    mode: args.mode,
    body,
    targetHarnessId: args.target.harnessId,
  });
  await postContextMessage({
    sessionId: created.id,
    directory,
    target: args.target,
    contextText,
  });
}
