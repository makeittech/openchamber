/**
 * List and import Claude Code projects/sessions from local disk.
 *
 * Claude stores transcripts under `$CLAUDE_CONFIG_DIR/projects` (or
 * `~/.claude/projects`) as `<encoded-cwd>/<session-id>.jsonl`. Encoding
 * replaces non-alphanumeric path characters with `-` (ambiguous to reverse),
 * so cwd is taken from JSONL metadata when present.
 *
 * Import creates OpenCode session shells + harness bindings with
 * `foreignSessionId` for Claude resume. JSONL is not replayed into OpenCode
 * message stores (format is unstable / Anthropic-internal).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import {
  bindSession,
  flushSessionBindings,
  listSessionBindings,
} from '../../session-bindings.js';
import { getHarnessCapabilities } from '../../registry.js';

const MAX_IMPORT_BATCH = 100;
const MAX_JSONL_SCAN_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 120;
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSONL_EXT = '.jsonl';

/** @param {unknown} value @returns {string} */
function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {string} message @param {string} code @param {number} statusCode @returns {Error} */
function codedError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {string} [homeDir]
 * @returns {string[]}
 */
function listClaudeConfigDirCandidates(env = process.env, homeDir = os.homedir()) {
  const candidates = [];
  const configDir = trimmedString(env?.CLAUDE_CONFIG_DIR);
  if (configDir) candidates.push(configDir);
  if (trimmedString(homeDir)) {
    candidates.push(path.join(homeDir, '.claude'));
    candidates.push(path.join(homeDir, '.config', 'claude'));
  }
  return candidates;
}

/**
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [options.env]
 * @param {string} [options.homeDir]
 * @returns {string | null}
 */
export function resolveClaudeProjectsRoot(options = {}) {
  const fsLike = options.fs || fs;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  for (const configDir of listClaudeConfigDirCandidates(env, homeDir)) {
    const projectsRoot = path.join(configDir, 'projects');
    if (directoryExistsSync(fsLike, projectsRoot)) return projectsRoot;
  }
  return null;
}

/**
 * Best-effort decode of Claude's encoded project folder name.
 * Prefer JSONL `cwd` over this when available.
 *
 * @param {string} encoded
 * @returns {string | null}
 */
export function decodeClaudeProjectKey(encoded) {
  const key = trimmedString(encoded);
  if (!key) return null;
  // Leading `-` usually means an absolute POSIX path (`/Users/...` → `-Users-...`).
  if (key.startsWith('-')) return `/${key.slice(1).replace(/-/g, '/')}`;
  // Windows drive: `C-Users-...` → `C:/Users/...`
  if (/^[A-Za-z]-/.test(key)) return `${key[0]}:/${key.slice(2).replace(/-/g, '/')}`;
  return key.replace(/-/g, '/');
}

/** @param {unknown} value @returns {string} */
function extractTextContent(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => trimmedString(block.text))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** @param {string} text @returns {string} */
function truncateTitle(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Scan the start of a Claude JSONL transcript for title + cwd metadata.
 * Never throws for malformed lines — skips and continues.
 *
 * Title priority (Claude's own naming wins): custom user-set name → latest
 * `ai-title` record → `summary` record → first user text.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @returns {{ title: string | null, directory: string | null, updatedAt: number | null }}
 */
export function inspectClaudeSessionJsonl(filePath, options = {}) {
  const fsLike = options.fs || fs;
  let customName = null;
  let aiTitle = null;
  let summaryTitle = null;
  let firstTextTitle = null;
  let directory = null;
  let updatedAt = null;

  try {
    const fd = fsLike.openSync(filePath, 'r');
    try {
      const stat = fsLike.fstatSync(fd);
      if (Number.isFinite(stat.mtimeMs)) updatedAt = Math.round(stat.mtimeMs);
      const size = Math.min(Math.max(0, Number(stat.size) || 0), MAX_JSONL_SCAN_BYTES);
      if (size === 0) return { title: null, directory, updatedAt };

      const buffer = Buffer.alloc(size);
      fsLike.readSync(fd, buffer, 0, size, 0);
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        let record;
        try {
          record = JSON.parse(line.trim() || 'null');
        } catch {
          continue;
        }
        if (!record || typeof record !== 'object') continue;

        if (!directory) directory = trimmedString(record.cwd) || null;

        const type = typeof record.type === 'string' ? record.type : '';
        if (type === 'ai-title' && trimmedString(record.aiTitle)) {
          aiTitle = truncateTitle(record.aiTitle);
        }
        if (!summaryTitle && type === 'summary' && trimmedString(record.summary)) {
          summaryTitle = truncateTitle(record.summary);
        }
        if (!customName) {
          // First present name field wins, even when it is blank.
          const name = typeof record.customTitle === 'string' ? record.customTitle
            : typeof record.sessionName === 'string' ? record.sessionName
              : type === 'session-meta' && typeof record.name === 'string' ? record.name
                : '';
          if (name.trim()) customName = truncateTitle(name);
        }
        if (!firstTextTitle && (type === 'user' || record?.message?.role === 'user')) {
          const textContent = extractTextContent(record?.message?.content ?? record?.content);
          // Skip tool_result-only user turns.
          if (textContent && !textContent.startsWith('<')) {
            firstTextTitle = truncateTitle(textContent);
          }
        }

        if (directory && (customName || (aiTitle && summaryTitle && firstTextTitle))) break;
      }
    } finally {
      fsLike.closeSync(fd);
    }
  } catch {
    // unreadable file — return whatever we have
  }

  return { title: customName || aiTitle || summaryTitle || firstTextTitle, directory, updatedAt };
}

/**
 * Session transcripts directly inside one directory. The UUID filter also
 * excludes Claude's `agent-*.jsonl` subagent/sidechain transcripts.
 *
 * @param {typeof fs} fsLike
 * @param {string} dirPath
 * @returns {Array<{ foreignSessionId: string, jsonlPath: string }>}
 */
function listSessionJsonlFiles(fsLike, dirPath) {
  let entries;
  try {
    entries = fsLike.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(JSONL_EXT)) continue;
    const foreignSessionId = entry.name.slice(0, -JSONL_EXT.length);
    if (!SESSION_UUID_RE.test(foreignSessionId)) continue;
    files.push({ foreignSessionId, jsonlPath: path.join(dirPath, entry.name) });
  }
  return files;
}

