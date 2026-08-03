import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WorkQueueCloseReason, WorkQueueItem } from '@/lib/api/types';

interface WorkQueueFinishDialogProps {
  item: WorkQueueItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (options: { closeReason: WorkQueueCloseReason; duplicateOfUrl?: string }) => Promise<void>;
}

const CLOSE_REASONS: { value: WorkQueueCloseReason; labelKey: I18nKey; icon: IconName }[] = [
  { value: 'completed', labelKey: 'workQueue.detail.finishDialog.reason.completed', icon: 'check' },
  { value: 'duplicate', labelKey: 'workQueue.detail.finishDialog.reason.duplicate', icon: 'file-copy-2' },
  { value: 'not_planned', labelKey: 'workQueue.detail.finishDialog.reason.notPlanned', icon: 'close' },
];

// Lets the user pick how a card is being closed — mirrors GitHub's own close
// reasons ("Completed" / "Not planned") plus a Linear-style "duplicate"
// close — instead of every Finish always meaning "done". When the AI
// analysis already flagged a likely duplicate, the URL is pre-filled but
// stays editable: the user's own knowledge of a duplicate always wins.
export const WorkQueueFinishDialog: React.FC<WorkQueueFinishDialogProps> = ({ item, open, onOpenChange, onSubmit }) => {
  const { t } = useI18n();
  const [closeReason, setCloseReason] = React.useState<WorkQueueCloseReason>('completed');
  const [duplicateOfUrl, setDuplicateOfUrl] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setCloseReason('completed');
    setDuplicateOfUrl(item?.aiAnalysis?.duplicateOfUrl || '');
  }, [open, item?.aiAnalysis?.duplicateOfUrl]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit({
        closeReason,
        duplicateOfUrl: closeReason === 'duplicate' ? duplicateOfUrl.trim() || undefined : undefined,
      });
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('workQueue.detail.finishDialog.title')}</DialogTitle>
          <DialogDescription>{t('workQueue.detail.finishDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            {CLOSE_REASONS.map((reason) => (
              <button
                key={reason.value}
                type="button"
                aria-pressed={closeReason === reason.value}
                onClick={() => setCloseReason(reason.value)}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-2 text-left typography-ui-label transition-colors',
                  closeReason === reason.value
                    ? 'border-primary bg-interactive-selection text-foreground'
                    : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                <Icon name={reason.icon} className="h-3.5 w-3.5 flex-shrink-0" />
                {t(reason.labelKey)}
              </button>
            ))}
          </div>

          {closeReason === 'duplicate' && (
            <div className="space-y-1.5">
              <label className="typography-micro font-medium uppercase tracking-wide text-muted-foreground/60">
                {t('workQueue.detail.finishDialog.duplicateOfLabel')}
              </label>
              <Input
                value={duplicateOfUrl}
                onChange={(event) => setDuplicateOfUrl(event.target.value)}
                placeholder={t('workQueue.detail.finishDialog.duplicateOfPlaceholder')}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('workQueue.detail.finishDialog.cancel')}
          </Button>
          <Button size="sm" variant="destructive" onClick={handleSubmit} disabled={isSubmitting} className="gap-1.5">
            <Icon name="check" className={isSubmitting ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {t('workQueue.detail.finishDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
