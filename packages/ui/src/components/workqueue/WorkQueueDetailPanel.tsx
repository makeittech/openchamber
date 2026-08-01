import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useWorkQueueStore } from '@/stores/useWorkQueueStore';
import type { WorkQueueItem, WorkQueueStalenessResult } from '@/lib/api/types';
import { WorkQueueComplexityBadge, WorkQueueEnvBadges, WorkQueuePriorityBadge } from './workQueueBadges';
import { WorkQueueCloudAgentDialog } from './WorkQueueCloudAgentDialog';

const buildItemContextText = (item: WorkQueueItem): string => {
  const payload = {
    source: item.source,
    type: item.type,
    repo: item.repo || undefined,
    team: item.team || undefined,
    title: item.title,
    url: item.url,
    author: item.author || undefined,
    labels: item.labels,
    aiAnalysis: item.aiAnalysis || undefined,
  };
  return `Work queue item context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

interface WorkQueueDetailPanelProps {
  item: WorkQueueItem;
  onClose: () => void;
}

// Pull requests are never AI-analyzed; their second tab shows the automated
// PR review comments instead of an analysis pass.
type DetailTab = 'overview' | 'analysis' | 'review';

export const WorkQueueDetailPanel: React.FC<WorkQueueDetailPanelProps> = ({ item, onClose }) => {
  const { t } = useI18n();
  const { workQueue } = useRuntimeAPIs();
  const moveItem = useWorkQueueStore((state) => state.moveItem);
  const analyzeItem = useWorkQueueStore((state) => state.analyzeItem);
  const finishItem = useWorkQueueStore((state) => state.finishItem);
  const launchCloudAgent = useWorkQueueStore((state) => state.launchCloudAgent);
  const attachPr = useWorkQueueStore((state) => state.attachPr);
  const projects = useProjectsStore((state) => state.projects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const [tab, setTab] = React.useState<DetailTab>('overview');
  const [isAnalyzing, setIsAnalyzing] = React.useState(false);
  const [isLaunchingCloud, setIsLaunchingCloud] = React.useState(false);
  const [isFinishing, setIsFinishing] = React.useState(false);
  const [isCloudDialogOpen, setIsCloudDialogOpen] = React.useState(false);
  const [stalenessResult, setStalenessResult] = React.useState<WorkQueueStalenessResult | null>(null);
  const [isCheckingStaleness, setIsCheckingStaleness] = React.useState(false);
  const [prUrlInput, setPrUrlInput] = React.useState('');
  const [isAttachingPr, setIsAttachingPr] = React.useState(false);

  const isPullRequest = item.type === 'pr';
  const tabs = React.useMemo<DetailTab[]>(
    () => (isPullRequest ? ['overview', 'review'] : ['overview', 'analysis']),
    [isPullRequest],
  );

  React.useEffect(() => {
    setTab('overview');
    setStalenessResult(null);
    setPrUrlInput('');
  }, [item.id]);

  const projectDirectory = React.useMemo(() => {
    if (activeProject?.path) return activeProject.path;
    if (currentDirectory) {
      const match = projects.find((project) => project.path === currentDirectory);
      if (match) return match.path;
    }
    return projects[0]?.path || null;
  }, [activeProject?.path, currentDirectory, projects]);

  const externalUrl = item.url;
  const externalLabel = item.source === 'github' ? t('workQueue.detail.actions.openGitHub') : t('workQueue.detail.actions.openLinear');

  const handleAnalyze = async () => {
    if (!workQueue) return;
    setIsAnalyzing(true);
    try {
      await analyzeItem(workQueue, item.id, projectDirectory || undefined);
    } catch (error) {
      toast.error(t('workQueue.detail.toast.analyzeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleTake = async () => {
    if (!workQueue) return;
    const warning = await moveItem(workQueue, item.id, 'in_progress');
    if (warning?.linearSyncWarning) toast.warning(t('workQueue.board.toast.linearSyncFailed'));
    if (warning?.assigneeSyncWarning) toast.warning(t('workQueue.board.toast.assigneeSyncFailed'));
  };

  const handleCopyPrompt = async () => {
    const prompt = item.aiAnalysis?.generatedPrompt;
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success(t('workQueue.detail.toast.promptCopied'));
    } catch {
      toast.error(t('workQueue.detail.toast.copyFailed'));
    }
  };

  // Hands the task to the composer as a draft the user can review and send —
  // it must never start a session on its own. Closes the work queue window so
  // the drafted prompt is immediately visible.
  const handleOpenInOpenChamber = () => {
    if (!projectDirectory) {
      toast.error(t('workQueue.detail.error.noActiveProject'));
      return;
    }

    const visiblePromptText = item.aiAnalysis?.generatedPrompt
      || `Work on: ${item.title}\n\n${item.url}`;
    const instructionsText = [
      'You are working on a task from the OpenChamber AI Work Queue. The task context is attached below as JSON.',
      'Implement the requested change end to end: explore the codebase, make the change, and verify it with the narrowest relevant checks.',
      'When finished, end with a concise factual summary of what was done and what was verified.',
    ].join('\n');
    const contextText = buildItemContextText(item);

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: projectDirectory,
      initialPrompt: visiblePromptText,
      syntheticParts: [
        { text: instructionsText, synthetic: true },
        { text: contextText, synthetic: true },
      ],
    });
    useUIStore.getState().setActiveMainTab('chat');
    useUIStore.getState().setWorkQueueOpen(false);
  };

  const handleLaunchCloudAgent = async (options: { prompt: string; model: string; repository: string }) => {
    if (!workQueue) return;
    setIsLaunchingCloud(true);
    try {
      await launchCloudAgent(workQueue, item.id, options);
      const failure = useWorkQueueStore.getState().error;
      if (failure) {
        toast.error(t('workQueue.detail.toast.cloudAgentFailed'), { description: failure });
        return;
      }
      toast.success(t('workQueue.detail.toast.cloudAgentLaunched'));
    } catch (error) {
      toast.error(t('workQueue.detail.toast.cloudAgentFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLaunchingCloud(false);
    }
  };

  const handleFinish = async () => {
    if (!workQueue) return;
    setIsFinishing(true);
    try {
      const result = await finishItem(workQueue, item.id, { mergePr: item.type === 'pr' });
      if (result?.archived) {
        toast.success(t('workQueue.detail.toast.finished'));
        onClose();
      } else {
        toast.error(t('workQueue.detail.toast.finishIncomplete'));
      }
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col border-l border-border/50 bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          {item.aiAnalysis && <WorkQueuePriorityBadge priority={item.aiAnalysis.priority} />}
          <span className="typography-micro text-muted-foreground truncate">{item.repo || item.team}</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label={t('workQueue.detail.close')}>
          <Icon name="close" className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-4 pt-3">
        <h2 className="typography-ui-title font-semibold text-foreground">{item.title}</h2>
      </div>

      <div className="flex items-center gap-1 border-b border-border/50 px-4 pt-3">
        {tabs.map((tabKey) => (
          <button
            key={tabKey}
            type="button"
            onClick={() => setTab(tabKey)}
            className={cn(
              'px-2.5 py-2 typography-ui-label border-b-2 -mb-px transition-colors',
              tab === tabKey ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`workQueue.detail.tab.${tabKey}` as const)}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {tab === 'overview' && (
          <div className="space-y-4">
            {item.aiAnalysis?.summary && (
              <p className="typography-ui-label text-foreground/90 leading-relaxed">{item.aiAnalysis.summary}</p>
            )}

            {/* Source description: available straight after sync, so Overview
                is never empty while an item is still waiting on analysis. */}
            <div className="space-y-1.5">
              <div className="typography-micro font-medium uppercase tracking-wide text-muted-foreground/60">
                {t('workQueue.detail.field.description')}
              </div>
              {item.body ? (
                <pre className="whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/20 p-2.5 typography-micro text-foreground/90 max-h-72 overflow-y-auto">
                  {item.body}
                </pre>
              ) : (
                <p className="typography-ui-label text-muted-foreground">{t('workQueue.detail.noDescription')}</p>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 typography-ui-label">
              {item.aiAnalysis && (
                <>
                  <dt className="text-muted-foreground">{t('workQueue.detail.field.priority')}</dt>
                  <dd><WorkQueuePriorityBadge priority={item.aiAnalysis.priority} /></dd>
                  <dt className="text-muted-foreground">{t('workQueue.detail.field.complexity')}</dt>
                  <dd><WorkQueueComplexityBadge complexity={item.aiAnalysis.complexity} /></dd>
                  <dt className="text-muted-foreground">{t('workQueue.detail.field.confidence')}</dt>
                  <dd>{t('workQueue.card.confidence', { confidence: item.aiAnalysis.confidence })}</dd>
                  {typeof item.aiAnalysis.estimateMinutes === 'number' && (
                    <>
                      <dt className="text-muted-foreground">{t('workQueue.detail.field.estimate')}</dt>
                      <dd>{t('workQueue.card.estimateMinutes', { minutes: item.aiAnalysis.estimateMinutes })}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">{t('workQueue.detail.field.environment')}</dt>
                  <dd>
                    <WorkQueueEnvBadges
                      needsHeadless={item.aiAnalysis.needsHeadless}
                      needsBrowser={item.aiAnalysis.needsBrowser}
                      needsDocker={item.aiAnalysis.needsDocker}
                    />
                  </dd>
                </>
              )}
              {item.author && (
                <>
                  <dt className="text-muted-foreground">{t('workQueue.detail.field.author')}</dt>
                  <dd>{item.author}</dd>
                </>
              )}
              {item.labels.length > 0 && (
                <>
                  <dt className="text-muted-foreground">{t('workQueue.detail.field.labels')}</dt>
                  <dd className="truncate">{item.labels.join(', ')}</dd>
                </>
              )}
            </dl>

            {item.cloudAgent && (
              <div className="rounded-md border border-border/50 px-3 py-2 typography-ui-label">
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Icon name="cloud" className="h-3.5 w-3.5" />
                    {t('workQueue.detail.cloudAgentStatus', { status: item.cloudAgent.status })}
                  </div>
                  {item.cloudAgent.url && (
                    <a
                      href={item.cloudAgent.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      {t('workQueue.detail.actions.openCloudAgent')}
                      <Icon name="external-link" className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'review' && (
          <div className="space-y-3">
            {item.reviewComments.length === 0 ? (
              <p className="typography-ui-label text-muted-foreground">{t('workQueue.detail.review.empty')}</p>
            ) : (
              item.reviewComments.map((comment, index) => (
                <div key={comment.url || index} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 typography-micro text-muted-foreground/60">
                    <span>{comment.author}</span>
                    {comment.url && (
                      <a href={comment.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
                        <Icon name="external-link" className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/20 p-2.5 typography-micro text-foreground/90">
                    {comment.body}
                  </pre>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'analysis' && (
          <div className="space-y-3">
            {!item.aiAnalysis && !item.aiAnalysisError && (
              <p className="typography-ui-label text-muted-foreground">{t('workQueue.card.notAnalyzed')}</p>
            )}
            {item.aiAnalysisError && (
              <p className="typography-ui-label text-destructive">{item.aiAnalysisError}</p>
            )}
            <Button variant="outline" size="sm" onClick={handleAnalyze} disabled={isAnalyzing} className="gap-1.5">
              <Icon name="sparkling" className={isAnalyzing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {item.aiAnalysis ? t('workQueue.detail.actions.reanalyze') : t('workQueue.detail.actions.analyze')}
            </Button>
            {item.aiAnalysis?.generatedPrompt && (
              <div className="space-y-1.5">
                <div className="typography-micro font-medium uppercase tracking-wide text-muted-foreground/60">
                  {t('workQueue.detail.field.generatedPrompt')}
                </div>
                <pre className="whitespace-pre-wrap rounded-md border border-border/50 bg-muted/20 p-2.5 typography-micro text-foreground/90">
                  {item.aiAnalysis.generatedPrompt}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border/50 p-3">
        {/* Exactly one primary action; every other action shares the same
            outline treatment so nothing but Take Task competes for attention. */}
        <Button size="sm" onClick={handleTake} disabled={item.status === 'in_progress'}>
          {t('workQueue.detail.actions.take')}
        </Button>
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="outline" onClick={handleOpenInOpenChamber} className="gap-1.5">
            <Icon name="terminal-box" className="h-3.5 w-3.5" />
            {t('workQueue.detail.actions.openInOpenChamber')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setIsCloudDialogOpen(true)}
            disabled={isLaunchingCloud || item.source !== 'github'}
            className="gap-1.5"
          >
            <Icon name="cloud" className="h-3.5 w-3.5" />
            {t('workQueue.detail.actions.cloudAgent')}
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopyPrompt} disabled={!item.aiAnalysis?.generatedPrompt} className="gap-1.5">
            <Icon name="clipboard" className="h-3.5 w-3.5" />
            {t('workQueue.detail.actions.copyPrompt')}
          </Button>
          {externalUrl && (
            <Button size="sm" variant="outline" asChild className="gap-1.5">
              <a href={externalUrl} target="_blank" rel="noreferrer">
                <Icon name="external-link" className="h-3.5 w-3.5" />
                {externalLabel}
              </a>
            </Button>
          )}
          {/* A GitHub issue/PR referencing this Linear card was merged into it
              instead of shown as a separate item — surface its link too. */}
          {item.source === 'linear' && item.linkedGithubUrl && (
            <Button size="sm" variant="outline" asChild className="gap-1.5">
              <a href={item.linkedGithubUrl} target="_blank" rel="noreferrer">
                <Icon name="external-link" className="h-3.5 w-3.5" />
                {t('workQueue.detail.actions.openGitHub')}
              </a>
            </Button>
          )}
        </div>
        <Button size="sm" variant="destructive" onClick={handleFinish} disabled={isFinishing} className="gap-1.5">
          <Icon name="check" className="h-3.5 w-3.5" />
          {t('workQueue.detail.actions.finish')}
        </Button>
      </div>

      <WorkQueueCloudAgentDialog
        itemId={isCloudDialogOpen ? item.id : null}
        open={isCloudDialogOpen}
        onOpenChange={setIsCloudDialogOpen}
        onSubmit={handleLaunchCloudAgent}
      />
    </div>
  );
};
