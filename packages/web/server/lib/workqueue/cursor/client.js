import { getCursorApiKey } from './auth.js';
import { getCursorApiVersion } from '../settings.js';

const CURSOR_API_BASE = 'https://api.cursor.com';
const CURSOR_API_VERSIONS = new Set(['v0', 'v1']);
const DEFAULT_CURSOR_REQUEST_TIMEOUT_MS = 60_000;
const MIN_CURSOR_REQUEST_TIMEOUT_MS = 1_000;
const MAX_CURSOR_REQUEST_TIMEOUT_MS = 300_000;

export function resolveCursorRequestTimeoutMs() {
  const rawValue = process.env.OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS;
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return DEFAULT_CURSOR_REQUEST_TIMEOUT_MS;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_CURSOR_REQUEST_TIMEOUT_MS;
  }

  return Math.min(
    MAX_CURSOR_REQUEST_TIMEOUT_MS,
    Math.max(MIN_CURSOR_REQUEST_TIMEOUT_MS, Math.trunc(parsedValue)),
  );
}

// Cursor cloud agents run in a limited environment: a web surface, a headless
// Linux desktop, or no UI at all. Analysis-derived test requirements are
// mapped onto that set so the dispatch prompt never asks for macOS, Windows,
// iOS, or Android verification the agent cannot perform.
export function mapTestSurfaceForCursor(analysis) {
  if (!analysis) return null;
  if (analysis.needsBrowser) return 'web';
  if (analysis.needsDocker) return 'desktop-linux';
  if (analysis.needsHeadless) return 'headless';
  return null;
}

class CursorApiError extends Error {
  constructor(message, { status = 0, code } = {}) {
    super(message);
    this.name = 'CursorApiError';
    this.status = status;
    if (code) this.code = code;
  }
}

function resolveCursorApiVersion(apiVersion) {
  if (CURSOR_API_VERSIONS.has(apiVersion)) return apiVersion;
  const configuredVersion = getCursorApiVersion();
  return CURSOR_API_VERSIONS.has(configuredVersion) ? configuredVersion : 'v0';
}

function getCursorApiUrl(apiVersion, methodPath) {
  const path = methodPath.startsWith('/') ? methodPath : `/${methodPath}`;
  return `${CURSOR_API_BASE}/${apiVersion}${path}`;
}

function isCursorTimeout(error, signal) {
  if (error?.name === 'TimeoutError') return true;
  return Boolean(
    signal?.aborted
      && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR'),
  );
}

function createCursorTimeoutError(timeoutMs) {
  return new CursorApiError(
    `Cursor API request timed out after ${timeoutMs}ms. This timeout may follow an accepted request; check Cursor before retrying.`,
    { status: 0, code: 'CURSOR_API_TIMEOUT' },
  );
}

function redactCursorApiKey(value, apiKey) {
  const message = typeof value === 'string' ? value : String(value);
  if (!apiKey) return message;
  const encodedCredentials = Buffer.from(`${apiKey}:`).toString('base64');
  return message
    .split(apiKey).join('[redacted]')
    .split(encodedCredentials).join('[redacted]');
}

const cursorRequest = async (
  methodPath,
  { method = 'GET', body, fetchImpl = fetch, apiVersion } = {},
) => {
  const apiKey = getCursorApiKey();
  if (!apiKey) {
    throw new CursorApiError('Cursor is not connected', {
      status: 401,
      code: 'CURSOR_NOT_CONNECTED',
    });
  }

  const selectedApiVersion = resolveCursorApiVersion(apiVersion);
  const timeoutMs = resolveCursorRequestTimeoutMs();
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(getCursorApiUrl(selectedApiVersion, methodPath), {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (isCursorTimeout(error, signal)) {
      throw createCursorTimeoutError(timeoutMs);
    }
    throw new CursorApiError(
      `Cursor API request failed: ${redactCursorApiKey(error?.message || error, apiKey)}`,
      { status: 0 },
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (isCursorTimeout(error, signal)) {
      throw createCursorTimeoutError(timeoutMs);
    }
    if (response.ok) {
      throw new CursorApiError(
        `Cursor API response could not be parsed: ${redactCursorApiKey(error?.message || error, apiKey)}`,
        { status: response.status },
      );
    }
    data = null;
  }
  if (!response.ok) {
    const message = typeof data?.error?.message === 'string'
      ? data.error.message
      : (typeof data?.message === 'string' ? data.message : `Cursor API request failed (${response.status})`);
    throw new CursorApiError(redactCursorApiKey(message, apiKey), { status: response.status });
  }
  return data;
};

/**
 * Launches a background Cursor coding agent.
 *
 * `prompt` and `model` are always supplied by the caller so the user can
 * review and edit both before dispatch; `model: 'default'` is the documented
 * Cursor default rather than a value invented here.
 */
export const launchCursorAgent = ({
  prompt,
  repoUrl,
  model = 'default',
  webhookUrl,
  fetchImpl,
  apiVersion,
}) => {
  const selectedApiVersion = resolveCursorApiVersion(apiVersion);
  const body = selectedApiVersion === 'v1'
    ? {
      prompt: { text: prompt },
      repos: [{ url: repoUrl }],
      model: { id: model },
    }
    : {
      prompt: { text: prompt },
      source: { repository: repoUrl },
      model,
      ...(webhookUrl ? { webhook: { url: webhookUrl } } : {}),
    };

  return cursorRequest('/agents', {
    method: 'POST',
    fetchImpl,
    apiVersion: selectedApiVersion,
    body,
  });
};

function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === 'string' && value) || '';
}

