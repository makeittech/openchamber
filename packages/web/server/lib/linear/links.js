import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'linear-sessions.json');
const MAX_LINKS = 500;

const SESSION_LINK_STATUSES = ['started', 'completed', 'error', 'attention'];

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

const normalizeStatus = (status) => (
  SESSION_LINK_STATUSES.includes(status) ? status : 'started'
);

const normalizeLink = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const issueId = typeof entry.issueId === 'string' ? entry.issueId : '';
  const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : '';
  if (!issueId || !sessionId) return null;
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomBytes(8).toString('hex'),
    issueId,
    issueIdentifier: typeof entry.issueIdentifier === 'string' ? entry.issueIdentifier : '',
    issueTitle: typeof entry.issueTitle === 'string' ? entry.issueTitle : '',
    issueUrl: typeof entry.issueUrl === 'string' ? entry.issueUrl : '',
    teamId: typeof entry.teamId === 'string' ? entry.teamId : '',
    sessionId,
    directory: typeof entry.directory === 'string' ? entry.directory : '',
    sessionTitle: typeof entry.sessionTitle === 'string' ? entry.sessionTitle : '',
    sessionUrl: typeof entry.sessionUrl === 'string' ? entry.sessionUrl : '',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    status: normalizeStatus(entry.status),
    statusUpdatedAt: typeof entry.statusUpdatedAt === 'number' ? entry.statusUpdatedAt : null,
    // Terminal lifecycle states already reported to Linear; guards against
    // duplicate comments when OpenCode emits repeated idle/error events.
    notifiedStatuses: Array.isArray(entry.notifiedStatuses)
      ? entry.notifiedStatuses.filter((status) => SESSION_LINK_STATUSES.includes(status))
      : [],
  };
};

function readStore() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.links) ? parsed.links : [];
    return list.map(normalizeLink).filter(Boolean);
  } catch (error) {
    console.error('[linear] Failed to read session links:', error?.message || error);
    return [];
  }
}

function writeStore(links) {
  ensureStorageDir();
  const pruned = links
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_LINKS);
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ links: pruned }, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

export function listSessionLinks({ issueId, sessionId } = {}) {
  const links = readStore();
  if (typeof issueId === 'string' && issueId) {
    return links.filter((link) => link.issueId === issueId);
  }
  if (typeof sessionId === 'string' && sessionId) {
    return links.filter((link) => link.sessionId === sessionId);
  }
  return links;
}

export function getSessionLink(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return readStore().find((link) => link.sessionId === sessionId) ?? null;
}

// One link per session: re-attaching a session to an issue replaces the
// previous record instead of accumulating duplicates.
export function addSessionLink(link) {
  const normalized = normalizeLink(link);
  if (!normalized) {
    throw new Error('issueId and sessionId are required');
  }
  const links = readStore().filter((entry) => entry.sessionId !== normalized.sessionId);
  links.push(normalized);
  writeStore(links);
  return normalized;
}

export function updateSessionLink(sessionId, patch) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const links = readStore();
  const index = links.findIndex((link) => link.sessionId === sessionId);
  if (index === -1) return null;
  const current = links[index];
  const notified = Array.isArray(patch?.notifiedStatuses)
    ? patch.notifiedStatuses.filter((status) => SESSION_LINK_STATUSES.includes(status))
    : current.notifiedStatuses;
  const next = normalizeLink({
    ...current,
    ...patch,
    sessionId,
    notifiedStatuses: notified,
  });
  links[index] = next;
  writeStore(links);
  return next;
}

const LINEAR_SESSIONS_FILE = STORAGE_FILE;
