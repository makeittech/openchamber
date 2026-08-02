/**
 * Thin wrapper around @anthropic-ai/claude-agent-sdk query()/interrupt.
 * Import failure is surfaced as unavailable — detect must not report ready.
 */

import { spawnSync } from 'node:child_process';
import { buildClaudeCodeChildEnv } from './auth-env.js';
import { isClaudeEffort } from '../../registry.js';
import {
  assertClaudeWorkingDirectory,
  resolveClaudeCodeExecutable,
} from './executable-path.js';

/**
 * Claude permission mode is inherited from the selected agent's edit permission
 * on every send (`claudePermissionModeFromEditPermission`), never configured on
 * its own. These are the only three values that mapping can produce.
 *
 * Auto-approve is a separate mechanism that answers the `canUseTool` bridge, so
 * a bypass mode must never be forwarded — it would defeat that bridge entirely.
 */
const ALLOWED_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);

/** Trimmed string, or `''` for anything that is not a string. */
const trimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

/** A plain object with at least one own key, otherwise `null`. */
function nonEmptyRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value).length > 0 ? value : null;
}

let sdkModulePromise = null;
/** @type {Error | null} */
let sdkLoadError = null;
/** @type {typeof import('@anthropic-ai/claude-agent-sdk') | null} */
let sdkModule = null;

/**
 * @returns {Promise<typeof import('@anthropic-ai/claude-agent-sdk')>}
 */
export async function loadClaudeAgentSdk() {
  if (sdkModule) return sdkModule;
  if (sdkLoadError) throw sdkLoadError;
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk')
      .then((mod) => {
        sdkModule = mod;
        return mod;
      })
      .catch((error) => {
        sdkLoadError = error instanceof Error
          ? error
          : new Error(String(error?.message || error || 'Failed to load Claude Agent SDK'));
        sdkModulePromise = null;
        throw sdkLoadError;
      });
  }
  return sdkModulePromise;
}

/**
 * Reset cached SDK load state (tests only).
 */
export function resetClaudeAgentSdkCache() {
  sdkModule = null;
  sdkModulePromise = null;
  sdkLoadError = null;
}

/**
 * Best-effort probe whether the SDK package can be imported.
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
export async function probeClaudeAgentSdk() {
  try {
    await loadClaudeAgentSdk();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : 'Claude Agent SDK unavailable',
    };
  }
}

/**
 * Tree-kill a process (and process group when possible).
 * @param {number | null | undefined} pid
 * @param {{ signal?: NodeJS.Signals, force?: boolean }} [options]
 */
export function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const signal = options.signal || 'SIGTERM';
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // best-effort
    }
    return;
  }

  // Every kill is best-effort: the group may not exist and the child may
  // already be gone.
  const kill = (target, killSignal) => {
    try {
      process.kill(target, killSignal);
    } catch {}
  };

  kill(-pid, signal);
  kill(pid, signal);
  if (options.force) {
    kill(-pid, 'SIGKILL');
    kill(pid, 'SIGKILL');
  }
}

/**
 * @typedef {object} ClaudeQueryHandle
 * @property {AsyncIterable<unknown>} stream
 * @property {() => Promise<void>} interrupt
 * @property {() => void} close
 * @property {() => number | null | undefined} getPid
 */

/**
 * Start a Claude Agent SDK query with subscription-only env.
 *
 * @param {object} params
 * @param {string | AsyncIterable<unknown>} params.prompt
 * @param {string} params.cwd
 * @param {string} [params.model]
 * @param {string} [params.resume]
 * @param {string} [params.permissionMode]
 * @param {string} [params.effort]
 * @param {string | { type: 'preset', preset: 'claude_code', append?: string }} [params.systemPrompt]
 * @param {(toolName: string, input: Record<string, unknown>, options: object) => Promise<object | null>} [params.canUseTool]
 * @param {Record<string, string | undefined>} [params.env]
 * @param {boolean} [params.includePartialMessages]
 * @param {Record<string, unknown>} [params.mcpServers]
 * @param {Record<string, object>} [params.agents]
 * @param {string} [params.agent]
 * @param {string[]} [params.allowedTools]
 * @param {string[] | 'all'} [params.skills]
 * @param {Array<'user' | 'project' | 'local'>} [params.settingSources]
 * @param {boolean} [params.forwardSubagentText]
 * @param {boolean} [params.agentProgressSummaries]
 * @param {Partial<Record<import('@anthropic-ai/claude-agent-sdk').HookEvent, import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher[]>>} [params.hooks]
 *   Server-internal SDK hook callbacks (e.g. the recovery `PreToolUse`
 *   fingerprint guard). NOT sourced from any client body — only the translator
 *   may supply it, so the public prompt route cannot inject hooks. Only
 *   forwarded when non-empty.
 * @param {(mod: typeof import('@anthropic-ai/claude-agent-sdk')) => unknown} [params.queryImpl]
 * @returns {Promise<ClaudeQueryHandle>}
 */