function firstBranchName(branches) {
  if (!Array.isArray(branches)) return '';
  for (const branch of branches) {
    if (typeof branch === 'string' && branch) return branch;
    const name = firstNonEmptyString(branch?.branch, branch?.name, branch?.branchName);
    if (name) return name;
  }
  return '';
}

function normalizeCreatedAt(createdAt) {
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt;
  if (typeof createdAt === 'string') return Date.parse(createdAt) || Date.now();
  return Date.now();
}

function isV1CursorAgentResponse(agent) {
  return Boolean(agent?.agent && typeof agent.agent === 'object');
}

/** Normalizes a v0 or v1 agent payload into the shape persisted on a work queue item. */
export const normalizeCursorAgent = (agent, options = {}) => {
  const requestedApiVersion = typeof options === 'string' ? options : options?.apiVersion;
  const apiVersion = CURSOR_API_VERSIONS.has(requestedApiVersion)
    ? requestedApiVersion
    : (isV1CursorAgentResponse(agent) ? 'v1' : 'v0');

  if (apiVersion === 'v1') {
    const agentRecord = agent?.agent && typeof agent.agent === 'object' ? agent.agent : agent;
    const runRecord = agent?.run && typeof agent.run === 'object' ? agent.run : {};
    const agentId = typeof agentRecord?.id === 'string' ? agentRecord.id : '';
    const runId = firstNonEmptyString(runRecord?.id, agentRecord?.runId, agentRecord?.latestRunId);
    const target = agentRecord?.target && typeof agentRecord.target === 'object'
      ? agentRecord.target
      : agent?.target;

    return {
      agentId,
      runId,
      status: firstNonEmptyString(runRecord.status, agentRecord?.status, agent?.status) || 'CREATING',
      url: firstNonEmptyString(agentRecord?.url, target?.url),
      branchName: firstBranchName(runRecord?.git?.branches),
      name: typeof agentRecord?.name === 'string' ? agentRecord.name : '',
      createdAt: normalizeCreatedAt(agentRecord?.createdAt),
      apiVersion: 'v1',
    };
  }

  const agentId = typeof agent?.id === 'string' ? agent.id : '';
  return {
    agentId,
    runId: agentId,
    status: typeof agent?.status === 'string' ? agent.status : 'CREATING',
    url: typeof agent?.target?.url === 'string' ? agent.target.url : '',
    branchName: typeof agent?.target?.branchName === 'string' ? agent.target.branchName : '',
    name: typeof agent?.name === 'string' ? agent.name : '',
    createdAt: normalizeCreatedAt(agent?.createdAt),
    apiVersion: 'v0',
  };
};

function mergeV1AgentRun(agent, run, storedAgent = {}) {
  const target = agent?.target && typeof agent.target === 'object'
    ? { ...agent.target }
    : {};
  const branchName = firstNonEmptyString(
    firstBranchName(run?.git?.branches),
    target.branchName,
    storedAgent?.branchName,
  );
  const url = firstNonEmptyString(agent?.url, target.url, storedAgent?.url);

  if (url) target.url = url;
  else delete target.url;
  if (branchName) target.branchName = branchName;
  else delete target.branchName;

  const merged = { ...agent };
  if (typeof run?.status === 'string' && run.status) {
    merged.status = run.status;
  }
  if ((!merged.status || typeof merged.status !== 'string') && typeof storedAgent?.status === 'string') {
    merged.status = storedAgent.status;
  }
  if (Object.keys(target).length > 0 || agent?.target) {
    merged.target = target;
  }
  if ((!merged.name || typeof merged.name !== 'string') && typeof storedAgent?.name === 'string') {
    merged.name = storedAgent.name;
  }
  return merged;
}

export const getCursorAgent = async (
  agentId,
  {
    fetchImpl,
    apiVersion,
    runId,
    persistedAgent,
    cloudAgent,
    storedAgent: storedAgentOption,
    url,
    branchName,
    name,
    status,
  } = {},
) => {
  const selectedApiVersion = resolveCursorApiVersion(apiVersion);
  const agent = await cursorRequest(
    `/agents/${encodeURIComponent(agentId)}`,
    { fetchImpl, apiVersion: selectedApiVersion },
  );

  if (selectedApiVersion === 'v0') return agent;

  const agentRecord = agent?.agent && typeof agent.agent === 'object'
    ? { ...agent, ...agent.agent }
    : agent;
  const storedRunId = typeof runId === 'string' && runId ? runId : '';
  const latestRunId = firstNonEmptyString(agentRecord?.latestRunId, agentRecord?.run?.id);
  const selectedRunId = storedRunId || latestRunId;
  const storedAgent = persistedAgent || cloudAgent || storedAgentOption || {
    url,
    branchName,
    name,
    status,
  };

  if (!selectedRunId) return mergeV1AgentRun(agentRecord, null, storedAgent);

  const runResponse = await cursorRequest(
    `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(selectedRunId)}`,
    { fetchImpl, apiVersion: selectedApiVersion },
  );
  const run = runResponse?.run && typeof runResponse.run === 'object' ? runResponse.run : runResponse;
  return mergeV1AgentRun(agentRecord, run, storedAgent);
};

export const verifyCursorApiKey = async ({ fetchImpl, apiVersion } = {}) => cursorRequest('/me', {
  fetchImpl,
  apiVersion: resolveCursorApiVersion(apiVersion),
});

export { CursorApiError };
