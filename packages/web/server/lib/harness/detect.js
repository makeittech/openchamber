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

  if (normalized === 'none' || normalized.includes('api') || normalized.includes('console')) {
    return { loggedIn: false, detail: 'api-key-only', authMethod };
  }

  const subscription = ['oauth', 'claude', 'subscription'].some((hint) => normalized.includes(hint));
  return {
    loggedIn: true,
    detail: subscription ? 'auth-status-oauth' : 'auth-status-logged-in',
    authMethod,
  };
}

/** Parses CLI stdout that may wrap its JSON object in extra log lines. */
function parseJsonObjectLoosely(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

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
  if (status?.loggedIn) {
    return status;
  }

  const hasCredentials = options.hasCredentials
    || (() => hasClaudeCliOAuthCredentials({ homeDir: options.homeDir, env }));

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

function claudeModelSections() {
  return [{
    id: 'models',
    name: 'Models',
    kind: 'models',
    models: [...CLAUDE_CODE_MODELS],
  }];
}

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
        sections: claudeModelSections(),
      };
    }

    return {
      descriptor,
      status: 'ready',
      statusDetail: undefined,
      version,
      sections: claudeModelSections(),
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

export async function detectHarness(harnessId, options = {}) {
  if (!isKnownHarnessId(harnessId)) return null;
  if (harnessId === 'opencode') return detectOpenCode(options);
  if (harnessId === 'claude-code') return detectClaudeCode(options);
  return null;
}

export async function detectAllHarnesses(options = {}) {
  const results = [];
  for (const descriptor of listHarnessDescriptors()) {
    const detected = await detectHarness(descriptor.id, options);
    if (detected) results.push(detected);
  }
  return results;
}
