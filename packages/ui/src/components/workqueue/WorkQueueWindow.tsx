import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { WorkQueueView } from './WorkQueueView';

interface WorkQueueWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const WorkQueueWindow: React.FC<WorkQueueWindowProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const descriptionId = React.useId();

  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return false;
    }
    return Boolean(
      document.querySelector('[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]')
    );
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && hasOpenFloatingMenu()) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            'fixed inset-0 z-50 bg-black/50 dark:bg-black/75',
            'transition-opacity duration-150 ease-out',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <Dialog.Popup
            aria-describedby={descriptionId}
            className={cn(
              'relative pointer-events-auto',
              'w-[95vw] max-w-[1400px] h-[85vh] max-h-[960px]',
              'rounded-xl border shadow-none overflow-hidden origin-center',
              'bg-background',
              'transition-all duration-150 ease-out',
              'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]',
              'data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]',
            )}
          >
            <Dialog.Description id={descriptionId} className="sr-only">
              {t('workQueue.window.description')}
            </Dialog.Description>
            <WorkQueueView onClose={() => onOpenChange(false)} />
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
