import { runtimeFetch } from '@/lib/runtime-fetch';
import type { ExecutionTarget } from '@/types/harness';
import { isExecutionTarget } from '@/types/harness';

type HarnessAttachmentFile = {
  mime: string;
  url: string;
  filename: string;
};

export type HarnessPromptParams = {
  sessionId: string;
  directory: string;
  target: ExecutionTarget;
  text: string;
  files?: HarnessAttachmentFile[];
  messageId?: string;
  assistantMessageId?: string;
  seedFromSessionId?: string;
  agentsMode?: 'claude' | 'opencode';
  /** The server resolves this OpenCode agent's prompt and permissions. */
  agent?: string;
  claudeAgent?: string;
  /** Fallback for runtimes where the server cannot resolve the OpenCode agent. */
  systemPromptAppend?: string;
  command?: HarnessOpenCodeCommand;
};

export type HarnessOpenCodeCommand = {
  name: string;
  arguments?: string;
};

export type HarnessPromptResult = {
  ok: boolean;
  sessionId: string;
  harnessId: string;
  messageId?: string;
  assistantMessageId?: string;
  status: string;
};

export type HarnessAbortParams = {
  sessionId: string;
  directory?: string;
};

export type HarnessAbortResult = {
  ok: boolean;
  sessionId?: string;
  status?: string;
  aborted?: boolean;
  reason?: string;
};

type HarnessPermissionReply = 'once' | 'always' | 'reject';

export type HarnessPermissionReplyParams = {
  sessionId: string;
  requestId: string;
  reply: HarnessPermissionReply;
  directory?: string;
};

export type HarnessPermissionReplyResult = {
  ok: boolean;
  sessionId: string;
  requestId: string;
  reply: HarnessPermissionReply;
};

export type HarnessQuestionReplyParams = {
  sessionId: string;
  requestId: string;
  answers?: string[][];
  reject?: boolean;
  directory?: string;
};

export type HarnessQuestionReplyResult = {
  ok: boolean;
  sessionId: string;
  requestId: string;
};

export class HarnessClientError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly status?: string;

  constructor(message: string, code: string, statusCode = 500, status?: string) {
    super(message);
    this.name = 'HarnessClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const trimmedString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const readJson = (response: Response): Promise<unknown> => response.json().catch(() => null);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const readErrorPayload = async (response: Response): Promise<{ message: string; code: string; status?: string }> => {
  const payload = await readJson(response);
  const fallback = `Request failed (${response.status})`;
  if (!isRecord(payload)) return { message: fallback, code: 'HARNESS_ERROR' };
  return {
    message: trimmedString(payload.error) ?? trimmedString(payload.message) ?? fallback,
    code: trimmedString(payload.code) ?? 'HARNESS_ERROR',
    status: str(payload.status),
  };
};

async function requestHarness(
  path: string,
  init: Parameters<typeof runtimeFetch>[1],
  networkMessage: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await runtimeFetch(path, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : networkMessage;
    throw new HarnessClientError(message, 'HARNESS_NETWORK', 0);
  }

  if (!response.ok) {
    const { message, code, status } = await readErrorPayload(response);
    throw new HarnessClientError(message, code, response.status, status);
  }
  return response;
}

const postJson = (path: string, body: unknown, networkMessage: string) => requestHarness(path, {
  method: 'POST',
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
}, networkMessage);

const getJson = (
  path: string,
  networkMessage: string,
  query?: Record<string, string>,
) => requestHarness(path, {
  method: 'GET',
  headers: { Accept: 'application/json' },
  query,
}, networkMessage);

async function readRecord(response: Response, invalidMessage: string): Promise<Record<string, unknown>> {
  const payload = await readJson(response);
  if (!isRecord(payload)) {
    throw new HarnessClientError(invalidMessage, 'HARNESS_INVALID_RESPONSE', response.status);
  }
  return payload;
}

