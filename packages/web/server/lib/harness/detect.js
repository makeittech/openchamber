/**
 * Harness runtime detection: binary presence + best-effort login probe.
 * Failure must never masquerade as ready with an empty catalog.
 */

import { spawnSync } from 'node:child_process';
import {
  CLAUDE_CODE_MODELS,
  getHarnessDescriptor,
  isKnownHarnessId,
  listHarnessDescriptors,
} from './registry.js';
import { findBinaryOnPath } from './binary-path.js';
import { probeClaudeAgentSdk } from './translators/claude-code/query.js';
import { buildClaudeCodeChildEnv } from './translators/claude-code/auth-env.js';
import { hasClaudeCliOAuthCredentials } from '@openchamber/quota-core';

export { findBinaryOnPath } from './binary-path.js';

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

  // API-key / console auth is not Claude subscription login for the harness.
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
 * then `CLAUDE_CODE_OAUTH_TOKEN` / credentials-file OAuth presence.
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
  const env = options.env || process.env;
  const probeAuthStatus = options.probeAuthStatus || (() => {
    const binaryPath = options.binaryPath
      || findBinaryOnPath('claude');
    if (!binaryPath) return null;
    return probeClaudeAuthStatusCli({
      binaryPath,
      env,
    });
  });

  const status = probeAuthStatus();
  // Authoritative CLI status wins when it confirms login.
  if (status?.loggedIn) {
    return status;
  }

  const hasCredentials = options.hasCredentials
    || (() => hasClaudeCliOAuthCredentials({ homeDir: options.homeDir, env }));

  // Env token / credentials file still count as subscription auth when the CLI
  // probe is unavailable, or when it reports logged-out while a Cursor/CI
  // `CLAUDE_CODE_OAUTH_TOKEN` secret is present for this host.
  if (hasCredentials()) {
    const fromEnv = typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string'
      && env.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0;
    return {
      loggedIn: true,
      detail: fromEnv ? 'env-oauth-token' : 'credentials-oauth-present',
      authMethod: fromEnv ? 'oauth_token_env' : 'oauth_credentials_file',
    };
  }

  if (status) {
    return status;
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
        descriptor,
        status: 'missing-cli',
        statusDetail: 'Claude CLI (`claude`) was not found on PATH',
        sections: [],
      };
    }

    const sdk = await probeSdk();
    if (!sdk.available) {
      return {
        descriptor,
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
        descriptor,
        status: 'needs-login',
        statusDetail: apiKeyOnly
          ? 'Claude Code API-key auth was detected, but this harness requires a Claude subscription login. Run `claude auth login`, then re-detect.'
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
      descriptor,
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
      descriptor,
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
    descriptor,
    status: ready ? 'ready' : 'error',
    statusDetail: ready ? undefined : 'OpenCode lifecycle is not ready',
    sections: [],
  };
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
