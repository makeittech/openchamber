/**
 * Translate authoritative OpenCode command templates into Claude prompt text.
 * Templates are fetched server-side because they may contain shell substitutions.
 */

import { execFile } from 'node:child_process';

/** OpenCode command lookup budget — a slow catalog must not hang the turn. */
const COMMAND_LOOKUP_TIMEOUT_MS = 10_000;
/** Per-substitution shell budget. */
const SHELL_TIMEOUT_MS = 30_000;
/** Per-substitution output cap; longer output is truncated with a marker. */
const SHELL_MAX_OUTPUT_BYTES = 100_000;
/** Bound on how many `!`cmd`` substitutions one template may run. */
const MAX_SHELL_SUBSTITUTIONS = 20;

const SHELL_SUBSTITUTION_PATTERN = /!`([^`]+)`/g;
const ARGUMENTS_TOKEN = '$ARGUMENTS';

/**
 * @param {unknown} value
 * @returns {string}
 */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {string} message
 * @param {string} code
 * @param {number} statusCode
 * @returns {Error & { code: string, statusCode: number }}
 */
function commandError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Normalize the `command` field of a harness prompt body.
 *
 * @param {unknown} value
 * @returns {{ name: string, args: string } | null}
 */
export function normalizeOpenCodeCommandRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = asTrimmedString(/** @type {{ name?: unknown }} */ (value).name);
  if (!name) return null;
  const rawArgs = /** @type {{ arguments?: unknown }} */ (value).arguments;
  return {
    name,
    args: typeof rawArgs === 'string' ? rawArgs.trim() : '',
  };
}

/**
 * Run one `!`cmd`` substitution through the platform shell.
 *
 * Resolves with the captured output even when the command fails: the model needs
 * to see the failure the same way OpenCode surfaces it, and one broken
 * substitution must not discard the rest of the template.
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {Promise<{ output: string, failed: boolean }>}
 */
function runTemplateShell(command, cwd) {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

  return new Promise((resolve) => {
    execFile(shell, args, {
      cwd,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: SHELL_MAX_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : '';
      const err = typeof stderr === 'string' ? stderr : '';
      if (!error) {
        resolve({ output: out.replace(/\s+$/, ''), failed: false });
        return;
      }
      // Truncation (maxBuffer) and timeouts still carry usable partial output.
      const detail = [out, err].map((chunk) => chunk.replace(/\s+$/, '')).filter(Boolean).join('\n');
      // Built from the exit status, not `error.message`: execFile folds stderr
      // into that message, which would print the command's own output twice.
      // `killed` covers both the timeout and the output cap, so the cap is
      // checked first — reporting truncation as a timeout would send the model
      // chasing the wrong problem.
      const reason = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? `output exceeded ${SHELL_MAX_OUTPUT_BYTES} bytes`
        : error.killed
          ? `timed out after ${SHELL_TIMEOUT_MS}ms`
          : typeof error.code === 'number'
            ? `exit ${error.code}`
            : asTrimmedString(error.code) || asTrimmedString(error.message) || 'failed';
      resolve({
        output: detail
          ? `[command failed: ${reason}]\n${detail}`
          : `[command failed: ${reason}]`,
        failed: true,
      });
    });
  });
}

/**
 * Expand an OpenCode command template into Claude prompt text.
 *
 * @param {object} params
 * @param {string} params.template
 * @param {string} [params.args]
 * @param {string} params.cwd
 * @param {(command: string, cwd: string) => Promise<{ output: string, failed: boolean }>} [params.runShell]
 * @returns {Promise<string>}
 */
export async function expandOpenCodeCommandTemplate(params) {
  const template = typeof params.template === 'string' ? params.template : '';
  const args = typeof params.args === 'string' ? params.args.trim() : '';
  const cwd = typeof params.cwd === 'string' ? params.cwd : process.cwd();
  const runShell = typeof params.runShell === 'function' ? params.runShell : runTemplateShell;

  let text = template.includes(ARGUMENTS_TOKEN)
    ? template.split(ARGUMENTS_TOKEN).join(args)
    // A template without the token would silently swallow whatever the user
    // typed after the command name; append it instead of dropping input.
    : args
      ? `${template.replace(/\s+$/, '')}\n\n${args}`
      : template;

  // Collect first, then substitute: the matches must run in template order and
  // replacement text can itself contain backticks.
  const matches = [...text.matchAll(SHELL_SUBSTITUTION_PATTERN)];
  if (matches.length === 0) return text;

  /** @type {string[]} */
  const replacements = [];
  for (const [index, match] of matches.entries()) {
    const command = match[1];
    if (index >= MAX_SHELL_SUBSTITUTIONS) {
      replacements.push(`[command skipped: template exceeds ${MAX_SHELL_SUBSTITUTIONS} shell substitutions]`);
      continue;
    }
    const { output } = await runShell(command, cwd);
    replacements.push(output);
  }

  let cursor = 0;
  let out = '';
  for (const [index, match] of matches.entries()) {
    const start = match.index;
    out += text.slice(cursor, start) + replacements[index];
    cursor = start + match[0].length;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Fetch a command definition from OpenCode.
 *
 * Throws on lookup failure rather than reporting "not found" — an unreachable
 * OpenCode must not look like a command the user never defined.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.directory
 * @param {(path: string, prefixOverride?: string) => string} params.buildOpenCodeUrl
 * @param {() => Record<string, string>} [params.getOpenCodeAuthHeaders]
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<{ name: string, template: string }>}
 */
export async function resolveOpenCodeCommandDefinition(params) {
  const name = asTrimmedString(params.name);
  const directory = asTrimmedString(params.directory);
  const buildOpenCodeUrl = params.buildOpenCodeUrl;
  const getAuthHeaders = typeof params.getOpenCodeAuthHeaders === 'function'
    ? params.getOpenCodeAuthHeaders
    : () => ({});
  const fetchImpl = typeof params.fetchImpl === 'function' ? params.fetchImpl : fetch;

  if (!name) {
    throw commandError('command.name is required', 'COMMAND_INVALID', 400);
  }
  if (typeof buildOpenCodeUrl !== 'function') {
    throw commandError(
      'OpenCode is unavailable, so this command cannot be translated for Claude Code',
      'COMMAND_UNAVAILABLE',
      503,
    );
  }

  let response;
  try {
    const base = buildOpenCodeUrl('/command', '');
    const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getAuthHeaders() },
      signal: AbortSignal.timeout(COMMAND_LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw commandError(
      `Failed to read OpenCode commands: ${error instanceof Error ? error.message : String(error)}`,
      'COMMAND_LOOKUP_FAILED',
      502,
    );
  }

  if (!response?.ok) {
    throw commandError(
      `Failed to read OpenCode commands (${response?.status ?? 'no response'})`,
      'COMMAND_LOOKUP_FAILED',
      502,
    );
  }

  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) {
    throw commandError('OpenCode returned an unexpected command list', 'COMMAND_LOOKUP_FAILED', 502);
  }

  const wanted = name.toLowerCase();
  const match = payload.find((entry) => (
    entry && typeof entry === 'object' && asTrimmedString(entry.name).toLowerCase() === wanted
  ));
  if (!match) {
    throw commandError(`Command /${name} was not found in OpenCode`, 'COMMAND_NOT_FOUND', 404);
  }

  const template = typeof match.template === 'string' ? match.template : '';
  if (!template.trim()) {
    throw commandError(`Command /${name} has an empty template`, 'COMMAND_INVALID', 400);
  }

  // `agent` / `model` on the command are intentionally ignored: the Claude turn
  // runs on the session's own harness target and OpenChamber agent selection.
  return { name: asTrimmedString(match.name) || name, template };
}

/**
 * Resolve + expand an OpenCode command into Claude prompt text.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} [params.args]
 * @param {string} params.directory
 * @param {(path: string, prefixOverride?: string) => string} params.buildOpenCodeUrl
 * @param {() => Record<string, string>} [params.getOpenCodeAuthHeaders]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {(command: string, cwd: string) => Promise<{ output: string, failed: boolean }>} [params.runShell]
 * @returns {Promise<{ name: string, text: string }>}
 */
export async function translateOpenCodeCommandForClaude(params) {
  const definition = await resolveOpenCodeCommandDefinition(params);
  const text = await expandOpenCodeCommandTemplate({
    template: definition.template,
    args: params.args,
    cwd: params.directory,
    runShell: params.runShell,
  });
  const trimmed = text.trim();
  if (!trimmed) {
    throw commandError(`Command /${definition.name} expanded to empty text`, 'COMMAND_INVALID', 400);
  }
  return { name: definition.name, text: trimmed };
}

/**
 * Bind OpenCode transport to the translator, producing the
 * `resolveOpenCodeCommand` dependency the Claude translator expects.
 *
 * Returns `null` when the runtime has no OpenCode URL builder, so callers can
 * leave the dependency unset instead of registering a resolver that can only
 * fail.
 *
 * @param {object} deps
 * @param {((path: string, prefixOverride?: string) => string) | null} [deps.buildOpenCodeUrl]
 * @param {() => Record<string, string>} [deps.getOpenCodeAuthHeaders]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {((params: { name: string, args?: string, directory: string }) => Promise<{ name: string, text: string }>) | null}
 */
export function createOpenCodeCommandResolver(deps = {}) {
  const buildOpenCodeUrl = deps.buildOpenCodeUrl;
  if (typeof buildOpenCodeUrl !== 'function') return null;
  return (params) => translateOpenCodeCommandForClaude({
    ...params,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders: deps.getOpenCodeAuthHeaders,
    fetchImpl: deps.fetchImpl,
  });
}