function addTrimmed(body: Record<string, unknown>, key: string, value: unknown): void {
  const trimmed = trimmedString(value);
  if (trimmed) body[key] = trimmed;
}

function requireValue(value: string, name: string, code: string): void {
  if (!value.trim()) throw new HarnessClientError(`${name} is required`, code, 400);
}

function buildHarnessPromptBody(params: HarnessPromptParams): Record<string, unknown> {
  requireValue(params.sessionId, 'sessionId', 'PROMPT_INVALID');
  requireValue(params.directory, 'directory', 'PROMPT_INVALID');
  if (!isExecutionTarget(params.target) || params.target.harnessId === 'opencode') {
    throw new HarnessClientError('target must be a non-OpenCode ExecutionTarget', 'PROMPT_INVALID', 400);
  }

  const body: Record<string, unknown> = {
    sessionId: params.sessionId,
    directory: params.directory,
    target: params.target,
    text: params.text,
  };

  if (params.files?.length) {
    body.files = params.files.map(({ mime, url, filename }) => ({ mime, url, filename }));
  }
  if (params.messageId) body.messageId = params.messageId;
  if (params.assistantMessageId) body.assistantMessageId = params.assistantMessageId;
  addTrimmed(body, 'seedFromSessionId', params.seedFromSessionId);
  if (params.agentsMode === 'claude' || params.agentsMode === 'opencode') {
    body.agentsMode = params.agentsMode;
  }
  addTrimmed(body, 'agent', params.agent);
  addTrimmed(body, 'claudeAgent', params.claudeAgent);
  addTrimmed(body, 'systemPromptAppend', params.systemPromptAppend);
  const commandName = params.command?.name.trim();
  if (commandName) {
    body.command = {
      name: commandName,
      ...(params.command?.arguments?.trim() ? { arguments: params.command.arguments.trim() } : {}),
    };
  }
  return body;
}

export async function harnessPrompt(params: HarnessPromptParams): Promise<HarnessPromptResult> {
  const body = buildHarnessPromptBody(params);
  const response = await postJson('/api/harness/prompt', body, 'Harness prompt request failed');
  const payload = await readRecord(response, 'Invalid harness prompt response');

  return {
    ok: payload.ok !== false,
    sessionId: str(payload.sessionId) ?? params.sessionId,
    harnessId: str(payload.harnessId) ?? params.target.harnessId,
    ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
    ...(typeof payload.assistantMessageId === 'string' ? { assistantMessageId: payload.assistantMessageId } : {}),
    status: str(payload.status) ?? 'started',
  };
}

export async function harnessAbort(params: HarnessAbortParams): Promise<HarnessAbortResult> {
  requireValue(params.sessionId, 'sessionId', 'ABORT_INVALID');

  const body: Record<string, unknown> = { sessionId: params.sessionId };
  addTrimmed(body, 'directory', params.directory);

  const response = await postJson('/api/harness/abort', body, 'Harness abort request failed');

  const payload = await readJson(response);
  if (!isRecord(payload)) {
    return { ok: true, sessionId: params.sessionId };
  }

  return {
    ok: payload.ok !== false,
    sessionId: str(payload.sessionId) ?? params.sessionId,
    ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
    ...(typeof payload.aborted === 'boolean' ? { aborted: payload.aborted } : {}),
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
  };
}