export async function startClaudeQuery(params) {
  const sdk = await loadClaudeAgentSdk();
  const queryFn = typeof params.queryImpl === 'function' ? params.queryImpl : sdk.query;

  if (typeof queryFn !== 'function') {
    const error = new Error('Claude Agent SDK query() is unavailable');
    error.code = 'CLAUDE_SDK_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }

  const env = buildClaudeCodeChildEnv(params.env || process.env);
  const cwd = assertClaudeWorkingDirectory(params.cwd);
  const pathToClaudeCodeExecutable = trimmedString(params.pathToClaudeCodeExecutable)
    || resolveClaudeCodeExecutable({ env });

  const options = {
    cwd,
    env,
    includePartialMessages: params.includePartialMessages !== false,
    // Nested Agent transcripts + progress so OpenChamber can render subagents.
    forwardSubagentText: params.forwardSubagentText !== false,
    agentProgressSummaries: params.agentProgressSummaries !== false,
    // Load user/project/local Claude settings so .claude/{commands,agents,skills}
    // and project .mcp.json participate (matches CLI defaults when omitted, but
    // set explicitly so capability "full" is intentional).
    settingSources: Array.isArray(params.settingSources)
      ? params.settingSources
      : ['user', 'project', 'local'],
  };
  if (pathToClaudeCodeExecutable) {
    // Avoid Electron asar ENOTDIR when the SDK resolves a path inside app.asar.
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  }
  const model = trimmedString(params.model);
  if (model) options.model = model;
  const resume = trimmedString(params.resume);
  if (resume) options.resume = resume;
  // Fail closed: only modes the UI can legitimately produce are forwarded. A
  // client-supplied `bypassPermissions` must never bypass the canUseTool bridge.
  const permissionMode = trimmedString(params.permissionMode);
  if (ALLOWED_PERMISSION_MODES.has(permissionMode)) {
    options.permissionMode = permissionMode;
  }
  // The SDK forwards this as the CLI's `--effort <level>` flag, so an
  // unrecognized level fails the whole turn instead of the control silently
  // doing nothing. Drop anything outside the registry list and let the SDK
  // default apply.
  const effort = trimmedString(params.effort);
  if (isClaudeEffort(effort)) options.effort = effort;
  if (typeof params.canUseTool === 'function') options.canUseTool = params.canUseTool;
  // System prompt: string custom, or Claude Code preset (+ optional OpenCode agent append).
  const customSystemPrompt = trimmedString(params.systemPrompt);
  const presetSystemPrompt = typeof params.systemPrompt === 'string'
    ? null
    : nonEmptyRecord(params.systemPrompt);
  if (customSystemPrompt) {
    options.systemPrompt = customSystemPrompt;
  } else if (presetSystemPrompt?.type === 'preset' && presetSystemPrompt.preset === 'claude_code') {
    /** @type {{ type: 'preset', preset: 'claude_code', append?: string }} */
    const systemPrompt = { type: 'preset', preset: 'claude_code' };
    const append = trimmedString(presetSystemPrompt.append);
    if (append) systemPrompt.append = append;
    options.systemPrompt = systemPrompt;
  }
  if (nonEmptyRecord(params.mcpServers)) options.mcpServers = params.mcpServers;
  // Programmatic subagents (OpenCode agents inherited for this turn). The SDK
  // merges these with on-disk `.claude/agents`, so registering none leaves the
  // native Claude set untouched.
  if (nonEmptyRecord(params.agents)) options.agents = params.agents;
  // Main-thread agent by name. Only forwarded when the agent is registered
  // above or expected in settings — an unknown name would fail the turn.
  const mainAgent = trimmedString(params.agent);
  if (mainAgent) options.agent = mainAgent;
  if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
    options.allowedTools = params.allowedTools.filter((tool) => typeof tool === 'string' && tool.trim());
  }
  if (params.skills === 'all' || (Array.isArray(params.skills) && params.skills.length > 0)) {
    options.skills = params.skills;
  } else if (params.skills === undefined) {
    // Enable every discovered skill so /skill and Skill tool work on Claude sessions.
    options.skills = 'all';
  }
  // Internal SDK hook callbacks (e.g. the recovery PreToolUse fingerprint
  // guard). This parameter is server-internal only: the public prompt route
  // never supplies it, and `startClaudeQuery` reads it solely from the
  // top-level `params.hooks` — never from a nested client body — so a client
  // cannot inject hooks through the prompt route. Only forward when non-empty
  // to avoid an accidental empty object overriding SDK defaults.
  if (nonEmptyRecord(params.hooks)) options.hooks = params.hooks;

  let result;
  try {
    result = queryFn({ prompt: params.prompt, options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOTDIR' || /spawn.*ENOTDIR/i.test(message)) {
      const wrapped = new Error(
        'Claude Code executable path is not spawnable (ENOTDIR). '
        + 'Packaged Desktop must use PATH/`app.asar.unpacked` Claude CLI, not an `app.asar` path.',
      );
      wrapped.code = 'CLAUDE_SPAWN_ENOTDIR';
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  let closed = false;
  const getPid = () => (result && typeof result === 'object' && 'pid' in result ? result.pid : null);

  const interrupt = async () => {
    if (result && typeof result.interrupt === 'function') {
      try {
        await result.interrupt();
      } catch {
        // fall through to tree-kill
      }
    }
    killProcessTree(getPid(), { signal: 'SIGTERM' });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    killProcessTree(getPid(), { signal: 'SIGTERM', force: true });
    if (result && typeof result.return === 'function') {
      try {
        // Must swallow the rejection too — an unhandled one would take the
        // whole server process down.
        Promise.resolve(result.return()).catch(() => {});
      } catch {
        // ignore
      }
    }
  };

  return { stream: result, interrupt, close, getPid };
}
