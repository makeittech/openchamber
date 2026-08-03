import React, { useEffect, useRef, useState } from 'react';
import { RiAlertLine } from '@remixicon/react';
import {
  MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MAX_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MIN_MS,
  deriveDiscordDisplayStatus,
  deriveDiscordViewState,
  isDiscordGuildSyncing,
  useMessengerStore,
  type MessengerType,
  type MessengerConnection,
  type MessengerVerbosity,
  type MessengerPermissionMode,
  type MessengerDiagnosisCheck,
  type MessengerInboundMessage,
} from '@/stores/useMessengerStore';
import { useDiscordGuildMembershipPoll } from './useDiscordGuildMembershipPoll';
import { useOpenChamberAgentEventsStore, type OpenChamberAgentUiRealtimeEvent } from '@/stores/useOpenChamberAgentEventsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { DiscordOnboardingWizard } from './DiscordOnboardingWizard';
import { DiscordCommandsButton } from './DiscordCommandPalette';

/** Discord brand mark — intentional product color, not a theme token. */
const DISCORD_BRAND_CLASS = 'text-[#5865F2]';

type DiscordGuildListItem = {
  id: string;
  name: string;
  icon?: string | null;
};

interface MessengerMeta {
  name: string;
  color: string;
  targetLabel: string;
  targetPlaceholder: string;
  targetHelp: React.ReactNode;
}

const MESSENGER_META: Record<MessengerType, MessengerMeta> = {
  discord: {
    name: 'Discord',
    color: DISCORD_BRAND_CLASS,
    targetLabel: 'Channel ID',
    targetPlaceholder: 'e.g. 1234567890123456789',
    targetHelp: (
      <>
        Enable Developer Mode, then right-click a text channel → <strong>Copy Channel ID</strong>.
      </>
    ),
  },
};