export async function harnessPermissionReply(
  params: HarnessPermissionReplyParams,
): Promise<HarnessPermissionReplyResult> {
  requireValue(params.sessionId, 'sessionId', 'PERMISSION_REPLY_INVALID');
  requireValue(params.requestId, 'requestId', 'PERMISSION_REPLY_INVALID');
  if (params.reply !== 'once' && params.reply !== 'always' && params.reply !== 'reject') {
    throw new HarnessClientError('reply must be once, always, or reject', 'PERMISSION_REPLY_INVALID', 400);
  }

  const body: Record<string, unknown> = {
    sessionId: params.sessionId,
    requestId: params.requestId,
    reply: params.reply,
  };
  addTrimmed(body, 'directory', params.directory);

  const response = await postJson('/api/harness/permission/reply', body, 'Harness permission reply failed');

  const payload = await readJson(response);
  if (!isRecord(payload)) {
    return { ok: true, sessionId: params.sessionId, requestId: params.requestId, reply: params.reply };
  }

  return {
    ok: payload.ok !== false,
    sessionId: str(payload.sessionId) ?? params.sessionId,
    requestId: str(payload.requestId) ?? params.requestId,
    reply: payload.reply === 'once' || payload.reply === 'always' || payload.reply === 'reject'
      ? payload.reply
      : params.reply,
  };
}

export async function harnessQuestionReply(
  params: HarnessQuestionReplyParams,
): Promise<HarnessQuestionReplyResult> {
  requireValue(params.sessionId, 'sessionId', 'QUESTION_REPLY_INVALID');
  requireValue(params.requestId, 'requestId', 'QUESTION_REPLY_INVALID');

  const body: Record<string, unknown> = {
    sessionId: params.sessionId,
    requestId: params.requestId,
  };
  addTrimmed(body, 'directory', params.directory);
  if (params.reject === true) {
    body.reject = true;
  } else if (Array.isArray(params.answers)) {
    body.answers = params.answers;
  }

  const response = await postJson('/api/harness/question/reply', body, 'Harness question reply failed');

  const payload = await readJson(response);
  if (!isRecord(payload)) {
    return { ok: true, sessionId: params.sessionId, requestId: params.requestId };
  }

  return {
    ok: payload.ok !== false,
    sessionId: str(payload.sessionId) ?? params.sessionId,
    requestId: str(payload.requestId) ?? params.requestId,
  };
}

export type ClaudeSessionCapabilities = {
  sessionId: string;
  foreignSessionId?: string;
  slashCommands: string[];
  skills: string[];
  agents: string[];
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  updatedAt: number;
};

export type HarnessSessionCapabilitiesResult = {
  sessionId: string;
  harnessId: string;
  capabilities: ClaudeSessionCapabilities;
};

/** Maps each array entry to a `[dedupeKey, value]` pair, dropping `null` and repeated keys. */
function sanitizeList<T>(value: unknown, map: (entry: unknown) => [string, T] | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const mapped = map(entry);
    if (!mapped || seen.has(mapped[0])) continue;
    seen.add(mapped[0]);
    out.push(mapped[1]);
  }
  return out;
}

const sanitizeStringList = (value: unknown): string[] => sanitizeList(value, (entry) => {
  const trimmed = trimmedString(entry);
  return trimmed ? [trimmed, trimmed] : null;
});

const sanitizeMcpServers = (value: unknown): Array<{ name: string; status: string }> =>
  sanitizeList(value, (entry) => {
    if (!isRecord(entry)) return null;
    const name = trimmedString(entry.name);
    if (!name) return null;
    return [name, { name, status: trimmedString(entry.status) ?? 'unknown' }];
  });

export async function harnessSessionCapabilities(
  sessionId: string,
): Promise<HarnessSessionCapabilitiesResult> {
  const id = sessionId.trim();
  requireValue(id, 'sessionId', 'PROMPT_INVALID');

  const response = await getJson(
    `/api/harness/sessions/${encodeURIComponent(id)}/capabilities`,
    'Harness capabilities request failed',
  );

  const payload = await readRecord(response, 'Invalid harness capabilities response');
  if (!isRecord(payload.capabilities)) {
    throw new HarnessClientError('Invalid harness capabilities response', 'HARNESS_INVALID_RESPONSE', response.status);
  }

  const caps = payload.capabilities;
  return {
    sessionId: str(payload.sessionId) ?? id,
    harnessId: str(payload.harnessId) ?? 'claude-code',
    capabilities: {
      sessionId: str(caps.sessionId) ?? id,
      ...(typeof caps.foreignSessionId === 'string' ? { foreignSessionId: caps.foreignSessionId } : {}),
      slashCommands: sanitizeStringList(caps.slashCommands),
      skills: sanitizeStringList(caps.skills),
      agents: sanitizeStringList(caps.agents),
      tools: sanitizeStringList(caps.tools),
      mcpServers: sanitizeMcpServers(caps.mcpServers),
      updatedAt: typeof caps.updatedAt === 'number' ? caps.updatedAt : 0,
    },
  };
}

