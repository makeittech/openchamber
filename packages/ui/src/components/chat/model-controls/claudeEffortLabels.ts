/** i18n keys for Claude reasoning-effort levels. */

import type { ClaudeEffort } from '@/lib/harness/claude-models';

export const CLAUDE_EFFORT_LABEL_KEYS: Record<
    ClaudeEffort,
    | 'chat.harness.effort.low'
    | 'chat.harness.effort.medium'
    | 'chat.harness.effort.high'
    | 'chat.harness.effort.xhigh'
    | 'chat.harness.effort.max'
> = {
    low: 'chat.harness.effort.low',
    medium: 'chat.harness.effort.medium',
    high: 'chat.harness.effort.high',
    xhigh: 'chat.harness.effort.xhigh',
    max: 'chat.harness.effort.max',
};
