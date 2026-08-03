import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

function readAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed);
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
}

/** Best-effort restrictive permissions; platforms without chmod just skip. */
function restrictPermissions(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // best-effort
  }
}

function writeAuthFile(auth) {
  // This file holds provider OAuth access/refresh tokens, so it is written
  // owner-only and atomically — a partial write would strand the user without
  // credentials, and a default-mode write would leave tokens group/world readable.
  const tempFile = `${AUTH_FILE}.openchamber.tmp`;
  try {
    if (!fs.existsSync(OPENCODE_DATA_DIR)) {
      fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true, mode: 0o700 });
    }

    if (fs.existsSync(AUTH_FILE)) {
      const backupFile = `${AUTH_FILE}.openchamber.backup`;
      fs.copyFileSync(AUTH_FILE, backupFile);
      restrictPermissions(backupFile, 0o600);
      console.log(`Created auth backup: ${backupFile}`);
    }

    fs.writeFileSync(tempFile, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
    restrictPermissions(tempFile, 0o600);
    fs.renameSync(tempFile, AUTH_FILE);
    restrictPermissions(AUTH_FILE, 0o600);
    console.log('Successfully wrote auth file');
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // leave the temp file rather than mask the original failure
    }
    console.error('Failed to write auth file:', error);
    throw new Error('Failed to write OpenCode auth configuration');
  }
}

function removeProviderAuth(providerId) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const auth = readAuthFile();
  
  if (!auth[providerId]) {
    console.log(`Provider ${providerId} not found in auth file, nothing to remove`);
    return false;
  }

  delete auth[providerId];
  writeAuthFile(auth);
  console.log(`Removed provider auth: ${providerId}`);
  return true;
}

function getProviderAuth(providerId) {
  const auth = readAuthFile();
  return auth[providerId] || null;
}

function listProviderAuths() {
  const auth = readAuthFile();
  return Object.keys(auth);
}

export {
  readAuthFile,
  writeAuthFile,
  removeProviderAuth,
  getProviderAuth,
  listProviderAuths,
  AUTH_FILE,
  OPENCODE_DATA_DIR
};
