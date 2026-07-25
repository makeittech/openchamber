/**
 * Harness runtime detection: binary presence + best-effort login probe.
 * Failure must never masquerade as ready with an empty catalog.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CLAUDE_CODE_MODELS,
  getHarnessDescriptor,
  isKnownHarnessId,
  listHarnessDescriptors,
} from './registry.js';
import { probeClaudeAgentSdk } from './translators/claude-code/query.js';
import { buildClaudeCodeChildEnv } from './translators/claude-code/auth-env.js';
import { hasClaudeCliOAuthCredentials } from '../quota/providers/claude-cli-auth.js';
import {
  hasCursorCredentials,
  resolveCursorAccessToken,
} from './translators/cursor/credentials.js';
import { FALLBACK_MODELS, getCursorModels } from './translators/cursor/models.js';

/**
 * @param {string} binaryName
 * @param {string} [searchPath]
 * @returns {string | null}
 */
export function findBinaryOnPath(binaryName, searchPath = process.env.PATH || '') {
  const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
  if (!trimmed) return null;

  const parts = searchPath.split(path.delimiter).filter(Boolean);
  const candidateNames = [];

  if (process.platform === 'win32' && !path.extname(trimmed)) {
    const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    for (const ext of pathExt.split(';')) {
      const normalizedExt = ext.trim();
      if (!normalizedExt) continue;
      const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
      if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
        candidateNames.push(candidateName);
      }
    }
  }
  candidateNames.push(trimmed);

  for (const dir of parts) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}

/**
 * Interpret `claude auth status --json` without treating API-key-only as ready.
 *
 * @param {unknown} payload
 * @returns {{ loggedIn: boolean, detail?: string, authMethod?: string }}
 */
export function interpretClaudeAuthStatus(payload) {
  if (!payload || typeof payload !== 'object') {
    return { loggedIn: false, detail: 'invalid-auth-status' };
  }

  const root = /** @type {Record<string, unknown>} */ (payload);
  const loggedIn = Boolean(root.loggedIn);
  const authMethod = typeof root.authMethod === 'string' ? root.authMethod : 'none';
  const normalized = authMethod.trim().toLowerCase();

  if (!loggedIn) {
    return { loggedIn: false, detail: 'auth-status-logged-out', authMethod };
  }

  // API-key / console auth is not Claude subscription login for the engine.
  if (
    normalized === 'none'
    || normalized.includes('api')
    || normalized.includes('console')
    || normalized === 'api_key'
    || normalized === 'apikey'
  ) {
    return { loggedIn: false, detail: 'api-key-only', authMethod };
  }

  if (
    normalized.includes('oauth')
    || normalized.includes('claude')
    || normalized.includes('subscription')
  ) {
    return { loggedIn: true, detail: 'auth-status-oauth', authMethod };
  }

  // loggedIn + unknown method: accept (CLI may omit subscriptionType).
  return { loggedIn: true, detail: 'auth-status-logged-in', authMethod };
}

/**
 * Run `claude auth status --json` with subscription-only child env.
 *
 * @param {{
 *   binaryPath: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawnSyncFn?: typeof spawnSync,
 * }} options
 * @returns {{ loggedIn: boolean, detail?: string, authMethod?: string } | null}
 */
export function probeClaudeAuthStatusCli(options) {
  const binaryPath = typeof options.binaryPath === 'string' ? options.binaryPath.trim() : '';
  if (!binaryPath) return null;

  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  try {
    const result = spawnSyncFn(binaryPath, ['auth', 'status', '--json'], {
      encoding: 'utf8',
      timeout: 6000,
      env: buildClaudeCodeChildEnv(options.env || process.env),
      windowsHide: true,
    });

    const output = `${result.stdout || ''}`.trim();
    if (!output) {
      return { loggedIn: false, detail: 'auth-status-empty' };
    }

    let payload;
    try {
      payload = JSON.parse(output);
    } catch {
      // Some builds may wrap JSON; try first `{...}` slice.
      const start = output.indexOf('{');
      const end = output.lastIndexOf('}');
      if (start < 0 || end <= start) {
        return { loggedIn: false, detail: 'auth-status-parse-error' };
      }
      try {
        payload = JSON.parse(output.slice(start, end + 1));
      } catch {
        return { loggedIn: false, detail: 'auth-status-parse-error' };
      }
    }

    return interpretClaudeAuthStatus(payload);
  } catch {
    return null;
  }
}

