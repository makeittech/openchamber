import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { parseHandoffContextText } from '@/lib/harness/handoff-context';

/**
 * Renders the transferred handoff context message as a collapsible card so
 * the destination session shows what was carried over without flooding the
 * transcript. The underlying text part is a real (non-synthetic) message, so
 * the model still receives it as context.
 */
export const HandoffContextPartCard: React.FC<{ part: Part }> = ({ part }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);

  const text = typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text
    : '';
  const parsed = parseHandoffContextText(text);
  const body = parsed?.body ?? text;

  return (
    <div className="mt-1 rounded-md border border-border/60 bg-muted/30">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded
          ? t('chat.harness.contextCard.collapseAria')
          : t('chat.harness.contextCard.expandAria')}
      >
        <Icon name="arrow-right-s" className={expanded ? 'size-3.5 rotate-90 transition-transform' : 'size-3.5 transition-transform'} />
        <span className="typography-meta font-medium">{t('chat.harness.contextCard.title')}</span>
      </button>
      {expanded ? (
        <div className="border-t border-border/60 px-2.5 py-2 max-h-72 overflow-y-auto">
          <pre className="typography-meta whitespace-pre-wrap break-words text-foreground/80">{body}</pre>
        </div>
      ) : null}
    </div>
  );
};
