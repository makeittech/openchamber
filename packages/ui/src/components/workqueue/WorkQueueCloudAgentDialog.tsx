import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { WorkQueueCloudAgentDraft } from '@/lib/api/types';

interface WorkQueueCloudAgentDialogProps {
  itemId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (options: { prompt: string; model: string; repository: string }) => Promise<void>;
}

/**
 * Review-before-send dialog for a Cursor cloud agent dispatch. The prompt and
 * model are server-drafted but fully editable here, so nothing is sent to an
 * external service without the user seeing exactly what it is.
 */
export const WorkQueueCloudAgentDialog: React.FC<WorkQueueCloudAgentDialogProps> = ({
  itemId,
  open,
  onOpenChange,
  onSubmit,
}) => {
  const { t } = useI18n();
  const { workQueue } = useRuntimeAPIs();

  const [draft, setDraft] = React.useState<WorkQueueCloudAgentDraft | null>(null);
  const [prompt, setPrompt] = React.useState('');
  const [model, setModel] = React.useState('');
  const [repository, setRepository] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !itemId || !workQueue) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    workQueue.cloudAgentDraft(itemId)
      .then((next) => {
        if (cancelled) return;
        setDraft(next);
        setPrompt(next.prompt);
        setModel(next.model);
        setRepository(next.repository);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, itemId, workQueue]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit({ prompt, model, repository });
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const canSubmit = Boolean(prompt.trim() && repository.trim() && draft?.connected && !isLoading && !isSubmitting);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('workQueue.cloudAgent.dialog.title')}</DialogTitle>
          <DialogDescription>{t('workQueue.cloudAgent.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
          {error && <p className="typography-ui-label text-destructive">{error}</p>}
          {draft && !draft.connected && (
            <p className="typography-ui-label text-status-warning">{t('workQueue.cloudAgent.dialog.notConnected')}</p>
          )}

          <div className="space-y-1.5">
            <label className="typography-micro font-medium uppercase tracking-wide text-muted-foreground/60">
              {t('workQueue.cloudAgent.dialog.repository')}
            </label>
            <Input value={repository} onChange={(event) => setRepository(event.target.value)} disabled={isLoading} />
          </div>

          <div className="space-y-1.5">
            <label className="typography-micro font-medium uppercase tracking-wide text-muted-foreground/60">
              {t('workQueue.cloudAgent.dialog.model')}
            </label>
            <Input value={model} onChange={(event) => setModel(event.target.value)} disabled={isLoading} />
          </div>

          <div className="space-y-1.5">
            <label className="typography-micro font-medium uppercase tracking-wide text-muted-foreground/60">
              {t('workQueue.cloudAgent.dialog.prompt')}
            </label>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={isLoading}
              className="min-h-[16rem] font-mono"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('workQueue.cloudAgent.dialog.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit} className="gap-1.5">
            <Icon name="cloud" className={isSubmitting ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {t('workQueue.cloudAgent.dialog.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
