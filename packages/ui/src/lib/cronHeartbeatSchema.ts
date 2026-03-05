export type CronScheduleKind = 'at' | 'every' | 'cron';

export type CronSessionTarget = 'main' | 'isolated';

export type CronPayloadKind = 'systemEvent' | 'agentTurn';

export type CronWakeMode = 'now' | 'next-heartbeat';

export type CronDeliveryMode = 'none' | 'announce' | 'webhook';

export type CronChannel = 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'mattermost' | 'signal' | 'imessage' | 'last';

export interface CronScheduleAt {
  kind: 'at';
  at: string;
}

export interface CronScheduleEvery {
  kind: 'every';
  everyMs: number;
}

export interface CronScheduleCron {
  kind: 'cron';
  expr: string;
  tz?: string;
  staggerMs?: number;
}

export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

export interface CronPayloadSystemEvent {
  kind: 'systemEvent';
  text: string;
}

export interface CronPayloadAgentTurn {
  kind: 'agentTurn';
  message: string;
  model?: string;
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  timeoutSeconds?: number;
}

export type CronPayload = CronPayloadSystemEvent | CronPayloadAgentTurn;

export interface CronDelivery {
  mode: CronDeliveryMode;
  channel?: CronChannel;
  to?: string;
  bestEffort?: boolean;
}

export interface CronJob {
  jobId: string;
  name: string;
  description?: string;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode?: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
  agentId?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface CronRetryConfig {
  maxAttempts?: number;
  backoffMs?: number[];
  retryOn?: ('rate_limit' | 'network' | 'server_error')[];
}

export interface CronRunLogConfig {
  maxBytes?: number | string;
  keepLines?: number;
}

export interface CronConfig {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  retry?: CronRetryConfig;
  webhook?: string;
  webhookToken?: string;
  sessionRetention?: string | false;
  runLog?: CronRunLogConfig;
}

export type HeartbeatTarget = 'last' | 'none' | CronChannel;

export type HeartbeatDirectPolicy = 'allow' | 'block';

export interface HeartbeatActiveHours {
  start: string;
  end: string;
  timezone?: string;
}

export interface HeartbeatConfig {
  every?: string;
  model?: string;
  includeReasoning?: boolean;
  target?: HeartbeatTarget;
  to?: string;
  accountId?: string;
  session?: string;
  prompt?: string;
  ackMaxChars?: number;
  suppressToolErrorWarnings?: boolean;
  activeHours?: HeartbeatActiveHours;
  directPolicy?: HeartbeatDirectPolicy;
}

export interface HeartbeatVisibilityConfig {
  showOk?: boolean;
  showAlerts?: boolean;
  useIndicator?: boolean;
}

export interface CronHeartbeatFullConfig {
  cron?: CronConfig;
  heartbeat?: HeartbeatConfig;
}

export const DEFAULT_CRON_CONFIG: CronConfig = {
  enabled: true,
  store: '~/.openchamber/cron/jobs.json',
  maxConcurrentRuns: 1,
  sessionRetention: '24h',
  runLog: {
    maxBytes: 2000000,
    keepLines: 2000,
  },
};

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  every: '30m',
  target: 'none',
  prompt: 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.',
  ackMaxChars: 300,
  directPolicy: 'allow',
};

export function isCronScheduleAt(schedule: CronSchedule): schedule is CronScheduleAt {
  return schedule.kind === 'at';
}

export function isCronScheduleEvery(schedule: CronSchedule): schedule is CronScheduleEvery {
  return schedule.kind === 'every';
}

export function isCronScheduleCron(schedule: CronSchedule): schedule is CronScheduleCron {
  return schedule.kind === 'cron';
}

export function isCronPayloadSystemEvent(payload: CronPayload): payload is CronPayloadSystemEvent {
  return payload.kind === 'systemEvent';
}

export function isCronPayloadAgentTurn(payload: CronPayload): payload is CronPayloadAgentTurn {
  return payload.kind === 'agentTurn';
}