/** Public Discord CDN guild icon URL, or null when the guild has no icon. */
function discordGuildIconUrl(
  guildId: string,
  iconHash: string | null | undefined,
  size = 64,
): string | null {
  if (!iconHash) return null;
  const ext = iconHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${encodeURIComponent(guildId)}/${encodeURIComponent(iconHash)}.${ext}?size=${size}`;
}

function guildInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function DiscordGuildIcon({
  guild,
  className,
}: {
  guild: DiscordGuildListItem;
  className?: string;
}) {
  const { t } = useI18n();
  const src = discordGuildIconUrl(guild.id, guild.icon);
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={t('settings.integrations.discord.servers.iconAlt', { name: guild.name })}
        className={cn('size-8 shrink-0 rounded-full object-cover', className)}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[10px] font-semibold text-muted-foreground',
        className,
      )}
    >
      {guildInitials(guild.name)}
    </span>
  );
}

const VERBOSITY_OPTIONS: {
  id: MessengerVerbosity;
  labelKey: I18nKey;
  descKey: I18nKey;
}[] = [
  {
    id: 'quiet',
    labelKey: 'settings.integrations.discord.bridge.verbosity.quiet.label',
    descKey: 'settings.integrations.discord.bridge.verbosity.quiet.desc',
  },
  {
    id: 'normal',
    labelKey: 'settings.integrations.discord.bridge.verbosity.normal.label',
    descKey: 'settings.integrations.discord.bridge.verbosity.normal.desc',
  },
  {
    id: 'verbose',
    labelKey: 'settings.integrations.discord.bridge.verbosity.verbose.label',
    descKey: 'settings.integrations.discord.bridge.verbosity.verbose.desc',
  },
];

const PERMISSION_MODE_OPTIONS: {
  id: MessengerPermissionMode;
  labelKey: I18nKey;
  descKey: I18nKey;
}[] = [
  {
    id: 'ask',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.ask.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.ask.desc',
  },
  {
    id: 'yolo',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.yolo.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.yolo.desc',
  },
  {
    id: 'agent',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.agent.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.agent.desc',
  },
];

function StatusBadge({ status }: { status: MessengerConnection['status'] }) {
  const { t } = useI18n();
  const styles: Record<string, string> = {
    connected:
      'bg-[var(--status-success)]/15 text-[var(--status-success)]',
    connecting:
      'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
    error: 'bg-[var(--status-error)]/15 text-[var(--status-error)]',
    disconnected: 'bg-muted text-muted-foreground',
  };
  const labelKey: I18nKey =
    status === 'connected'
      ? 'settings.integrations.discord.status.connected'
      : status === 'connecting'
        ? 'settings.integrations.discord.status.connecting'
        : status === 'error'
          ? 'settings.integrations.discord.status.error'
          : 'settings.integrations.discord.status.disconnected';
  const label = t(labelKey);
  // Connected: checkmark only (label stays for accessibility). Other states keep text.
  if (status === 'connected') {
    return (
      <span
        className={cn(
          'inline-flex size-5 items-center justify-center rounded-full',
          styles.connected,
        )}
        title={label}
        aria-label={label}
      >
        <Icon name="check" className="size-3" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
        styles[status],
      )}
      aria-label={label}
    >
      {status === 'connecting' ? (
        <Icon name="loader-4" className="size-3 animate-spin" />
      ) : null}
      {label}
    </span>
  );
}

type TranslateFn = (key: I18nKey, params?: Record<string, string | number | boolean | null | undefined>) => string;

function formatRelative(ts: number | null | undefined, t: TranslateFn): string {
  if (!ts) return t('settings.integrations.discord.relative.never');
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('common.relative.justNow');
  if (diff < 3_600_000) {
    return t('common.relative.minutesAgoShort', { count: Math.floor(diff / 60_000) });
  }
  if (diff < 86_400_000) {
    return t('common.relative.hoursAgoShort', { count: Math.floor(diff / 3_600_000) });
  }
  return new Date(ts).toLocaleString();
}

/** Collapsible card used by Discord Advanced settings accordion sections. */
function AdvancedSectionCard({
  icon,
  title,
  meta,
  badge,
  open,
  onOpenChange,
  children,
}: {
  icon: IconName;
  title: string;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]">
        <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-none px-4 py-3 hover:bg-[var(--interactive-hover)]/50">
          <Icon name={icon} className="size-4 shrink-0 text-primary" />
          <span className="shrink-0 text-sm font-semibold text-foreground">{title}</span>
          {badge}
          {meta ? (
            <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">
              {meta}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <Icon
            name={open ? 'arrow-up-s' : 'arrow-down-s'}
            className="size-4 shrink-0 text-muted-foreground"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-3">
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Segmented picker matching the Discord Advanced settings mock (chip selection). */
function DiscordSegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <Button
          key={opt.id}
          type="button"
          variant="chip"
          size="xs"
          disabled={disabled}
          aria-pressed={value === opt.id}
          className="!font-normal normal-case"
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

type DangerZoneKey = 'fallback' | 'owner' | 'trusted' | 'slash';

function DangerZoneRow({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/40"
      >
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Icon
          name={open ? 'arrow-down-s' : 'arrow-right-s'}
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>
      {open ? <div className="space-y-2 px-4 pb-3">{children}</div> : null}
    </div>
  );
}

function severityClass(s: MessengerDiagnosisCheck['severity']) {
  if (s === 'ok') return 'text-green-600 dark:text-green-400';
  if (s === 'warn') return 'text-yellow-600 dark:text-yellow-400';
  if (s === 'error') return 'text-destructive';
  return 'text-muted-foreground';
}

function DiscordListenerPanel({
  conn,
  inbound,
  history,
  startListener,
  stopListener,
  refreshStatus,
  loadRecent,
  loadHistory,
}: {
  conn: MessengerConnection;
  inbound: MessengerInboundMessage[];
  history: ReturnType<typeof useMessengerStore.getState>['discordHistory'];
  startListener: () => Promise<boolean>;
  stopListener: () => Promise<boolean>;
  refreshStatus: () => Promise<void>;
  loadRecent: () => Promise<void>;
  loadHistory: (channelId: string, limit?: number) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const running = Boolean(conn.discordListenerRunning);
  const connected = Boolean(conn.discordListenerConnected);
  const subscribeToEvents = useOpenChamberAgentEventsStore((s) => s.subscribeToEvents);
  const ingestDiscordInbound = useMessengerStore((s) => s.ingestDiscordInbound);

  useEffect(() => {
    if (!running) return;
    const handler = (event: OpenChamberAgentUiRealtimeEvent) => {
      if (event.eventType !== 'messenger.discord.message_received') return;
      const data = event.data as MessengerInboundMessage | undefined;
      if (data && typeof data === 'object' && 'updateId' in data) {
        ingestDiscordInbound(data);
      }
    };
    return subscribeToEvents(handler);
  }, [running, subscribeToEvents, ingestDiscordInbound]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshStatus(), loadRecent()]);
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, refreshStatus, loadRecent]);

  // Reconcile with the live server (settings.json auto-start). Re-run when the
  // hydrated token appears so we don't race Zustand persist.
  useEffect(() => {
    void useMessengerStore.getState().resyncDiscordStatus();
    if (conn.botToken) void loadRecent();
  }, [conn.botToken, loadRecent]);

  const historyTarget = conn.defaultChannelId;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          {t('settings.integrations.discord.listener.title')}
        </div>
        <div className="flex items-center gap-2">
          {!running ? (
            <Button
              type="button"
              variant="default"
              size="xs"
              className="!font-normal normal-case"
              onClick={() => void startListener()}
            >
              <Icon name="play" className="size-3.5" />
              {t('settings.integrations.discord.listener.start')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal normal-case text-[var(--status-error)] hover:text-[var(--status-error)]"
              onClick={() => void stopListener()}
            >
              <Icon name="stop" className="size-3.5" />
              {t('settings.integrations.discord.listener.stop')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] @xl:grid-cols-4">
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">Gateway saw</div>
          <div className="text-foreground font-medium">
            {conn.discordListenerTotalRawMessages ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">Forwarded</div>
          <div className="text-foreground font-medium">
            {conn.discordListenerTotalReceived ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">Replied</div>
          <div className="text-foreground font-medium">
            {conn.discordListenerTotalReplied ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">Last update</div>
          <div className="text-foreground font-medium">
            {formatRelative(conn.discordListenerLastUpdateAt ?? null, t)}
          </div>
        </div>
      </div>

      {/* Hint when the gateway is connected but no messages have arrived yet —
          either the bot has no channel access, or MESSAGE_CONTENT is off. */}
      {connected && (conn.discordListenerTotalRawMessages ?? 0) === 0 && (
        <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground leading-snug">
          Connected. If messages don't arrive, give the bot <em>View Channel</em> access and enable
          the <em>Message Content</em> intent, then restart the listener.
        </div>
      )}

      {conn.discordListenerError && (
        <div className="text-[11px] text-destructive flex items-start gap-1.5 leading-snug">
          <Icon name="alert" className="size-3.5 shrink-0 mt-0.5" />
          {conn.discordListenerError}
        </div>
      )}

      {!running ? (
        <div className="text-[11px] text-muted-foreground leading-snug">
          Start the listener so OpenChamber agent can answer messages sent to the bot.
        </div>
      ) : inbound.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic">
          Waiting for messages… Mention or DM the bot in your server.
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-48 overflow-y-auto">
          {inbound.slice(0, 8).map((m) => (
            <li
              key={String(m.updateId)}
              className="rounded bg-background border border-border px-2 py-1.5 text-[11px] space-y-0.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground truncate">
                  {m.from?.firstName ?? m.from?.username ?? 'Unknown'}
                  {m.from?.username ? (
                    <span className="text-muted-foreground"> @{m.from.username}</span>
                  ) : null}
                </span>
                <span className="text-[9px] text-muted-foreground shrink-0">
                  {new Date(m.receivedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-muted-foreground break-words">
                {m.text ?? <em>(non-text message)</em>}
              </div>
              <div className="text-[9px] text-muted-foreground">
                channel {m.chatId}
                {m.discord?.guildId ? ` · guild ${m.discord.guildId}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* History fetch — last messages from the configured channel. */}
      <div className="border-t border-border/60 pt-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-[11px] font-medium text-foreground">Channel history</div>
          <button
            type="button"
            onClick={() => historyTarget && loadHistory(historyTarget, 50)}
            disabled={!historyTarget}
            className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            Fetch last 50
          </button>
        </div>
        {!historyTarget && (
          <div className="text-[10px] text-muted-foreground">
            Save a default Channel ID to enable history fetch.
          </div>
        )}
        {historyTarget && history.length === 0 && (
          <div className="text-[10px] text-muted-foreground italic">
            No history loaded yet — click "Fetch last 50".
          </div>
        )}
        {history.length > 0 && (
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {history.slice(0, 10).map((m) => (
              <li
                key={m.id}
                className="rounded bg-background border border-border px-2 py-1 text-[10px]"
              >
                <span className="font-medium text-foreground">
                  {m.author.globalName ?? m.author.username ?? m.author.id}
                </span>{' '}
                <span className="text-[9px] text-muted-foreground">
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
                <div className="text-muted-foreground break-words">
                  {m.content || <em>(no text — {m.attachmentCount} attachment{m.attachmentCount === 1 ? '' : 's'})</em>}
                </div>
              </li>
            ))}
            {history.length > 10 && (
              <li className="text-[10px] text-muted-foreground italic px-2">
                + {history.length - 10} older message{history.length - 10 === 1 ? '' : 's'}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function DiscordDiagnosePanel({
  conn,
  diagnosis,
  running,
  runDiagnose,
}: {
  conn: MessengerConnection;
  diagnosis: ReturnType<typeof useMessengerStore.getState>['discordDiagnosis'];
  running: boolean;
  runDiagnose: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const hasIssue = diagnosis?.checks?.some((c) => !c.ok && c.severity !== 'info') ?? false;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <Icon name="pulse" className="size-4 text-primary" />
          Diagnose
          {diagnosis && (
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                hasIssue
                  ? 'bg-[var(--status-warning)]/20 text-[var(--status-warning)]'
                  : 'bg-[var(--status-success)]/20 text-[var(--status-success)]',
              )}
            >
              {hasIssue ? 'issues' : 'all clear'}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="default"
          size="xs"
          className="!font-normal normal-case"
          onClick={() => runDiagnose()}
          disabled={running}
        >
          {running ? (
            <Icon name="loader-4" className="size-3.5 animate-spin" />
          ) : (
            <Icon name="pulse" className="size-3.5" />
          )}
          {running ? 'Running…' : diagnosis ? 'Re-run diagnose' : 'Run diagnose'}
        </Button>
      </div>
      {!diagnosis && (
        <div className="text-[11px] text-muted-foreground leading-snug">
          Diagnose validates token, server access, default channel posting permissions, and
          flags the Message Content intent requirement for the gateway listener.
        </div>
      )}
      {diagnosis && diagnosis.checks.length > 0 && (
        <ul className="space-y-1.5">
          {diagnosis.checks.map((c) => (
            <li key={c.id} className="rounded bg-background border border-border px-2 py-1.5">
              <div className="flex items-start gap-1.5">
                <span className={cn('text-xs leading-none mt-0.5', severityClass(c.severity))}>
                  {c.severity === 'ok' ? '✓' : c.severity === 'warn' ? '⚠' : c.severity === 'error' ? '✗' : 'ⓘ'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={cn('text-[11px] font-medium', severityClass(c.severity))}>
                    {c.title}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-snug mt-0.5 break-words">
                    {c.detail}
                  </div>
                  {c.fix && (
                    <div className="text-[10px] text-foreground leading-snug mt-1">
                      <span className="font-medium">Fix: </span>
                      {c.fix}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {diagnosis && (
        <div className="text-[10px] text-muted-foreground">
          Last run {formatRelative(diagnosis.runAt, t)} for{' '}
          {conn.discordBotUsername ? `bot ${conn.discordBotUsername}` : 'this bot'}.
        </div>
      )}
    </div>
  );
}

function BehaviorPanel({
  type,
  bridgeStatus,
  refreshBridgeStatus,
}: {
  type: MessengerType;
  bridgeStatus: ReturnType<typeof useMessengerStore.getState>['bridgeStatus'];
  refreshBridgeStatus: (t?: MessengerType) => Promise<void>;
}) {
  const { t } = useI18n();
  const bridgeVerbosity = useMessengerStore((s) => s.bridgeVerbosity);
  const setBridgeVerbosity = useMessengerStore((s) => s.setBridgeVerbosity);
  const bridgePermissionMode = useMessengerStore((s) => s.bridgePermissionMode);
  const setBridgePermissionMode = useMessengerStore((s) => s.setBridgePermissionMode);
  const bridgeNotifyOnComplete = useMessengerStore((s) => s.bridgeNotifyOnComplete);
  const setBridgeNotifyOnComplete = useMessengerStore((s) => s.setBridgeNotifyOnComplete);
  const bridgeCritiqueEnabled = useMessengerStore((s) => s.bridgeCritiqueEnabled);
  const setBridgeCritiqueEnabled = useMessengerStore((s) => s.setBridgeCritiqueEnabled);
  const bridgeInterruptTimeoutMs = useMessengerStore((s) => s.bridgeInterruptTimeoutMs);
  const setBridgeInterruptTimeoutMs = useMessengerStore((s) => s.setBridgeInterruptTimeoutMs);
  const syncWorktrees = useMessengerStore(
    (s) => s.connections.find((c) => c.type === 'discord')?.syncWorktrees !== false,
  );
  useEffect(() => {
    refreshBridgeStatus(type);
    const id = setInterval(() => refreshBridgeStatus(type), 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const active = bridgeStatus.active.filter((a) => a.type === type);
  const currentVerbosity: MessengerVerbosity = bridgeVerbosity[type] ?? 'normal';
  const currentVerbosityOption =
    VERBOSITY_OPTIONS.find((o) => o.id === currentVerbosity) ?? VERBOSITY_OPTIONS[0];
  const currentPermissionMode: MessengerPermissionMode = bridgePermissionMode[type] ?? 'agent';
  const currentPermissionOption =
    PERMISSION_MODE_OPTIONS.find((o) => o.id === currentPermissionMode) ??
    PERMISSION_MODE_OPTIONS[0];
  const notifyOnComplete = bridgeNotifyOnComplete[type] ?? false;
  const critiqueEnabled = bridgeCritiqueEnabled[type] ?? false;
  const interruptTimeoutMs =
    bridgeInterruptTimeoutMs[type] ?? MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS;
  const controlsDisabled = !bridgeStatus.enabled;

  return (
    <div className="space-y-4">
      {!bridgeStatus.enabled ? (
        <p className="text-xs text-[var(--status-warning)] leading-snug">
          {t('settings.integrations.discord.bridge.unavailable')}
        </p>
      ) : null}

      {/* Output verbosity — how much of each OpenCode turn is mirrored back. */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">
          {t('settings.integrations.discord.bridge.verbosity.title')}
        </div>
        <DiscordSegmentedControl
          value={currentVerbosity}
          disabled={controlsDisabled}
          ariaLabel={t('settings.integrations.discord.bridge.verbosity.title')}
          onChange={(id) => setBridgeVerbosity(type, id)}
          options={VERBOSITY_OPTIONS.map((opt) => ({
            id: opt.id,
            label: t(opt.labelKey),
          }))}
        />
        <div className="text-xs text-muted-foreground leading-snug">
          {t(currentVerbosityOption.descKey)}
        </div>
      </div>

      {/* Tool permission mode — same defaults as /yolo and /permissions. */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">
          {t('settings.integrations.discord.bridge.permissionMode.title')}
        </div>
        <DiscordSegmentedControl
          value={currentPermissionMode}
          disabled={controlsDisabled}
          ariaLabel={t('settings.integrations.discord.bridge.permissionMode.title')}
          onChange={(id) => setBridgePermissionMode(type, id)}
          options={PERMISSION_MODE_OPTIONS.map((opt) => ({
            id: opt.id,
            label: t(opt.labelKey),
          }))}
        />
        <div className="text-xs text-muted-foreground leading-snug">
          {t(currentPermissionOption.descKey)}
        </div>
      </div>

      <div data-settings-item="integrations.discord.notify-on-complete" className="space-y-1">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={notifyOnComplete}
            onChange={(checked) => setBridgeNotifyOnComplete(type, checked)}
            disabled={controlsDisabled}
            ariaLabel={t('settings.integrations.discord.bridge.notifyOnComplete.title')}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {t('settings.integrations.discord.bridge.notifyOnComplete.title')}
            </span>
            <span className="block text-xs text-muted-foreground leading-snug">
              {t('settings.integrations.discord.bridge.notifyOnComplete.description')}
            </span>
          </span>
        </label>
      </div>

      <div data-settings-item="integrations.discord.critique" className="space-y-1">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={critiqueEnabled}
            onChange={(checked) => setBridgeCritiqueEnabled(type, checked)}
            disabled={controlsDisabled}
            ariaLabel={t('settings.integrations.discord.bridge.critique.title')}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {t('settings.integrations.discord.bridge.critique.title')}
            </span>
            <span className="block text-xs text-muted-foreground leading-snug">
              {t('settings.integrations.discord.bridge.critique.description')}
            </span>
          </span>
        </label>
      </div>

      <div data-settings-item="integrations.discord.sync-worktrees" className="space-y-1">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={syncWorktrees}
            onChange={(checked) => {
              useMessengerStore.getState().updateConnection('discord', { syncWorktrees: checked });
              setTimeout(() => useMessengerStore.getState().saveDiscordConfig(), 0);
            }}
            ariaLabel={t('settings.integrations.discord.bridge.syncWorktrees.title')}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {t('settings.integrations.discord.bridge.syncWorktrees.title')}
            </span>
            <span className="block text-xs text-muted-foreground leading-snug">
              {t('settings.integrations.discord.bridge.syncWorktrees.description')}
            </span>
          </span>
        </label>
      </div>

      <div
        data-settings-item="integrations.discord.interrupt-timeout"
        className="space-y-2"
      >
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="discord-interrupt-timeout-ms"
        >
          {t('settings.integrations.discord.bridge.interruptTimeout.title')}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="discord-interrupt-timeout-ms"
            type="number"
            min={MESSENGER_INTERRUPT_TIMEOUT_MIN_MS}
            max={MESSENGER_INTERRUPT_TIMEOUT_MAX_MS}
            step={500}
            disabled={controlsDisabled}
            value={interruptTimeoutMs}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                setBridgeInterruptTimeoutMs(type, next);
              }
            }}
            className="h-8 w-28 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <span className="text-xs text-muted-foreground">
            {t('settings.integrations.discord.bridge.interruptTimeout.unit')}
          </span>
        </div>
        <div className="text-xs text-muted-foreground leading-snug">
          {t('settings.integrations.discord.bridge.interruptTimeout.description')}
        </div>
      </div>

      {active.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="text-primary">▶</span>{' '}
          {active.length === 1
            ? t('settings.integrations.discord.bridge.activeOne')
            : t('settings.integrations.discord.bridge.activeMany', { count: active.length })}
        </div>
      )}

      <div
        data-settings-item="integrations.discord.proxy-worktrees"
        className="space-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground leading-snug"
      >
        <div>{t('settings.integrations.discord.bridge.proxyNote')}</div>
        <div>{t('settings.integrations.discord.bridge.autoWorktreeNote')}</div>
      </div>
    </div>
  );
}

function SessionBindingsPanel({
  type,
  bridgeStatus,
}: {
  type: MessengerType;
  bridgeStatus: ReturnType<typeof useMessengerStore.getState>['bridgeStatus'];
}) {
  const { t } = useI18n();
  const bindings = bridgeStatus.bindings.filter((b) => b.type === type);
  if (bindings.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        {t('settings.integrations.discord.advanced.sessionBindings.empty')}
      </div>
    );
  }
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto">
      {bindings.map((b) => (
        <li
          key={`${b.type}:${b.targetKey}:${b.sessionId}`}
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground"
        >
          <code className="rounded bg-muted px-1 text-foreground">{b.targetKey}</code>
          {' → '}
          <code className="rounded bg-muted px-1 text-foreground">
            {b.sessionId.slice(0, 16)}…
          </code>
          {b.projectLabel ? ` · ${b.projectLabel}` : ''}
        </li>
      ))}
    </ul>
  );
}

function DiscordSyncResults({
  channels,
}: {
  channels: NonNullable<MessengerConnection['lastSyncChannels']>;
}) {
  // Group per-project rows by the server they were synced to (multi-server).
  const groups = new Map<string, { name: string | null; rows: typeof channels }>();
  for (const c of channels) {
    const key = c.guildId ?? '';
    const group = groups.get(key);
    if (group) {
      group.rows.push(c);
    } else {
      groups.set(key, { name: c.guildName ?? null, rows: [c] });
    }
  }
  return (
    <div className="space-y-2">
      {Array.from(groups.entries()).map(([groupKey, group]) => (
        <div key={groupKey || 'default'} className="space-y-1">
          {group.name && (
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.name}
            </div>
          )}
          <ul className="space-y-1">
            {group.rows.map((c) => {
              const channelOk = !c.error && Boolean(c.messageId);
              const threadAsked = c.threadRequested !== false;
              // Status icon priority: channel-failed > thread-failed-but-channel-ok > all-ok > nothing-done
              const iconState = c.error
                ? 'channel-error'
                : threadAsked && c.threadError
                  ? 'thread-error'
                  : c.created
                    ? 'new'
                    : channelOk
                      ? 'reused'
                      : 'idle';
              return (
                <li
                  key={`${c.guildId ?? ''}:${c.projectId}`}
                  className="rounded-lg bg-background border border-border px-2 py-1.5 text-[11px] flex items-start gap-2"
                >
                  <span
                    className={cn(
                      'mt-0.5',
                      iconState === 'channel-error' && 'text-destructive',
                      iconState === 'thread-error' && 'text-[var(--status-warning)]',
                      iconState === 'new' && 'text-[var(--status-success)]',
                      (iconState === 'reused' || iconState === 'idle') && 'text-muted-foreground',
                    )}
                  >
                    {iconState === 'channel-error'
                      ? '✗'
                      : iconState === 'thread-error'
                        ? '⚠'
                        : iconState === 'new'
                          ? '✓ new'
                          : '·'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {c.projectLabel}{' '}
                      <span className="text-muted-foreground font-normal">
                        → {c.channelName ? `#${c.channelName}` : '(no channel)'}
                        {c.threadId ? ` › ${c.threadName ?? 'thread'}` : ''}
                      </span>
                    </div>
                    {channelOk && (
                      <div className="text-[10px] text-muted-foreground">
                        message {c.messageId} sent
                        {c.threadCreated
                          ? ' · thread opened'
                          : threadAsked
                            ? ' · thread NOT opened'
                            : ''}
                      </div>
                    )}
                    {c.error && <div className="text-destructive leading-snug">{c.error}</div>}
                    {!c.error && c.threadError && (
                      <div className="text-[var(--status-warning)] leading-snug">
                        Thread skipped — {c.threadError}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function DiscordAdvancedSettings({
  conn,
  open,
  onOpenChange,
  hideTrigger = false,
}: {
  conn: MessengerConnection;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When true, the parent owns the open control (e.g. connected-state button). */
  hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { t } = useI18n();

  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const saveDiscordConfig = useMessengerStore((s) => s.saveDiscordConfig);
  const resolveDiscordChannel = useMessengerStore((s) => s.resolveDiscordChannel);
  const diagnoseDiscord = useMessengerStore((s) => s.diagnoseDiscord);
  const discordDiagnosis = useMessengerStore((s) => s.discordDiagnosis);
  const discordDiagnosisRunning = useMessengerStore((s) => s.discordDiagnosisRunning);
  const refreshBridgeStatus = useMessengerStore((s) => s.refreshBridgeStatus);
  const bridgeStatus = useMessengerStore((s) => s.bridgeStatus);
  const startDiscordListener = useMessengerStore((s) => s.startDiscordListener);
  const stopDiscordListener = useMessengerStore((s) => s.stopDiscordListener);
  const refreshDiscordListenerStatus = useMessengerStore((s) => s.refreshDiscordListenerStatus);
  const loadRecentDiscordMessages = useMessengerStore((s) => s.loadRecentDiscordMessages);
  const discordInbound = useMessengerStore((s) => s.discordInbound);
  const discordHistory = useMessengerStore((s) => s.discordHistory);
  const loadDiscordHistory = useMessengerStore((s) => s.loadDiscordHistory);

  useEffect(() => {
    if (!isOpen) return;
    void refreshBridgeStatus(conn.type);
    const id = setInterval(() => void refreshBridgeStatus(conn.type), 8000);
    return () => clearInterval(id);
  }, [isOpen, conn.type, refreshBridgeStatus]);

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  const meta = MESSENGER_META[conn.type];
  const target = conn.defaultChannelId;
  const hasTarget = Boolean(target);

  const [targetInput, setTargetInput] = useState('');
  const [sectionOpen, setSectionOpen] = useState({
    behavior: true,
    diagnostics: false,
    syncLog: false,
    bindings: false,
  });
  const [dangerOpen, setDangerOpen] = useState<DangerZoneKey | null>(null);

  const handleSaveTarget = async () => {
    const value = targetInput.trim();
    if (!value) return;
    updateConnection('discord', { defaultChannelId: value });
    // Persist to server-side settings.json so auto-start works on reboot
    setTimeout(() => saveDiscordConfig(), 0);
    setTimeout(() => {
      resolveDiscordChannel();
    }, 0);
    setTargetInput('');
  };

  const toggleDanger = (key: DangerZoneKey) => {
    setDangerOpen((prev) => (prev === key ? null : key));
  };

  const listenerConnected = Boolean(conn.discordListenerConnected);
  const listenerRunning = Boolean(conn.discordListenerRunning);
  const seen = conn.discordListenerTotalRawMessages ?? 0;
  const forwarded = conn.discordListenerTotalReceived ?? 0;
  const replied = conn.discordListenerTotalReplied ?? 0;
  const syncChannels = conn.lastSyncChannels ?? [];
  const syncFailed = syncChannels.filter((c) => Boolean(c.error) || Boolean(c.threadError)).length;
  const bindingsCount = bridgeStatus.bindings.filter((b) => b.type === conn.type).length;

  const listenerBadge = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
        listenerConnected
          ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
          : listenerRunning
            ? 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]'
            : 'bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          listenerConnected
            ? 'bg-[var(--status-success)]'
            : listenerRunning
              ? 'bg-[var(--status-warning)]'
              : 'bg-muted-foreground',
        )}
      />
      {listenerConnected
        ? t('settings.integrations.discord.listener.status.live')
        : listenerRunning
          ? t('settings.integrations.discord.listener.status.connecting')
          : t('settings.integrations.discord.listener.status.off')}
    </span>
  );

  const fallbackFields = (
    <div data-settings-item="integrations.discord.fallback-channel" className="space-y-2">
      <div className="text-xs text-muted-foreground leading-snug">
        {t('settings.integrations.discord.advanced.fallbackChannel.description')}
      </div>
      {!hasTarget ? (
        <>
          <div className="text-xs text-muted-foreground leading-snug">{meta.targetHelp}</div>
          <div className="flex gap-2">
            <input
              type="text"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              placeholder={meta.targetPlaceholder}
              className={inputClass}
            />
            <Button
              type="button"
              variant="default"
              size="xs"
              className="!font-normal normal-case shrink-0"
              onClick={handleSaveTarget}
              disabled={!targetInput.trim()}
            >
              {t('settings.integrations.discord.actions.saveToken')}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">{target}</code>
          {hasTarget ? <Icon name="check" className="size-3 text-[var(--status-success)]" /> : null}
          {conn.discordChannelName && (
            <span className="text-muted-foreground">
              #{conn.discordChannelName}
              {conn.guildName ? ` · ${conn.guildName}` : ''}
              {conn.discordChannelTypeLabel ? ` · ${conn.discordChannelTypeLabel}` : ''}
            </span>
          )}
          {conn.botToken && conn.defaultChannelId && !conn.discordChannelName && (
            <button
              type="button"
              onClick={() => resolveDiscordChannel()}
              className="text-primary text-[10px] hover:underline"
            >
              {t('settings.integrations.discord.advanced.fallbackChannel.lookUp')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              updateConnection('discord', {
                defaultChannelId: undefined,
                discordChannelName: undefined,
                discordChannelType: undefined,
                discordChannelTypeLabel: undefined,
              });
              setTimeout(() => saveDiscordConfig(), 0);
            }}
            className="text-primary text-[10px] hover:underline"
          >
            {t('settings.integrations.discord.advanced.primarySyncGuild.change')}
          </button>
        </div>
      )}
    </div>
  );

  const content = (
    <div className="space-y-4">
      <div className="space-y-1 px-0.5">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">
          {t('settings.integrations.discord.actions.advancedSettings')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('settings.integrations.discord.advanced.description')}
        </p>
      </div>

      <div className="space-y-3">
        <AdvancedSectionCard
          icon="settings-3"
          title={t('settings.integrations.discord.advanced.behavior.title')}
          open={sectionOpen.behavior}
          onOpenChange={(next) => setSectionOpen((s) => ({ ...s, behavior: next }))}
        >
          <BehaviorPanel
            type={conn.type}
            bridgeStatus={bridgeStatus}
            refreshBridgeStatus={refreshBridgeStatus}
          />
        </AdvancedSectionCard>

        <AdvancedSectionCard
          icon="pulse"
          title={t('settings.integrations.discord.advanced.diagnostics.title')}
          badge={listenerBadge}
          meta={t('settings.integrations.discord.advanced.diagnostics.stats', {
            seen,
            forwarded,
            replied,
          })}
          open={sectionOpen.diagnostics}
          onOpenChange={(next) => setSectionOpen((s) => ({ ...s, diagnostics: next }))}
        >
          <div className="space-y-4">
            <DiscordListenerPanel
              conn={conn}
              inbound={discordInbound}
              history={discordHistory}
              startListener={startDiscordListener}
              stopListener={stopDiscordListener}
              refreshStatus={refreshDiscordListenerStatus}
              loadRecent={loadRecentDiscordMessages}
              loadHistory={loadDiscordHistory}
            />
            <div className="border-t border-border/60 pt-3">
              <DiscordDiagnosePanel
                conn={conn}
                diagnosis={discordDiagnosis}
                running={discordDiagnosisRunning}
                runDiagnose={diagnoseDiscord}
              />
            </div>
          </div>
        </AdvancedSectionCard>

        <AdvancedSectionCard
          icon="refresh"
          title={t('settings.integrations.discord.advanced.syncLog.title')}
          badge={
            syncFailed > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--status-warning)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--status-warning)]">
                <span className="size-1.5 rounded-full bg-[var(--status-warning)]" />
                {t('settings.integrations.discord.advanced.syncLog.failed', { count: syncFailed })}
              </span>
            ) : undefined
          }
          meta={
            conn.lastSyncAt
              ? t('settings.integrations.discord.advanced.syncLog.lastSynced', {
                  when: formatRelative(conn.lastSyncAt, t),
                })
              : t('settings.integrations.discord.advanced.syncLog.never')
          }
          open={sectionOpen.syncLog}
          onOpenChange={(next) => setSectionOpen((s) => ({ ...s, syncLog: next }))}
        >
          {syncChannels.length > 0 ? (
            <DiscordSyncResults channels={syncChannels} />
          ) : (
            <div className="text-xs text-muted-foreground">
              {t('settings.integrations.discord.advanced.syncLog.empty')}
            </div>
          )}
        </AdvancedSectionCard>

        <AdvancedSectionCard
          icon="apps"
          title={t('settings.integrations.discord.advanced.sessionBindings.title')}
          meta={
            bindingsCount === 1
              ? t('settings.integrations.discord.advanced.sessionBindings.countOne')
              : t('settings.integrations.discord.advanced.sessionBindings.count', {
                  count: bindingsCount,
                })
          }
          open={sectionOpen.bindings}
          onOpenChange={(next) => setSectionOpen((s) => ({ ...s, bindings: next }))}
        >
          <SessionBindingsPanel type={conn.type} bridgeStatus={bridgeStatus} />
        </AdvancedSectionCard>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--status-error)]/30 bg-[color-mix(in_srgb,var(--status-error)_6%,var(--background))]">
        <div className="flex items-center gap-2 px-4 py-3">
          <Icon name="alert" className="size-4 text-[var(--status-error)]" />
          <span className="text-sm font-semibold text-[var(--status-error)]">
            {t('settings.integrations.discord.advanced.dangerZone.title')}
          </span>
        </div>
        <div className="divide-y divide-border/60 border-t border-[var(--status-error)]/20">
          <DangerZoneRow
            label={t('settings.integrations.discord.advanced.dangerZone.fallbackChannel')}
            open={dangerOpen === 'fallback'}
            onToggle={() => toggleDanger('fallback')}
          >
            {fallbackFields}
          </DangerZoneRow>
          <DangerZoneRow
            label={t('settings.integrations.discord.advanced.dangerZone.ownerUserId')}
            open={dangerOpen === 'owner'}
            onToggle={() => toggleDanger('owner')}
          >
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground leading-snug">
                {t('settings.integrations.discord.advanced.ownerUserId.description')}
              </div>
              <input
                type="text"
                value={conn.defaultUserId ?? ''}
                onChange={(e) => updateConnection('discord', { defaultUserId: e.target.value.trim() })}
                onBlur={() => setTimeout(() => saveDiscordConfig(), 0)}
                placeholder="e.g. 123456789012345678"
                className={inputClass}
              />
            </div>
          </DangerZoneRow>
          <DangerZoneRow
            label={t('settings.integrations.discord.advanced.dangerZone.trustedBots')}
            open={dangerOpen === 'trusted'}
            onToggle={() => toggleDanger('trusted')}
          >
            <div data-settings-item="integrations.discord.trusted-bots" className="space-y-2">
              <div className="text-xs text-muted-foreground leading-snug">
                {t('settings.integrations.discord.trustedBots.description')}
              </div>
              <textarea
                value={(conn.trustedBotIds ?? []).join('\n')}
                onChange={(e) => {
                  const trustedBotIds = e.target.value
                    .split(/[\s,]+/)
                    .map((id) => id.trim())
                    .filter(Boolean);
                  updateConnection('discord', { trustedBotIds });
                }}
                onBlur={() => setTimeout(() => saveDiscordConfig(), 0)}
                placeholder={t('settings.integrations.discord.trustedBots.placeholder')}
                className={cn(inputClass, 'min-h-16 resize-y')}
              />
            </div>
          </DangerZoneRow>
          <DangerZoneRow
            label={t('settings.integrations.discord.advanced.dangerZone.registerSlash')}
            open={dangerOpen === 'slash'}
            onToggle={() => toggleDanger('slash')}
          >
            <div data-settings-item="integrations.discord.dynamic-slash" className="space-y-1.5">
              <label className="flex cursor-pointer items-start gap-2 py-1">
                <Checkbox
                  checked={Boolean(conn.registerDynamicSlashCommands)}
                  onChange={(checked) => {
                    updateConnection('discord', { registerDynamicSlashCommands: Boolean(checked) });
                    setTimeout(() => saveDiscordConfig(), 0);
                  }}
                  ariaLabel={t('settings.integrations.discord.dynamicSlash.title')}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {t('settings.integrations.discord.dynamicSlash.title')}
                  </span>
                  <span className="block text-xs text-muted-foreground leading-snug">
                    {t('settings.integrations.discord.dynamicSlash.description')}
                  </span>
                </span>
              </label>
            </div>
          </DangerZoneRow>
        </div>
      </div>
    </div>
  );

  if (hideTrigger) {
    return isOpen ? content : null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setOpen} className="border-t border-border/60 pt-3">
      <label className="flex cursor-pointer select-none items-center gap-2">
        <Checkbox
          checked={isOpen}
          onChange={setOpen}
          ariaLabel={t('settings.integrations.discord.actions.advancedSettings')}
        />
        <span className="text-xs font-medium text-foreground">
          {t('settings.integrations.discord.actions.advancedSettings')}
        </span>
        <span className="text-[10px] font-normal text-muted-foreground">
          {t('settings.integrations.discord.actions.advancedSettingsHint')}
        </span>
      </label>
      <CollapsibleContent className="pt-3">{content}</CollapsibleContent>
    </Collapsible>
  );
}

type DiscordReplyMode = 'always' | 'mention' | 'inherit';

/** Visible per-server reply modes — always / mention only (no inherit UI). */
const DISCORD_SERVER_REPLY_MODES = ['always', 'mention'] as const;

function discordReplyModeLabelKey(mode: 'always' | 'mention'): I18nKey {
  if (mode === 'mention') return 'settings.integrations.discord.servers.replyMode.mention';
  return 'settings.integrations.discord.servers.replyMode.always';
}

/**
 * One server the bot is in. This is the central per-server control: whether the
 * bot responds here (which also governs listening + OpenCode sync for this
 * server), how it replies, and whether it mirrors projects into this server.
 */
type DiscordSyncProject = { id: string; path: string; label?: string };

/**
 * Per-project Discord sync payloads (the message body posted into each
 * project's channel). Shared by the card-level "Sync projects now" and the
 * per-server "Sync now" action so both produce identical content.
 */
function buildProjectSyncPayloads(
  projects: DiscordSyncProject[],
): { id: string; path: string; label: string; body: string }[] {
  const now = new Date().toLocaleString();
  return projects.map((p) => {
    const label = p.label || p.path.split('/').pop() || p.path;
    const lines = [`🤖 OpenChamber agent sync — ${label}`, '', `Last synced ${now}`];
    return { id: p.id, path: p.path, label, body: lines.join('\n') };
  });
}

/** Top-level Discord sync summary message. */
function buildProjectSyncSummary(projects: DiscordSyncProject[]): string {
  const lines = [
    '**🤖 OpenChamber agent sync summary**',
    '',
    `• Projects: ${projects.length}`,
    '',
    `_Sent ${new Date().toLocaleString()}_`,
  ];
  return lines.join('\n');
}

function DiscordServerRow({
  conn,
  guild,
}: {
  conn: MessengerConnection;
  guild: DiscordGuildListItem;
}) {
  const { t } = useI18n();
  const setDiscordGuildPolicy = useMessengerStore((s) => s.setDiscordGuildPolicy);
  const resolveDiscordGuild = useMessengerStore((s) => s.resolveDiscordGuild);
  const sendTestMessage = useMessengerStore((s) => s.sendTestMessage);
  const syncDiscordGuildProjects = useMessengerStore((s) => s.syncDiscordGuildProjects);
  const projects = useProjectsStore((s) => s.projects);
  const [rowAction, setRowAction] = useState<null | 'test' | 'sync'>(null);
  // Panel opens only from the ⋮ control — never from the row itself; default closed.
  const [expanded, setExpanded] = useState(false);

  const policy = conn.discordGuildPolicies?.[guild.id];
  const respond = policy?.enabled !== false;
  const storedReplyMode: DiscordReplyMode = policy?.replyMode ?? 'inherit';
  // Legacy `inherit` maps to the saved default (or always) for the two-mode UI.
  const replyMode: 'always' | 'mention' =
    storedReplyMode === 'mention' || storedReplyMode === 'always'
      ? storedReplyMode
      : conn.discordDefaultReplyMode === 'mention'
        ? 'mention'
        : 'always';
  const syncing = isDiscordGuildSyncing(conn, guild.id);
  const resolved = conn.discordGuildResolved?.[guild.id];
  const categories = resolved?.categories ?? [];
  const isLegacyPrimary = guild.id === conn.discordGuildId;
  const parentCategoryId =
    policy?.parentCategoryId ?? (isLegacyPrimary ? conn.discordParentCategoryId : undefined) ?? '';
  const createThreads =
    policy?.createThreads ?? (isLegacyPrimary ? conn.discordCreateThreads !== false : true);

  // A live server gateway can report "connected" while this browser holds no
  // token; the server falls back to the saved token, so gate the per-server
  // actions on configured state, not the local token alone.
  const configured = Boolean(conn.botToken || conn.discordServerConfigured);
  const busy = conn.lastSyncStatus === 'sending';

  // Fetch the server's channel/category topology once the panel is open.
  useEffect(() => {
    if (expanded && !resolved && configured) {
      void resolveDiscordGuild(guild.id);
    }
  }, [expanded, resolved, configured, guild.id, resolveDiscordGuild]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <DiscordGuildIcon guild={guild} />
          <span className="min-w-0 break-words text-sm font-semibold leading-snug text-foreground">
            {guild.name}
          </span>
        </div>

        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <Switch
            checked={respond}
            onCheckedChange={(checked) => setDiscordGuildPolicy(guild.id, { enabled: checked })}
            aria-label={t('settings.integrations.discord.servers.enabled.label')}
            className="data-[checked]:bg-[var(--status-success)]"
          />
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {t('settings.integrations.discord.servers.enabled.label')}
          </span>
        </label>

        {respond && (
          <div
            className="inline-flex shrink-0 items-stretch overflow-hidden rounded-md border border-[var(--interactive-border)]"
            role="group"
            aria-label={t('settings.integrations.discord.servers.replyMode.always')}
          >
            {DISCORD_SERVER_REPLY_MODES.map((mode, index) => {
              const selected = replyMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDiscordGuildPolicy(guild.id, { replyMode: mode })}
                  className={cn(
                    'px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap transition-colors',
                    index === 0 && 'border-r border-[var(--interactive-border)]',
                    selected
                      ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                      : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                  )}
                >
                  {t(discordReplyModeLabelKey(mode))}
                </button>
              );
            })}
          </div>
        )}

        <Button
          type="button"
          variant={expanded ? 'secondary' : 'ghost'}
          size="icon"
          className="size-8 shrink-0"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t('settings.integrations.discord.servers.collapseSettings')
              : t('settings.integrations.discord.servers.expandSettings')
          }
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon name="more-2" className="size-4" />
        </Button>
      </div>

      {expanded && (
        <div className="relative ml-4 space-y-3 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-3">
          <button
            type="button"
            className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={() => setExpanded(false)}
            aria-label={t('settings.integrations.discord.servers.collapseSettings')}
          >
            <Icon name="arrow-up-s" className="size-4" />
          </button>

          <div className="flex flex-wrap items-start gap-3 pr-8">
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={syncing}
                onChange={(checked) => setDiscordGuildPolicy(guild.id, { syncProjects: checked })}
                ariaLabel={t('settings.integrations.discord.servers.syncProjects.label')}
              />
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-foreground">
                  {t('settings.integrations.discord.servers.syncProjects.label')}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {t('settings.integrations.discord.servers.syncProjects.hint')}
                </span>
              </span>
            </label>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                disabled={!configured || busy}
                onClick={() => {
                  setRowAction('sync');
                  void syncDiscordGuildProjects(
                    buildProjectSyncPayloads(projects),
                    buildProjectSyncSummary(projects),
                    { guildIds: [guild.id] },
                  ).finally(() => setRowAction(null));
                }}
              >
                {rowAction === 'sync' ? (
                  <Icon name="loader-4" className="size-3.5 animate-spin" />
                ) : (
                  <Icon name="refresh" className="size-3.5" />
                )}
                {t('settings.integrations.discord.servers.syncNow')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                disabled={!configured || busy}
                onClick={() => {
                  setRowAction('test');
                  void sendTestMessage('discord', { guildId: guild.id }).finally(() =>
                    setRowAction(null),
                  );
                }}
              >
                {rowAction === 'test' ? (
                  <Icon name="loader-4" className="size-3.5 animate-spin" />
                ) : (
                  <Icon name="send-plane" className="size-3.5" />
                )}
                {t('settings.integrations.discord.servers.sendTest')}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor={`sync-cat-${guild.id}`} className="text-muted-foreground">
              {t('settings.integrations.discord.servers.syncProjects.category')}
            </label>
            <select
              id={`sync-cat-${guild.id}`}
              value={parentCategoryId}
              disabled={!syncing}
              onChange={(e) =>
                setDiscordGuildPolicy(guild.id, {
                  parentCategoryId: e.target.value || undefined,
                })
              }
              className="h-8 min-w-[12rem] rounded-md border border-[var(--interactive-border)] bg-background px-2 text-xs text-foreground disabled:opacity-50"
            >
              <option value="">
                {t('settings.integrations.discord.servers.syncProjects.categoryRoot')}
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void resolveDiscordGuild(guild.id)}
              disabled={!configured}
              className="text-xs font-medium text-[var(--primary-base)] hover:underline disabled:opacity-50"
            >
              {t('settings.integrations.discord.advanced.primarySyncGuild.rescan')}
            </button>
          </div>

          <label
            className={cn(
              'flex cursor-pointer items-center gap-2.5 text-xs',
              !syncing && 'opacity-50',
            )}
          >
            <Checkbox
              checked={createThreads}
              disabled={!syncing}
              onChange={(checked) => setDiscordGuildPolicy(guild.id, { createThreads: checked })}
              ariaLabel={t('settings.integrations.discord.servers.syncProjects.threads')}
            />
            <span className="text-muted-foreground">
              {t('settings.integrations.discord.servers.syncProjects.threads')}
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function DiscordServersAndInviteBlock({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const fetchDiscordInviteUrl = useMessengerStore((s) => s.fetchDiscordInviteUrl);
  const refreshDiscordGuilds = useMessengerStore((s) => s.refreshDiscordGuilds);
  const refreshing = useMessengerStore((s) => s.discordGuildsRefreshing);
  const guildsError = useMessengerStore((s) => s.discordGuildsError);

  const guildCount = conn.discordGuilds?.length ?? 0;
  const hasGuilds = guildCount > 0;

  // Poll while empty so joining a server updates the list automatically.
  useDiscordGuildMembershipPoll(!hasGuilds && Boolean(conn.botToken));

  const openInvite = async () => {
    if (conn.discordInviteUrl) {
      window.open(conn.discordInviteUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const url = await fetchDiscordInviteUrl();
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div data-settings-item="integrations.discord.servers" className="space-y-3">
      <div>
        <div className="text-base font-semibold text-foreground">
          {t('settings.integrations.discord.servers.title')}
        </div>
        <p className="mt-1 text-xs text-muted-foreground leading-snug">
          {t('settings.integrations.discord.servers.description')}
        </p>
      </div>

      {!hasGuilds && (
        <div className="space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-muted)]/40 px-3 py-2.5">
          <p className="text-xs text-muted-foreground leading-snug">
            {t('settings.integrations.discord.servers.empty')}
          </p>
          {refreshing && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Icon name="loader-4" className="size-3 animate-spin" />
              {t('settings.integrations.discord.servers.refreshing')}
            </p>
          )}
          {guildsError && (
            <p className="text-xs text-[var(--status-error)] leading-snug">{guildsError}</p>
          )}
          <p className="text-[11px] text-muted-foreground leading-snug">
            {t('settings.integrations.discord.servers.inviteHint')}
          </p>
        </div>
      )}

      {hasGuilds && guildsError && (
        <p className="text-xs text-[var(--status-error)] leading-snug">{guildsError}</p>
      )}

      {hasGuilds && (
        <div className="space-y-2">
          {(conn.discordGuilds ?? []).map((g) => (
            <DiscordServerRow key={g.id} conn={conn} guild={g} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="!font-normal"
          onClick={() => void openInvite()}
        >
          <Icon name="add" className="size-3.5" />
          {t('settings.integrations.discord.servers.inviteButton')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="!font-normal text-muted-foreground"
          disabled={refreshing || (!conn.botToken && !conn.discordServerConfigured)}
          onClick={() => void refreshDiscordGuilds()}
        >
          {refreshing ? (
            <Icon name="loader-4" className="size-3.5 animate-spin" />
          ) : (
            <Icon name="refresh" className="size-3.5" />
          )}
          {refreshing
            ? t('settings.integrations.discord.servers.refreshing')
            : t('settings.integrations.discord.servers.refresh')}
        </Button>
      </div>
    </div>
  );
}

function ConnectionCard({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const onboardingStep = useMessengerStore((s) => s.onboardingStep);
  const onboardingType = useMessengerStore((s) => s.onboardingType);

  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const testConnection = useMessengerStore((s) => s.testConnection);
  const disconnectDiscord = useMessengerStore((s) => s.disconnectDiscord);
  const saveDiscordConfig = useMessengerStore((s) => s.saveDiscordConfig);
  const [disconnecting, setDisconnecting] = useState(false);

  const advancedSectionRef = useRef<HTMLDivElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

  const scrollToSection = (section: 'token' | 'guild' | 'channel' | 'test' | 'advanced') => {
    // The per-server sync/channel/test controls now live under Advanced and on
    // the server rows, so the wizard's legacy targets resolve to the advanced
    // panel. Token change also lives inside Advanced.
    const resolved =
      section === 'guild' || section === 'channel' || section === 'test' || section === 'token'
        ? 'advanced'
        : section;
    if (resolved === 'advanced') {
      setAdvancedOpen(true);
      if (section === 'token') {
        setShowToken(true);
      }
    }
    window.requestAnimationFrame(() => {
      advancedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const meta = MESSENGER_META[conn.type];
  const displayStatus = deriveDiscordDisplayStatus(conn);

  const token = conn.botToken;

  const hasToken = Boolean(token);
  /** True when the bot is configured (local token OR server-side config). */
  const configured = hasToken || Boolean(conn.discordServerConfigured);
  // Persistent view: the wizard owns token entry during onboarding; once a
  // token exists the configured view is stable across reloads — the badge
  // carries the transient live status (connecting/connected/error).
  // Also considers server-configured so a bot that is live on the server but
  // whose token was lost from the local store still shows the configured view.
  const showWizard =
    deriveDiscordViewState({
      hasToken,
      serverConfigured: Boolean(conn.discordServerConfigured),
      wizardActive: onboardingStep !== null && onboardingType === 'discord',
    }) !== 'configured';

  // Reconcile badge + listener with the live server when this card opens.
  // Depends on botToken so we still run after Zustand persist hydration.
  useEffect(() => {
    void useMessengerStore.getState().resyncDiscordStatus();
  }, [conn.botToken]);

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return;
    updateConnection('discord', { botToken: tokenInput.trim(), enabled: true });
    // Persist to server-side settings.json so auto-start works on reboot
    setTimeout(() => saveDiscordConfig(), 0);
    // Re-verify so a bad replacement token flips the badge to error instead
    // of coasting on the previous token's connected status.
    setTimeout(() => void testConnection('discord'), 0);
    setTokenInput('');
    setShowToken(false);
  };

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  return (
    <div className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-5 shadow-sm space-y-5">
      {/* Header — Discord mark + status; Advanced then Disconnect (one row). */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <Icon name="discord-fill" className={cn('size-5 shrink-0', meta.color)} />
          <span className="shrink-0 text-sm font-semibold text-foreground">{meta.name}</span>
          <StatusBadge status={displayStatus} />
          {conn.discordBotUsername && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {conn.discordBotUsername}
              {conn.discordBotDiscriminator && conn.discordBotDiscriminator !== '0'
                ? `#${conn.discordBotDiscriminator}`
                : ''}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!showWizard && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal whitespace-nowrap"
              onClick={() => {
                setAdvancedOpen((open) => !open);
                if (!advancedOpen) {
                  window.requestAnimationFrame(() => {
                    advancedSectionRef.current?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'nearest',
                    });
                  });
                }
              }}
            >
              <Icon name="settings-3" className="size-3.5" />
              {t('settings.integrations.discord.actions.advancedSettings')}
            </Button>
          )}
          {configured && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal whitespace-nowrap text-[var(--status-error)] hover:text-[var(--status-error)] border-[var(--status-error)]/40"
              onClick={() => setDisconnectConfirmOpen(true)}
            >
              {t('settings.integrations.discord.disconnect.button')}
            </Button>
          )}
        </div>
      </div>

      {/* Connection error */}
      {conn.error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start gap-2">
          <RiAlertLine className="size-3.5 shrink-0 mt-0.5" />
          <span>{conn.error}</span>
        </div>
      )}

      {/* The wizard is the only token-entry UI. With a token saved, the
          configured view is stable regardless of transient live status. */}
      {showWizard ? (
        <DiscordOnboardingWizard conn={conn} onScrollToSection={scrollToSection} />
      ) : (
        <>
          <DiscordServersAndInviteBlock conn={conn} />

          {/* Advanced settings — opened from the header control. */}
          <div ref={advancedSectionRef}>
            {advancedOpen && (
              <div className="space-y-4 border-t border-[var(--interactive-border)] pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div data-settings-item="integrations.discord.commands">
                    <DiscordCommandsButton />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    onClick={() => setShowToken((v) => !v)}
                  >
                    {showToken
                      ? t('settings.common.actions.cancel')
                      : t('settings.integrations.discord.actions.changeToken')}
                  </Button>
                  {displayStatus !== 'connected' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="!font-normal"
                      onClick={() => testConnection(conn.type)}
                      disabled={!configured || conn.status === 'connecting'}
                    >
                      {conn.status === 'connecting'
                        ? t('settings.integrations.discord.wizard.step1.verifying')
                        : t('settings.integrations.discord.wizard.step1.verify')}
                    </Button>
                  )}
                </div>

                {showToken && (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <input
                      type="password"
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder={t('settings.integrations.discord.wizard.step1.tokenLabel')}
                      className={cn(inputClass, 'min-w-[12rem] flex-1')}
                    />
                    <Button
                      type="button"
                      variant="default"
                      size="xs"
                      className="!font-normal shrink-0"
                      onClick={handleSaveToken}
                      disabled={!tokenInput.trim()}
                    >
                      {t('settings.integrations.discord.actions.updateToken')}
                    </Button>
                  </div>
                )}

                <DiscordAdvancedSettings
                  conn={conn}
                  open={advancedOpen}
                  onOpenChange={setAdvancedOpen}
                  hideTrigger
                />
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={disconnectConfirmOpen} onOpenChange={setDisconnectConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.integrations.discord.disconnect.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.integrations.discord.disconnect.dialog.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDisconnectConfirmOpen(false)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={disconnecting}
              onClick={() => {
                setDisconnecting(true);
                void disconnectDiscord().finally(() => {
                  setDisconnecting(false);
                  setDisconnectConfirmOpen(false);
                });
              }}
            >
              {t('settings.integrations.discord.disconnect.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Square "Connect Discord" tile — the only surface shown while nothing is
 * connected (no bot token). Starts the onboarding wizard on click.
 */
function DiscordConnectCard({ onConnect }: { onConnect: () => void }) {
  const { t } = useI18n();
  const meta = MESSENGER_META.discord;
  return (
    <button
      type="button"
      onClick={onConnect}
      data-settings-item="integrations.discord.connect"
      className="flex size-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Icon name="discord-fill" className={cn('size-9', meta.color)} />
      <span className="flex items-center gap-1 text-xs font-medium">
        <Icon name="add" className="size-3.5" />
        {t('settings.integrations.discord.connect')}
      </span>
      <span className="text-[10px] font-normal leading-snug text-muted-foreground/80">
        {t('settings.integrations.discord.connectHint')}
      </span>
    </button>
  );
}

export const MessengerSection: React.FC = () => {
  const connections = useMessengerStore((s) => s.connections);
  const onboardingStep = useMessengerStore((s) => s.onboardingStep);
  const onboardingType = useMessengerStore((s) => s.onboardingType);
  const startOnboarding = useMessengerStore((s) => s.startOnboarding);
  const hasHydrated = useMessengerStore((s) => s.hasHydrated);

  // Failsafe: never leave Integrations blank if persist hydration stalls.
  useEffect(() => {
    if (hasHydrated) return;
    const timer = window.setTimeout(() => {
      if (!useMessengerStore.getState().hasHydrated) {
        useMessengerStore.setState({ hasHydrated: true });
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [hasHydrated]);

  const discordConn = connections.find((c) => c.type === 'discord');
  // Single render rule for the whole section — keyed on the persisted token,
  // not on transient live status, so the surface never flaps between the
  // connect tile, a bare token form, and the configured view.
  // Also considers server-configured so a bot that is live on the server but
  // whose token was lost from the local store still shows the configured view.
  const hasToken = Boolean(discordConn?.botToken);
  const serverConfigured = Boolean(discordConn?.discordServerConfigured);
  const wizardActive = onboardingStep !== null && onboardingType === 'discord';
  const view = deriveDiscordViewState({ hasToken, serverConfigured, wizardActive });

  // When the connect card is showing we don't know yet whether the server has
  // a working bot configured — the localStorage hydration may have come up
  // empty (cleared cache, new device, corrupted data), the initial resync
  // from onRehydrateStorage may have been skipped (error guard, race), or the
  // first probe simply fired before the runtime was ready.  Probe now so the
  // view flips to "configured" within one server round-trip instead of
  // waiting for the next manual action (or never, if nothing else retries).
  useEffect(() => {
    if (!hasHydrated) return;
    if (hasToken || serverConfigured) return;
    void useMessengerStore.getState().resyncDiscordStatus();
  }, [hasHydrated, hasToken, serverConfigured]);

  return (
    <div className="space-y-4">
      {/* Suppress only the connect-card flash until rehydrate; never blank the page. */}
      {hasHydrated && view === 'connect-card' && (
        <DiscordConnectCard onConnect={() => startOnboarding('discord')} />
      )}
      {view !== 'connect-card' && discordConn && <ConnectionCard conn={discordConn} />}
    </div>
  );
};