/**
 * Best-effort Claude subscription login probe (no secrets returned).
 * Prefers `claude auth status --json` (API keys stripped from child env),
 * then structured CLI credentials-file OAuth presence.
 *
 * @param {{
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   binaryPath?: string | null,
 *   probeAuthStatus?: () => ({ loggedIn: boolean, detail?: string, authMethod?: string } | null),
 *   hasCredentials?: () => boolean,
 * }} [options]
 * @returns {{ loggedIn: boolean, detail?: string, authMethod?: string }}
 */
export function probeClaudeLogin(options = {}) {
  const probeAuthStatus = options.probeAuthStatus || (() => {
    const binaryPath = options.binaryPath
      || findBinaryOnPath('claude');
    if (!binaryPath) return null;
    return probeClaudeAuthStatusCli({
      binaryPath,
      env: options.env,
    });
  });

  const status = probeAuthStatus();
  if (status) {
    return status;
  }

  const hasCredentials = options.hasCredentials
    || (() => hasClaudeCliOAuthCredentials({ homeDir: options.homeDir }));

  if (hasCredentials()) {
    return { loggedIn: true, detail: 'credentials-oauth-present' };
  }

  return { loggedIn: false, detail: 'no-credentials-file' };
}

/**
 * @param {string} binaryPath
 * @returns {string | undefined}
 */
function probeClaudeVersion(binaryPath) {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      env: buildClaudeCodeChildEnv(),
      windowsHide: true,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (!output) return undefined;
    const match = output.match(/(\d+\.\d+\.\d+[\w.-]*)/);
    return match?.[1] || output.split('\n')[0]?.slice(0, 80);
  } catch {
    return undefined;
  }
}

/**
 * @param {object} [options]
 * @param {() => string | null} [options.findClaudeBinary]
 * @param {(args?: { binaryPath?: string | null }) => { loggedIn: boolean, detail?: string }} [options.probeLogin]
 * @param {() => Promise<{ available: boolean, error?: string }>} [options.probeSdk]
 * @param {boolean} [options.openCodeReady]
 * @returns {Promise<object>}
 */
export async function detectClaudeCode(options = {}) {
  const findClaudeBinary = options.findClaudeBinary
    || (() => findBinaryOnPath('claude'));
  const probeSdk = options.probeSdk || (() => probeClaudeAgentSdk());
  const descriptor = getHarnessDescriptor('claude-code');

  try {
    const binaryPath = findClaudeBinary();
    if (!binaryPath) {
      return {
        engine: descriptor,
        status: 'missing-cli',
        statusDetail: 'Claude CLI (`claude`) was not found on PATH',
        sections: [],
      };
    }

    const sdk = await probeSdk();
    if (!sdk.available) {
      return {
        engine: descriptor,
        status: 'error',
        statusDetail: sdk.error || 'Claude Agent SDK is unavailable',
        version: probeClaudeVersion(binaryPath),
        sections: [],
      };
    }

    const probeLogin = options.probeLogin
      || ((args = {}) => probeClaudeLogin({ binaryPath: args.binaryPath ?? binaryPath }));
    const login = probeLogin({ binaryPath });
    const version = probeClaudeVersion(binaryPath);

    if (!login.loggedIn) {
      const apiKeyOnly = login.detail === 'api-key-only';
      return {
        engine: descriptor,
        status: 'needs-login',
        statusDetail: apiKeyOnly
          ? 'Claude Code API-key auth was detected, but this engine requires a Claude subscription login. Run `claude auth login`, then re-detect.'
          : 'Claude Code subscription login was not detected. Run `claude auth login`, then re-detect.',
        version,
        sections: [{
          id: 'models',
          name: 'Models',
          kind: 'models',
          models: [...CLAUDE_CODE_MODELS],
        }],
      };
    }

    return {
      engine: descriptor,
      status: 'ready',
      statusDetail: undefined,
      version,
      sections: [{
        id: 'models',
        name: 'Models',
        kind: 'models',
        models: [...CLAUDE_CODE_MODELS],
      }],
    };
  } catch (error) {
    return {
      engine: descriptor,
      status: 'error',
      statusDetail: error instanceof Error ? error.message : 'Claude Code detect failed',
      sections: [],
    };
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.openCodeReady]
 * @returns {object}
 */
export function detectOpenCode(options = {}) {
  const descriptor = getHarnessDescriptor('opencode');
  const ready = options.openCodeReady !== false;
  return {
    engine: descriptor,
    status: ready ? 'ready' : 'error',
    statusDetail: ready ? undefined : 'OpenCode lifecycle is not ready',
    sections: [],
  };
}

/**
 * Sanitize Cursor models for detect responses (ids/names only; no tokens).
 * @param {Array<{ id: string, name: string, reasoning?: boolean }>} models
 */
function toCursorModelCatalog(models) {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    supportsImages: false,
    supportsDocuments: false,
    reasoning: Boolean(model.reasoning),
  }));
}

