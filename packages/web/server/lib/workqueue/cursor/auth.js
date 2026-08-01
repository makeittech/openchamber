import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'cursor-auth.json');
const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');

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

// Resolution order mirrors the Linear/GitHub OAuth client credential
// precedent: environment override first (deployment-level), then
// settings.json (per-user, set from the Settings UI).
export function getCursorApiKey() {
  const envKey = typeof process.env.OPENCHAMBER_CURSOR_API_KEY === 'string'
    ? process.env.OPENCHAMBER_CURSOR_API_KEY.trim()
    : '';
  if (envKey) return envKey;
  try {
    if (!fs.existsSync(STORAGE_FILE)) return '';
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8').trim();
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    return typeof parsed?.apiKey === 'string' ? parsed.apiKey : '';
  } catch (error) {
    console.error('[workqueue] Failed to read Cursor auth file:', error?.message || error);
    return '';
  }
}

export function isCursorConfiguredViaEnv() {
  return Boolean(process.env.OPENCHAMBER_CURSOR_API_KEY?.trim());
}

export function setCursorApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('apiKey is required');
  }
  writeJsonAtomic(STORAGE_FILE, { apiKey: apiKey.trim() });
  return true;
}

export function clearCursorApiKey() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      fs.unlinkSync(STORAGE_FILE);
    }
    return true;
  } catch (error) {
    console.error('[workqueue] Failed to clear Cursor auth file:', error?.message || error);
    return false;
  }
}

export const CURSOR_AUTH_FILE = STORAGE_FILE;
