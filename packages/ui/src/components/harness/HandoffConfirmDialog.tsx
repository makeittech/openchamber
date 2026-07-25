import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';

export type HandoffConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: (dontShowAgain: boolean) => void | Promise<void>;
  onCancel: () => void;
  /** Destination engine for handoff copy. Defaults to Claude Code. */
  targetHarnessId?: 'claude-code' | 'cursor';
};

export function HandoffConfirmDialog({
  open,
  onOpenChange,
  onContinue,
  onCancel,
  targetHarnessId = 'claude-code',
}: HandoffConfirmDialogProps): React.ReactNode {
  const { t } = useI18n();
  const [dontShowAgain, setDontShowAgain] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const titleKey = targetHarnessId === 'cursor'
    ? 'chat.handoff.cursorBillingDialog.title'
    : 'chat.handoff.billingDialog.title';
  const bodyKey = targetHarnessId === 'cursor'
    ? 'chat.handoff.cursorBillingDialog.body'
    : 'chat.handoff.billingDialog.body';

  React.useEffect(() => {
    if (!open) {
      setDontShowAgain(false);
      setBusy(false);
    }
  }, [open]);

  const dismissWithoutContinueRef = React.useRef(true);

  const handleCancel = () => {
    if (busy) return;
    dismissWithoutContinueRef.current = true;
    onCancel();
    onOpenChange(false);
  };

  const handleContinue = async () => {
    if (busy) return;
    setBusy(true);
    dismissWithoutContinueRef.current = false;
    try {
      await onContinue(dontShowAgain);
      onOpenChange(false);
    } finally {
      setBusy(false);
      dismissWithoutContinueRef.current = true;
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (busy) return;
    if (!nextOpen && dismissWithoutContinueRef.current) {
      onCancel();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
          <DialogDescription>
            {t(bodyKey)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 py-1">
          <Checkbox
            checked={dontShowAgain}
            onChange={setDontShowAgain}
            disabled={busy}
            ariaLabel={t('chat.handoff.billingDialog.dontShowAgainAria')}
          />
          <span
            className="typography-ui-label text-foreground cursor-pointer select-none"
            onClick={() => !busy && setDontShowAgain((value) => !value)}
          >
            {t('chat.handoff.billingDialog.dontShowAgain')}
          </span>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={busy}
          >
            {t('chat.handoff.billingDialog.cancel')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleContinue()}
            disabled={busy}
          >
            {t('chat.handoff.billingDialog.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