/**
 * Detect Cursor engine readiness via OAuth credentials (no CLI binary).
 *
 * @param {object} [options]
 * @param {() => boolean} [options.hasCredentials]
 * @param {() => Promise<string | null>} [options.resolveAccessToken]
 * @param {(token: string) => Promise<object[]>} [options.fetchModels]
 * @returns {Promise<object>}
 */
export async function detectCursor(options = {}) {
  const descriptor = getHarnessDescriptor('cursor');
  const hasCredentials = options.hasCredentials || hasCursorCredentials;
  const resolveAccessToken = options.resolveAccessToken || resolveCursorAccessToken;
  const fetchModels = options.fetchModels || ((token) => getCursorModels(token));

  try {
    if (!hasCredentials()) {
      return {
        engine: descriptor,
        status: 'needs-login',
        statusDetail: 'Cursor OAuth login was not detected. Sign in via the Cursor engine login flow, then re-detect.',
        sections: [{
          id: 'models',
          name: 'Models',
          kind: 'models',
          models: toCursorModelCatalog(FALLBACK_MODELS),
        }],
      };
    }

    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      return {
        engine: descriptor,
        status: 'needs-login',
        statusDetail: 'Cursor credentials are missing or expired. Sign in again, then re-detect.',
        sections: [{
          id: 'models',
          name: 'Models',
          kind: 'models',
          models: toCursorModelCatalog(FALLBACK_MODELS),
        }],
      };
    }

    let models = FALLBACK_MODELS;
    try {
      const discovered = await fetchModels(accessToken);
      if (Array.isArray(discovered) && discovered.length > 0) {
        models = discovered;
      }
    } catch {
      models = FALLBACK_MODELS;
    }

    const catalog = toCursorModelCatalog(models);
    if (catalog.length === 0) {
      // Invariant: never ready + empty catalog.
      return {
        engine: descriptor,
        status: 'error',
        statusDetail: 'Cursor model catalog was empty',
        sections: [],
      };
    }

    // Never include tokens or credential material in detect responses.
    return {
      engine: descriptor,
      status: 'ready',
      statusDetail: undefined,
      sections: [{
        id: 'models',
        name: 'Models',
        kind: 'models',
        models: catalog,
      }],
    };
  } catch (error) {
    return {
      engine: descriptor,
      status: 'error',
      statusDetail: error instanceof Error ? error.message : 'Cursor detect failed',
      sections: [],
    };
  }
}

/**
 * @param {string} harnessId
 * @param {object} [options]
 * @returns {Promise<object | null>}
 */
export async function detectHarness(harnessId, options = {}) {
  if (!isKnownHarnessId(harnessId)) return null;
  if (harnessId === 'opencode') return detectOpenCode(options);
  if (harnessId === 'claude-code') return detectClaudeCode(options);
  if (harnessId === 'cursor') return detectCursor(options);
  return null;
}

/**
 * @param {object} [options]
 * @returns {Promise<object[]>}
 */
export async function detectAllHarnesses(options = {}) {
  const results = [];
  for (const descriptor of listHarnessDescriptors()) {
    const detected = await detectHarness(descriptor.id, options);
    if (detected) results.push(detected);
  }
  return results;
}
