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
import { Radio } from '@/components/ui/radio';
import { useI18n } from '@/lib/i18n';
import { useHarnessSwitchStore, type HarnessSwitchMode } from '@/stores/useHarnessSwitchStore';
import { cn } from '@/lib/utils';

/**
 * Confirmation shown when switching harness on a session that already has
 * messages. Explains that the switch starts a new session and lets the user
 * pick what to carry over: the duplicated transcript (visible in the new
 * session) or an LLM summary of the source session.
 */
export function HarnessSwitchDialog(): React.ReactNode {
  const { t } = useI18n();
  const pending = useHarnessSwitchStore((state) => state.pending);
  const switching = useHarnessSwitchStore((state) => state.switching);
  const error = useHarnessSwitchStore((state) => state.error);
  const cancelHarnessSwitch = useHarnessSwitchStore((state) => state.cancelHarnessSwitch);
  const confirmHarnessSwitch = useHarnessSwitchStore((state) => state.confirmHarnessSwitch);

  const [mode, setMode] = React.useState<HarnessSwitchMode>('duplicate');
  const [dontShowAgain, setDontShowAgain] = React.useState(false);

  const open = pending !== null;

  React.useEffect(() => {
    if (!open) {
      setMode('duplicate');
      setDontShowAgain(false);
    }
  }, [open]);

  if (!pending) {
    return null;
  }

  const targetLabel = pending.target.harnessId === 'claude-code'
    ? t('chat.harness.claudeCode')
    : t('chat.harness.opencode');
  const showBillingNote = pending.sourceHarnessId === 'opencode'
    && pending.target.harnessId === 'claude-code';

  const handleOpenChange = (nextOpen: boolean) => {
    if (switching) return;
    if (!nextOpen) {
      cancelHarnessSwitch();
    }
  };

  const options: Array<{ value: HarnessSwitchMode; title: string; description: string }> = [
    {
      value: 'duplicate',
      title: t('chat.harness.switch.duplicate.title'),
      description: t('chat.harness.switch.duplicate.description'),
    },
    {
      value: 'summarize',
      title: t('chat.harness.switch.summarize.title'),
      description: t('chat.harness.switch.summarize.description'),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('chat.harness.switch.title', { harness: targetLabel })}</DialogTitle>
          <DialogDescription>
            {t('chat.harness.switch.body')}
            {showBillingNote ? ` ${t('chat.harness.switch.billing')}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 py-1" role="radiogroup" aria-label={t('chat.harness.switch.optionsAria')}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={switching}
              onClick={() => setMode(option.value)}
              className={cn(
                'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors',
                mode === option.value
                  ? 'border-primary/50 bg-interactive-selection'
                  : 'border-border/60 hover:bg-interactive-hover/50',
                switching && 'opacity-60 cursor-not-allowed',
              )}
            >
              <Radio
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
                disabled={switching}
                ariaLabel={option.title}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="typography-ui-label text-foreground">{option.title}</span>
                <span className="typography-meta text-muted-foreground">{option.description}</span>
              </span>
            </button>
          ))}
        </div>

        {error ? (
          <p className="typography-meta text-destructive py-1" role="alert">{error}</p>
        ) : null}

        <div className="flex items-center gap-2 py-1">
          <Checkbox
            checked={dontShowAgain}
            onChange={setDontShowAgain}
            disabled={switching}
            ariaLabel={t('chat.harness.switch.dontShowAgainAria')}
          />
          <span
            className="typography-ui-label text-foreground cursor-pointer select-none"
            onClick={() => !switching && setDontShowAgain((value) => !value)}
          >
            {t('chat.harness.switch.dontShowAgain')}
          </span>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelHarnessSwitch}
            disabled={switching}
          >
            {t('chat.harness.switch.cancel')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void confirmHarnessSwitch(mode, dontShowAgain)}
            disabled={switching}
          >
            {switching
              ? t('chat.harness.switch.working')
              : t('chat.harness.switch.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