export type ClaudeAgent = {
  name: string;
  description: string;
  model: string;
  source: 'builtin' | 'user' | 'project';
};

export type HarnessClaudeAgentsResult = {
  agents: ClaudeAgent[];
  roots: { user: string | null; project: string | null };
};

const sanitizeClaudeAgents = (value: unknown): ClaudeAgent[] => sanitizeList(value, (entry) => {
  if (!isRecord(entry)) return null;
  const name = trimmedString(entry.name);
  if (!name) return null;
  return [name.toLowerCase(), {
    name,
    description: trimmedString(entry.description) ?? '',
    model: trimmedString(entry.model) ?? '',
    source: entry.source === 'user' || entry.source === 'project' ? entry.source : 'builtin',
  }];
});

export async function harnessClaudeAgents(directory?: string): Promise<HarnessClaudeAgentsResult> {
  const trimmedDirectory = directory?.trim();
  const response = await getJson(
    '/api/harness/claude-code/agents',
    'Harness agents request failed',
    trimmedDirectory ? { directory: trimmedDirectory } : undefined,
  );

  const payload = await readRecord(response, 'Invalid harness agents response');
  const roots = isRecord(payload.roots) ? payload.roots : {};
  return {
    agents: sanitizeClaudeAgents(payload.agents),
    roots: {
      user: trimmedString(roots.user),
      project: trimmedString(roots.project),
    },
  };
}

export type HarnessSessionBinding = {
  sessionId: string;
  harnessId: string;
  directory?: string;
  target?: ExecutionTarget;
  foreignSessionId?: string;
  /** Agent selection used by the session's last turn. */
  agentsMode?: 'claude' | 'opencode';
  agentName?: string;
  claudeAgentName?: string;
};