/**
 * @param {typeof fs} fsLike
 * @param {string} projectsRoot
 * @returns {string[]} throws when the root is unreadable
 */
function readProjectKeys(fsLike, projectsRoot) {
  return fsLike.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * @param {string} projectsRoot
 * @param {string} projectKey
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @returns {Array<{ foreignSessionId: string, jsonlPath: string, title: string | null, directory: string | null, updatedAt: number | null }>}
 */
function listClaudeSessionsInProject(projectsRoot, projectKey, options = {}) {
  const fsLike = options.fs || fs;
  const projectDir = path.join(projectsRoot, projectKey);
  const decodedFallback = decodeClaudeProjectKey(projectKey);

  const sessions = [
    ...listSessionJsonlFiles(fsLike, projectDir),
    ...listSessionJsonlFiles(fsLike, path.join(projectDir, 'sessions')),
  ].map((file) => {
    const meta = inspectClaudeSessionJsonl(file.jsonlPath, { fs: fsLike });
    return {
      ...file,
      title: meta.title,
      directory: meta.directory || decodedFallback,
      updatedAt: meta.updatedAt,
    };
  });

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

/**
 * @param {typeof fs} fsLike
 * @param {string} directory
 * @returns {boolean}
 */
function directoryExistsSync(fsLike, directory) {
  try {
    return fsLike.existsSync(directory) && fsLike.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every Claude session id that actually has a transcript on disk.
 *
 * Import requests carry client-supplied ids. Without this set the endpoint
 * would create and permanently bind an OpenCode session for any well-formed
 * UUID, filling the binding store with entries no transcript backs.
 *
 * @param {string | null} projectsRoot
 * @param {typeof fs} fsLike
 * @returns {Set<string>}
 */
function collectKnownForeignSessionIds(projectsRoot, fsLike) {
  /** @type {Set<string>} */
  const known = new Set();
  if (!projectsRoot) return known;

  let projectKeys;
  try {
    projectKeys = readProjectKeys(fsLike, projectsRoot);
  } catch {
    return known;
  }
  for (const projectKey of projectKeys) {
    for (const file of listSessionJsonlFiles(fsLike, path.join(projectsRoot, projectKey))) {
      known.add(file.foreignSessionId);
    }
  }
  return known;
}

/**
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [options.env]
 * @param {string} [options.homeDir]
 * @param {() => object[]} [options.listBindings]
 * @param {(directory: string) => boolean | Promise<boolean>} [options.directoryExists]
 * @returns {Promise<{ configDir: string | null, projectsRoot: string | null, projects: object[] }>}
 */
export async function listClaudeImportCandidates(options = {}) {
  const fsLike = options.fs || fs;
  const listBindings = options.listBindings || listSessionBindings;
  const projectsRoot = resolveClaudeProjectsRoot({
    fs: fsLike,
    env: options.env,
    homeDir: options.homeDir,
  });

  if (!projectsRoot) return { configDir: null, projectsRoot: null, projects: [] };

  const boundForeignIds = new Set(
    listBindings()
      .map((binding) => (typeof binding?.foreignSessionId === 'string' ? binding.foreignSessionId : ''))
      .filter(Boolean),
  );

  let projectKeys;
  try {
    projectKeys = readProjectKeys(fsLike, projectsRoot).sort();
  } catch (error) {
    throw codedError(
      error?.message || 'Failed to read Claude projects directory',
      'CLAUDE_PROJECTS_UNREADABLE',
      500,
    );
  }

  const directoryExists = options.directoryExists || ((directory) => directoryExistsSync(fsLike, directory));

  const projects = [];
  for (const projectKey of projectKeys) {
    const sessionsRaw = listClaudeSessionsInProject(projectsRoot, projectKey, { fs: fsLike });
    if (sessionsRaw.length === 0) continue;

    // Prefer the most common cwd among sessions for the project directory.
    /** @type {Map<string, number>} */
    const cwdCounts = new Map();
    for (const session of sessionsRaw) {
      if (session.directory) cwdCounts.set(session.directory, (cwdCounts.get(session.directory) || 0) + 1);
    }
    let directory = decodeClaudeProjectKey(projectKey);
    let bestCount = 0;
    for (const [cwd, count] of cwdCounts) {
      if (count > bestCount) {
        bestCount = count;
        directory = cwd;
      }
    }

    const resolvedSessions = [];
    for (const session of sessionsRaw) {
      const sessionDirectory = session.directory || directory;
      resolvedSessions.push({
        foreignSessionId: session.foreignSessionId,
        title: session.title,
        directory: sessionDirectory,
        updatedAt: session.updatedAt,
        alreadyImported: boundForeignIds.has(session.foreignSessionId),
        directoryMissing: sessionDirectory ? !(await directoryExists(sessionDirectory)) : true,
      });
    }

    projects.push({
      projectKey,
      directory,
      directoryMissing: directory ? !(await directoryExists(directory)) : true,
      sessionCount: resolvedSessions.length,
      sessions: resolvedSessions,
    });
  }

  projects.sort((a, b) => {
    const latest = (project) => Math.max(0, ...project.sessions.map((s) => s.updatedAt || 0));
    return latest(b) - latest(a);
  });

  return { configDir: path.dirname(projectsRoot), projectsRoot, projects };
}

/**
 * @param {object} params
 * @param {Array<{ foreignSessionId: string, directory: string, title?: string | null }>} params.sessions
 * @param {(directory: string, title?: string | null) => Promise<string>} params.createSession
 * @param {typeof bindSession} [params.bind]
 * @param {typeof flushSessionBindings} [params.flush]
 * @param {() => object[]} [params.listBindings]
 * @param {(directory: string) => boolean | Promise<boolean>} [params.directoryExists]
 * @param {typeof fs} [params.fs]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [params.env]
 * @param {string} [params.homeDir]
 * @param {Set<string>} [params.knownForeignSessionIds]
 * @param {string} [params.defaultModelRef]
 * @returns {Promise<{ results: object[], summary: { imported: number, skipped: number, failed: number } }>}
 */
export async function importClaudeSessions(params) {
  const sessions = Array.isArray(params.sessions) ? params.sessions : [];
  if (sessions.length === 0) {
    return { results: [], summary: { imported: 0, skipped: 0, failed: 0 } };
  }
  if (sessions.length > MAX_IMPORT_BATCH) {
    throw codedError(
      `Import is limited to ${MAX_IMPORT_BATCH} sessions per request`,
      'IMPORT_BATCH_TOO_LARGE',
      400,
    );
  }

  const createSession = params.createSession;
  if (typeof createSession !== 'function') {
    throw codedError('createSession is required', 'IMPORT_MISCONFIGURED', 500);
  }

  const fsLike = params.fs || fs;
  const bind = params.bind || bindSession;
  const flush = params.flush || flushSessionBindings;
  const listBindings = params.listBindings || listSessionBindings;
  const directoryExists = params.directoryExists || ((directory) => directoryExistsSync(fsLike, directory));
  const knownForeignSessionIds = params.knownForeignSessionIds instanceof Set
    ? params.knownForeignSessionIds
    : collectKnownForeignSessionIds(
      resolveClaudeProjectsRoot({ fs: fsLike, env: params.env, homeDir: params.homeDir }),
      fsLike,
    );
  const defaultModelRef = trimmedString(params.defaultModelRef) || 'sonnet';

  const boundForeignIds = new Map();
  for (const binding of listBindings()) {
    if (typeof binding?.foreignSessionId === 'string' && binding.foreignSessionId) {
      boundForeignIds.set(binding.foreignSessionId, binding.sessionId);
    }
  }

  const capabilitySnapshot = getHarnessCapabilities('claude-code') || null;
  /** @type {object[]} */
  const results = [];
  const summary = { imported: 0, skipped: 0, failed: 0 };
  const addFailure = (result) => {
    summary.failed += 1;
    results.push({ ok: false, ...result });
  };

  for (const item of sessions) {
    const foreignSessionId = trimmedString(item?.foreignSessionId);
    const directory = trimmedString(item?.directory);
    const title = trimmedString(item?.title) ? truncateTitle(item.title.trim()) : null;

    if (!SESSION_UUID_RE.test(foreignSessionId)) {
      addFailure({
        foreignSessionId: foreignSessionId || null,
        directory: directory || null,
        error: 'foreignSessionId must be a Claude session UUID',
        code: 'SESSION_ID_INVALID',
      });
      continue;
    }

    if (!directory) {
      addFailure({
        foreignSessionId, directory: null, error: 'directory is required', code: 'DIRECTORY_REQUIRED',
      });
      continue;
    }

    if (boundForeignIds.has(foreignSessionId)) {
      summary.skipped += 1;
      results.push({
        ok: true,
        foreignSessionId,
        sessionId: boundForeignIds.get(foreignSessionId),
        directory,
        status: 'skipped',
        reason: 'already-bound',
      });
      continue;
    }

    if (!knownForeignSessionIds.has(foreignSessionId)) {
      addFailure({
        foreignSessionId,
        directory,
        error: 'No Claude transcript exists for this session id',
        code: 'SESSION_NOT_FOUND',
      });
      continue;
    }

    if (!(await directoryExists(directory))) {
      addFailure({
        foreignSessionId,
        directory,
        error: 'Project directory does not exist on this host',
        code: 'DIRECTORY_MISSING',
      });
      continue;
    }

    let sessionId;
    try {
      sessionId = trimmedString(await createSession(directory, title));
    } catch (error) {
      addFailure({
        foreignSessionId,
        directory,
        error: error?.message || 'Failed to create OpenCode session',
        code: error?.code || 'SESSION_CREATE_FAILED',
      });
      continue;
    }

    if (!sessionId) {
      addFailure({
        foreignSessionId,
        directory,
        error: 'OpenCode session create returned no id',
        code: 'SESSION_CREATE_FAILED',
      });
      continue;
    }

    try {
      const { binding, conflict } = bind({
        sessionId,
        harnessId: 'claude-code',
        directory,
        target: { harnessId: 'claude-code', modelRef: defaultModelRef },
        foreignSessionId,
        capabilitySnapshot,
      });
      if (conflict) {
        addFailure({
          foreignSessionId,
          sessionId,
          directory,
          error: 'Session already bound to a different engine',
          code: 'BINDING_CONFLICT',
        });
        continue;
      }
      boundForeignIds.set(foreignSessionId, binding.sessionId);
      summary.imported += 1;
      results.push({
        ok: true, foreignSessionId, sessionId: binding.sessionId, directory, title, status: 'imported',
      });
    } catch (error) {
      addFailure({
        foreignSessionId,
        sessionId,
        directory,
        error: error?.message || 'Failed to bind Claude session',
        code: error?.code || 'BINDING_FAILED',
      });
    }
  }

  try {
    flush();
  } catch {
    // binding flush failure must not hide per-item results
  }

  return { results, summary };
}

/**
 * Build an OpenCode session creator using the harness OpenCode URL helpers.
 *
 * @param {object} deps
 * @param {(path: string, directory?: string) => string} deps.buildOpenCodeUrl
 * @param {() => Record<string, string>} [deps.getOpenCodeAuthHeaders]
 * @param {typeof createOpencodeClient} [deps.createClient]
 * @returns {(directory: string, title?: string | null) => Promise<string>}
 */
export function createOpenCodeSessionFactory(deps) {
  const buildOpenCodeUrl = deps.buildOpenCodeUrl;
  const getOpenCodeAuthHeaders = typeof deps.getOpenCodeAuthHeaders === 'function'
    ? deps.getOpenCodeAuthHeaders
    : () => ({});
  const createClient = deps.createClient || createOpencodeClient;

  return async (directory, title) => {
    if (typeof buildOpenCodeUrl !== 'function') {
      throw codedError('OpenCode URL builder is unavailable', 'OPENCODE_UNAVAILABLE', 503);
    }
    const client = createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
    const response = await client.session.create({ directory, ...(title ? { title } : {}) });
    const sessionId = trimmedString(response?.data?.id);
    if (!sessionId) {
      throw codedError('failed to create session', 'SESSION_CREATE_FAILED', 502);
    }
    return sessionId;
  };
}
