import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'linear-auth.json');
const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');

// A token expiring within this window is treated as expired and refreshed
// before use, so in-flight requests do not race the real expiry instant.
const EXPIRY_SKEW_MS = 60_000;

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

function writeJsonAtomic(file, payload) {
  ensureStorageDir();
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

const normalizeUser = (user) => {
  if (!user || typeof user !== 'object') return null;
  return {
    id: typeof user.id === 'string' ? user.id : null,
    name: typeof user.name === 'string' ? user.name : null,
    displayName: typeof user.displayName === 'string' ? user.displayName : null,
    email: typeof user.email === 'string' ? user.email : null,
    avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
  };
};

const normalizeOrganization = (organization) => {
  if (!organization || typeof organization !== 'object') return null;
  return {
    id: typeof organization.id === 'string' ? organization.id : null,
    name: typeof organization.name === 'string' ? organization.name : null,
    urlKey: typeof organization.urlKey === 'string' ? organization.urlKey : null,
  };
};

function normalizeAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const accessToken = typeof entry.accessToken === 'string' ? entry.accessToken : '';
  if (!accessToken) return null;
  return {
    accessToken,
    kind: entry.kind === 'api_key' ? 'api_key' : 'oauth',
    refreshToken: typeof entry.refreshToken === 'string' && entry.refreshToken ? entry.refreshToken : null,
    tokenType: typeof entry.tokenType === 'string' ? entry.tokenType : 'Bearer',
    scope: typeof entry.scope === 'string' ? entry.scope : '',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null,
    user: normalizeUser(entry.user),
    organization: normalizeOrganization(entry.organization),
  };
}

export function getLinearAuth() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8').trim();
    if (!raw) {
      return null;
    }
    return normalizeAuthEntry(JSON.parse(raw));
  } catch (error) {
    console.error('[linear] Failed to read auth file:', error?.message || error);
    return null;
  }
}

export function setLinearAuth(entry) {
  const normalized = normalizeAuthEntry({ ...entry, createdAt: entry?.createdAt ?? Date.now() });
  if (!normalized) {
    throw new Error('accessToken is required');
  }
  writeJsonAtomic(STORAGE_FILE, normalized);
  return normalized;
}

export function clearLinearAuth() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      fs.unlinkSync(STORAGE_FILE);
    }
    return true;
  } catch (error) {
    console.error('[linear] Failed to clear auth file:', error?.message || error);
    return false;
  }
}

export function isLinearAuthExpired(auth, nowMs = Date.now()) {
  if (!auth?.accessToken) return true;
  if (typeof auth.expiresAt !== 'number') return false;
  return auth.expiresAt <= nowMs + EXPIRY_SKEW_MS;
}

function readSettingsFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
    }
  } catch {
    // ignore
  }
  return {};
}

// Automation toggles live in settings.json next to the other Linear keys.
// Defaults: moving the issue to "In Progress" on session start is safe and
// expected; auto-closing it when a session goes idle is not (idle fires after
// every agent turn, not when the issue is actually done), so it is opt-in.
const DEFAULT_AUTOMATION_SETTINGS = {
  moveToInProgressOnStart: true,
  moveToDoneOnComplete: false,
};

export function getLinearAutomationSettings() {
  const settings = readSettingsFile();
  return {
    moveToInProgressOnStart: typeof settings.linearMoveToInProgressOnStart === 'boolean'
      ? settings.linearMoveToInProgressOnStart
      : DEFAULT_AUTOMATION_SETTINGS.moveToInProgressOnStart,
    moveToDoneOnComplete: typeof settings.linearMoveToDoneOnComplete === 'boolean'
      ? settings.linearMoveToDoneOnComplete
      : DEFAULT_AUTOMATION_SETTINGS.moveToDoneOnComplete,
  };
}

export function setLinearAutomationSettings(patch) {
  const current = getLinearAutomationSettings();
  const next = {
    moveToInProgressOnStart: typeof patch?.moveToInProgressOnStart === 'boolean'
      ? patch.moveToInProgressOnStart
      : current.moveToInProgressOnStart,
    moveToDoneOnComplete: typeof patch?.moveToDoneOnComplete === 'boolean'
      ? patch.moveToDoneOnComplete
      : current.moveToDoneOnComplete,
  };
  const settings = readSettingsFile();
  settings.linearMoveToInProgressOnStart = next.moveToInProgressOnStart;
  settings.linearMoveToDoneOnComplete = next.moveToDoneOnComplete;
  writeJsonAtomic(SETTINGS_FILE, settings);
  return next;
}

// OAuth client credentials resolve from the environment first, then from
// settings.json (linearClientId / linearClientSecret). They never leave the
// server: the auth status endpoint only reports whether they are configured.
export function getLinearClientConfig() {
  const settings = readSettingsFile();
  const clientId = (typeof process.env.OPENCHAMBER_LINEAR_CLIENT_ID === 'string'
    && process.env.OPENCHAMBER_LINEAR_CLIENT_ID.trim())
    || (typeof settings.linearClientId === 'string' ? settings.linearClientId.trim() : '')
    || '';
  const clientSecret = (typeof process.env.OPENCHAMBER_LINEAR_CLIENT_SECRET === 'string'
    && process.env.OPENCHAMBER_LINEAR_CLIENT_SECRET.trim())
    || (typeof settings.linearClientSecret === 'string' ? settings.linearClientSecret.trim() : '')
    || '';
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

export const LINEAR_AUTH_FILE = STORAGE_FILE;