export async function harnessSessionBinding(sessionId: string): Promise<HarnessSessionBinding | null> {
  const id = sessionId.trim();
  if (!id) return null;

  let response: Response;
  try {
    response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const payload = await readJson(response);
  const binding = isRecord(payload) && isRecord(payload.binding) ? payload.binding : null;
  if (!binding || typeof binding.sessionId !== 'string' || typeof binding.harnessId !== 'string') {
    return null;
  }
  return {
    sessionId: binding.sessionId,
    harnessId: binding.harnessId,
    ...(typeof binding.directory === 'string' ? { directory: binding.directory } : {}),
    ...(isExecutionTarget(binding.target) ? { target: binding.target } : {}),
    ...(typeof binding.foreignSessionId === 'string' ? { foreignSessionId: binding.foreignSessionId } : {}),
    ...(binding.agentsMode === 'claude' || binding.agentsMode === 'opencode' ? { agentsMode: binding.agentsMode } : {}),
    ...(typeof binding.agentName === 'string' && binding.agentName ? { agentName: binding.agentName } : {}),
    ...(typeof binding.claudeAgentName === 'string' && binding.claudeAgentName ? { claudeAgentName: binding.claudeAgentName } : {}),
  };
}

export type ClaudeImportSessionCandidate = {
  foreignSessionId: string;
  title: string | null;
  directory: string | null;
  updatedAt: number | null;
  alreadyImported: boolean;
  directoryMissing: boolean;
};

export type ClaudeImportProjectCandidate = {
  projectKey: string;
  directory: string | null;
  directoryMissing: boolean;
  sessionCount: number;
  sessions: ClaudeImportSessionCandidate[];
};

export type ClaudeImportCandidatesResult = {
  configDir: string | null;
  projectsRoot: string | null;
  projects: ClaudeImportProjectCandidate[];
};

export type ClaudeImportSessionRequest = {
  foreignSessionId: string;
  directory: string;
  title?: string | null;
};

type ClaudeImportResultRow = {
  ok: boolean;
  foreignSessionId: string | null;
  sessionId?: string;
  directory?: string | null;
  title?: string | null;
  status?: 'imported' | 'skipped';
  reason?: string;
  error?: string;
  code?: string;
};

export type ClaudeImportResult = {
  results: ClaudeImportResultRow[];
  summary: {
    imported: number;
    skipped: number;
    failed: number;
  };
};

const recordList = (value: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(value) ? value.filter(isRecord) : []);

const parseImportSessions = (value: unknown): ClaudeImportSessionCandidate[] => {
  const sessions: ClaudeImportSessionCandidate[] = [];
  for (const session of recordList(value)) {
    const foreignSessionId = trimmedString(session.foreignSessionId);
    if (!foreignSessionId) continue;
    sessions.push({
      foreignSessionId,
      title: str(session.title) ?? null,
      directory: str(session.directory) ?? null,
      updatedAt: typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
        ? session.updatedAt
        : null,
      alreadyImported: session.alreadyImported === true,
      directoryMissing: session.directoryMissing === true,
    });
  }
  return sessions;
};

export async function listClaudeImportCandidates(): Promise<ClaudeImportCandidatesResult> {
  const response = await getJson(
    '/api/harness/claude-code/import/candidates',
    'Claude import candidates request failed',
  );

  const payload = await readJson(response);
  if (!isRecord(payload)) {
    throw new HarnessClientError('Invalid Claude import candidates response', 'HARNESS_INVALID_RESPONSE', 500);
  }

  return {
    configDir: str(payload.configDir) ?? null,
    projectsRoot: str(payload.projectsRoot) ?? null,
    projects: recordList(payload.projects).map((project) => {
      const sessions = parseImportSessions(project.sessions);
      return {
        projectKey: str(project.projectKey) ?? '',
        directory: str(project.directory) ?? null,
        directoryMissing: project.directoryMissing === true,
        sessionCount: typeof project.sessionCount === 'number' ? project.sessionCount : sessions.length,
        sessions,
      };
    }),
  };
}

export async function importClaudeSessions(
  sessions: ClaudeImportSessionRequest[],
): Promise<ClaudeImportResult> {
  const response = await postJson('/api/harness/claude-code/import', { sessions }, 'Claude import request failed');

  const payload = await readJson(response);
  if (!isRecord(payload) || !isRecord(payload.summary) || !Array.isArray(payload.results)) {
    throw new HarnessClientError('Invalid Claude import response', 'HARNESS_INVALID_RESPONSE', response.status);
  }

  return {
    results: payload.results.filter(isRecord).map((row) => ({
      ok: row.ok !== false,
      foreignSessionId: typeof row.foreignSessionId === 'string' ? row.foreignSessionId : null,
      ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}),
      ...(typeof row.directory === 'string' || row.directory === null ? { directory: row.directory as string | null } : {}),
      ...(typeof row.title === 'string' || row.title === null ? { title: row.title as string | null } : {}),
      ...(row.status === 'imported' || row.status === 'skipped' ? { status: row.status } : {}),
      ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
      ...(typeof row.code === 'string' ? { code: row.code } : {}),
    })),
    summary: {
      imported: typeof payload.summary.imported === 'number' ? payload.summary.imported : 0,
      skipped: typeof payload.summary.skipped === 'number' ? payload.summary.skipped : 0,
      failed: typeof payload.summary.failed === 'number' ? payload.summary.failed : 0,
    },
  };
}
