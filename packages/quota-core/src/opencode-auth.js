/**
 * Default reader/writer for OpenCode's shared `auth.json`
 * (`~/.local/share/opencode/auth.json`), used only as the built-in default
 * for `ensureClaudeUsageAccessToken`'s `readAuth`/`writeAuth` options.
 *
 * Hosts that already own an auth.json accessor (the web server has one at
 * `packages/web/server/lib/opencode/auth.js`, reused by every other quota
 * provider) should keep passing their own `readAuth`/`writeAuth` so this
 * package never becomes a second, drifting copy of that file's behavior.
 * Hosts with no such accessor (the VS Code extension) can rely on this
 * default.
 *
 * Writes are atomic (temp file + rename) and owner-only (0600), with a
 * best-effort `.openchamber.backup` copy of the previous contents — this is
 * the invariant callers depend on for credential persistence safety.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

/** Best-effort restrictive permissions; platforms without chmod just skip. */
function restrictPermissions(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // best-effort
  }
}

/**
 * @returns {Record<string, unknown>}
 */
export function readOpenCodeAuthFile() {
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
    throw new Error('Failed to read OpenCode auth configuration', { cause: error });
  }
}

/**
 * @param {Record<string, unknown>} auth
 */
export function writeOpenCodeAuthFile(auth) {
  const tempFile = `${AUTH_FILE}.openchamber.tmp`;
  try {
    if (!fs.existsSync(OPENCODE_DATA_DIR)) {
      fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true, mode: 0o700 });
    }

    if (fs.existsSync(AUTH_FILE)) {
      const backupFile = `${AUTH_FILE}.openchamber.backup`;
      fs.copyFileSync(AUTH_FILE, backupFile);
      restrictPermissions(backupFile, 0o600);
    }

    fs.writeFileSync(tempFile, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
    restrictPermissions(tempFile, 0o600);
    fs.renameSync(tempFile, AUTH_FILE);
    restrictPermissions(AUTH_FILE, 0o600);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // leave the temp file rather than mask the original failure
    }
    throw new Error('Failed to write OpenCode auth configuration', { cause: error });
  }
}
