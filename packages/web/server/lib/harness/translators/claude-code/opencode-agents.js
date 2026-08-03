/**
 * OpenCode agent inheritance for the Claude Code harness (`agentsMode: 'opencode'`).
 *
 * Claude Code has no concept of an OpenCode agent. Before this module the
 * "Agents to use → OpenCode" setting only mapped the selected agent's `edit`
 * rule onto a Claude `permissionMode`, so an agent that allows `bash` still
 * produced a PermissionCard for every command, and the agent's own prompt was
 * the only other thing inherited.
 *
 * This module resolves the agent **from OpenCode itself** per turn and turns it
 * into three Claude SDK inputs:
 *
 * | OpenCode agent field | Claude SDK input |
 * | --- | --- |
 * | `prompt` (selected primary agent) | `systemPrompt.append` on the `claude_code` preset |
 * | `permission` (selected primary agent) | tool policy consulted by `canUseTool` |
 * | non-built-in subagents | `agents` (`Record<string, AgentDefinition>`) |
 *
 * The ruleset is **never taken from the client**, for the same reason the
 * command template is not (`opencode-command.js`): a prompt body carrying
 * `{"*": "allow"}` would otherwise disable the permission bridge outright,
 * which is exactly what the `bypassPermissions` allowlist in `query.js` exists
 * to prevent. Only the agent *name* travels; the server re-reads `GET /agent`.
 */

/** Agent lookup budget — a slow OpenCode must not hang the turn. */
const AGENT_LOOKUP_TIMEOUT_MS = 10_000;

/** Bound on registered subagents so a huge catalog cannot bloat every turn. */
const MAX_SUBAGENT_DEFINITIONS = 50;

/** Bound on inherited prompt text (per agent). */
const MAX_PROMPT_CHARS = 100_000;

/**
 * Claude tool name → OpenCode permission key.
 *
 * OpenCode names permissions after its own tools, so the bridge has to map.
 * Anything absent falls back to the lowercased Claude tool name, which lets a
 * user write a rule for a Claude-only tool (`websearch`, `todowrite`, …)
 * without this table needing to know about it.
 */
const TOOL_PERMISSION_KEYS = Object.freeze({
  bash: 'bash',
  bashoutput: 'bash',
  killshell: 'bash',
  killbash: 'bash',
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  notebookedit: 'edit',
  read: 'read',
  notebookread: 'read',
  glob: 'glob',
  grep: 'grep',
  webfetch: 'webfetch',
  websearch: 'websearch',
  task: 'task',
  agent: 'task',
  todowrite: 'todowrite',
  todoread: 'todowrite',
  skill: 'skill',
});

/**
 * Tool input fields that carry the value an OpenCode `pattern` matches against,
 * in priority order per permission key.
 */
const TOOL_PATTERN_FIELDS = Object.freeze({
  bash: ['command', 'cmd'],
  edit: ['file_path', 'filePath', 'path', 'notebook_path'],
  read: ['file_path', 'filePath', 'path', 'notebook_path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  webfetch: ['url'],
  websearch: ['query'],
  task: ['subagent_type', 'description'],
  skill: ['skill', 'name'],
});

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
function agentError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Escape regex metacharacters except the glob wildcards handled by the caller.
 * @param {string} value
 * @returns {string}
 */
function escapeForGlob(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match an OpenCode permission `pattern` against a tool argument.
 *
 * OpenCode patterns are globs over the command/path string (`*` any run,
 * `?` one character). `*` alone matches everything, including tools whose
 * arguments this bridge cannot represent.
 *
 * @param {string} pattern
 * @param {string} candidate
 * @returns {boolean}
 */
export function matchesPermissionPattern(pattern, candidate) {
  const normalized = typeof pattern === 'string' ? pattern.trim() : '';
  if (!normalized || normalized === '*' || normalized === '**') return true;
  const subject = typeof candidate === 'string' ? candidate : '';
  // A concrete pattern cannot be proven against an argument the tool did not
  // supply — fail closed so an unmatched rule never widens access.
  if (!subject) return false;
  const source = `^${escapeForGlob(normalized).replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  let expression;
  try {
    expression = new RegExp(source, 's');
  } catch {
    return false;
  }
  return expression.test(subject);
}

/**
 * Resolve the OpenCode permission key + pattern candidate for a Claude tool call.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @returns {{ key: string, candidate: string }}
 */
export function resolveToolPermissionTarget(toolName, input) {
  const raw = asTrimmedString(toolName);
  const lower = raw.toLowerCase();
  // MCP tools arrive as `mcp__<server>__<tool>`; OpenCode names the whole call
  // the same way, so the full name is the permission key.
  const key = lower.startsWith('mcp__')
    ? lower
    : (TOOL_PERMISSION_KEYS[lower] || lower);

  const fields = TOOL_PATTERN_FIELDS[key];
  if (!fields || !input || typeof input !== 'object') {
    return { key, candidate: '' };
  }
  for (const field of fields) {
    const value = /** @type {Record<string, unknown>} */ (input)[field];
    const text = asTrimmedString(value);
    if (text) return { key, candidate: text };
  }
  return { key, candidate: '' };
}

/**
 * Normalize an OpenCode `PermissionRuleset` (`Array<{permission, pattern, action}>`).
 *
 * @param {unknown} value
 * @returns {Array<{ permission: string, pattern: string, action: 'allow' | 'deny' | 'ask' }>}
 */
export function normalizePermissionRuleset(value) {
  if (!Array.isArray(value)) return [];
  const rules = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const permission = asTrimmedString(/** @type {{ permission?: unknown }} */ (entry).permission).toLowerCase();
    const action = asTrimmedString(/** @type {{ action?: unknown }} */ (entry).action).toLowerCase();
    if (!permission) continue;
    if (action !== 'allow' && action !== 'deny' && action !== 'ask') continue;
    const rawPattern = /** @type {{ pattern?: unknown }} */ (entry).pattern;
    rules.push({
      permission,
      pattern: typeof rawPattern === 'string' && rawPattern.trim() ? rawPattern.trim() : '*',
      action: /** @type {'allow' | 'deny' | 'ask'} */ (action),
    });
  }
  return rules;
}

/** A pattern that matches everything carries no specificity. */
function isWildcardPattern(pattern) {
  return pattern === '*' || pattern === '**';
}

/**
 * Claude tool names gated by an OpenCode permission key when that key is
 * blanket-denied. Used for AgentDefinition.disallowedTools so the SDK refuses
 * the tool before canUseTool — matching OpenCode's silent deny for subagents.
 */
const OPENCODE_KEY_TO_CLAUDE_DISALLOWED = Object.freeze({
  bash: ['Bash', 'BashOutput', 'KillShell', 'KillBash'],
  edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
  read: ['Read', 'NotebookRead'],
  glob: ['Glob'],
  grep: ['Grep'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  todowrite: ['TodoWrite', 'TodoRead'],
  skill: ['Skill'],
});

/**
 * Blanket `deny` rules → Claude `disallowedTools`. Patterned denies stay in
 * canUseTool (the SDK allow/deny lists cannot express globs).
 *
 * @param {unknown} ruleset
 * @returns {string[]}
 */
function buildDisallowedToolsFromRuleset(ruleset) {
  const rules = normalizePermissionRuleset(ruleset);
  /** @type {Set<string>} */
  const denied = new Set();
  for (const rule of rules) {
    if (rule.action !== 'deny') continue;
    if (!isWildcardPattern(rule.pattern)) continue;
    if (rule.permission === '*') continue;
    const tools = OPENCODE_KEY_TO_CLAUDE_DISALLOWED[rule.permission];
    if (!tools) continue;
    for (const tool of tools) denied.add(tool);
  }
  return Array.from(denied);
}

/**
 * Last matching rule for one permission key, preferring a concrete pattern
 * over a catch-all one.
 *
 * Specificity has to beat position because OpenCode's resolved ruleset appends
 * broad config rules *after* narrow built-in ones: a real `build` agent ends
 * with `read:*→allow` while still carrying `read:*.env→ask` earlier in the
 * array. Pure last-wins would silently auto-approve reading `.env` files that
 * OpenCode itself still prompts for.
 *
 * @param {Array<{ permission: string, pattern: string, action: 'allow' | 'deny' | 'ask' }>} rules
 * @param {string} permission
 * @param {string} candidate
 * @returns {'allow' | 'deny' | 'ask' | null}
 */
function resolveRuleAction(rules, permission, candidate) {
  /** @type {'allow' | 'deny' | 'ask' | null} */
  let wildcardAction = null;
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule.permission !== permission) continue;
    if (!matchesPermissionPattern(rule.pattern, candidate)) continue;
    if (!isWildcardPattern(rule.pattern)) return rule.action;
    if (wildcardAction === null) wildcardAction = rule.action;
  }
  return wildcardAction;
}

/**
 * Build the tool policy `canUseTool` consults for an OpenCode-inherited turn.
 *
 * A rule naming the permission explicitly always beats a global `*` rule, the
 * way `packages/ui/src/stores/utils/permissionUtils.ts` resolves it. Nothing
 * matching means `ask` — the bridge's existing fail-closed behavior.
 *
 * @param {unknown} ruleset
 * @returns {(toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask'}
 */
export function createOpenCodeToolPolicy(ruleset) {
  const rules = normalizePermissionRuleset(ruleset);
  if (rules.length === 0) {
    return () => 'ask';
  }

  return (toolName, input = {}) => {
    const { key, candidate } = resolveToolPermissionTarget(toolName, input);
    return resolveRuleAction(rules, key, candidate)
      ?? resolveRuleAction(rules, '*', candidate)
      ?? 'ask';
  };
}

/**
 * Map an inherited `edit` decision onto a Claude `permissionMode`.
 *
 * Mirrors `claudePermissionModeFromEditPermission` in
 * `packages/ui/src/lib/harness/claude-models.ts` so both sides of the bridge
 * agree, and keeps the value inside the allowlist `query.js` enforces.
 *
 * @param {'allow' | 'deny' | 'ask'} action
 * @returns {'acceptEdits' | 'plan' | 'default'}
 */
export function claudePermissionModeFromEditAction(action) {
  if (action === 'allow') return 'acceptEdits';
  if (action === 'deny') return 'plan';
  return 'default';
}

/**
 * @param {unknown} agent
 * @returns {string}
 */
function readAgentPrompt(agent) {
  const prompt = asTrimmedString(/** @type {{ prompt?: unknown }} */ (agent)?.prompt);
  if (!prompt) return '';
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
}

/**
 * Claude `AgentDefinition.tools` is an allowlist; OpenCode `tools` is a
 * `Record<string, boolean>` where `false` disables. Only a record that actually
 * disables something produces an allowlist — an all-true record would otherwise
 * pin the subagent to whatever tools OpenCode happens to know about.
 *
 * @param {unknown} tools
 * @returns {string[] | null}
 */
function buildToolAllowlist(tools) {
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return null;
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (tools));
  if (entries.length === 0) return null;
  const disabled = entries.filter(([, enabled]) => enabled === false);
  if (disabled.length === 0) return null;
  const allowed = entries
    .filter(([, enabled]) => enabled !== false)
    .map(([name]) => name.trim())
    .filter(Boolean);
  return allowed.length > 0 ? allowed : null;
}

/**
 * Is this one of OpenCode's own shipped agents?
 *
 * The live `/agent` payload marks them `native: true` and has no `builtIn`
 * field at all, while the SDK type documents `builtIn`. Both are checked so a
 * schema change on either side cannot quietly turn every OpenCode built-in into
 * a registered Claude subagent.
 *
 * @param {Record<string, unknown>} entry
 * @returns {boolean}
 */
function isOpenCodeShippedAgent(entry) {
  return entry.native === true || entry.builtIn === true;
}

/**
 * Map OpenCode subagents onto Claude `AgentDefinition`s.
 *
 * Only **user-authored** agents are registered. OpenCode's own agents (`build`,
 * `plan`, `general`, `explore`, …) report a `prompt` that is just the config
 * addendum from `opencode.json` — a one-liner, not a system prompt — and a
 * Claude `AgentDefinition.prompt` *replaces* that agent's whole system prompt.
 * Registering them would gut Claude's general-purpose/Explore agents instead of
 * substituting anything meaningful. Hidden agents (`title`, `summary`,
 * `compaction`) are internal machinery and never user-selectable.
 *
 * @param {unknown[]} agents
 * @returns {Record<string, object>}
 */
export function buildClaudeAgentDefinitions(agents) {
  if (!Array.isArray(agents)) return {};
  /** @type {Record<string, object>} */
  const definitions = {};

  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    if (Object.keys(definitions).length >= MAX_SUBAGENT_DEFINITIONS) break;

    const entry = /** @type {Record<string, unknown>} */ (agent);
    const name = asTrimmedString(entry.name);
    if (!name) continue;
    if (isOpenCodeShippedAgent(entry)) continue;
    if (entry.hidden === true) continue;

    const mode = asTrimmedString(entry.mode).toLowerCase();
    if (mode !== 'subagent' && mode !== 'all') continue;

    const prompt = readAgentPrompt(entry);
    // Without a prompt there is nothing to substitute; Claude's own agent set
    // stays intact rather than gaining an empty-brained duplicate.
    if (!prompt) continue;

    const description = asTrimmedString(entry.description)
      || `OpenCode agent "${name}"`;
    const tools = buildToolAllowlist(entry.tools);
    const model = entry.model && typeof entry.model === 'object'
      ? asTrimmedString(/** @type {{ modelID?: unknown }} */ (entry.model).modelID)
      : '';
    const disallowedTools = buildDisallowedToolsFromRuleset(entry.permission);

    definitions[name] = {
      description,
      prompt,
      ...(tools ? { tools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      // OpenCode model ids are provider-scoped; only a bare Claude alias/id is
      // meaningful to the Agent SDK, so anything else inherits the main model.
      ...(model && /^(fable|opus|sonnet|haiku|claude-)/i.test(model) ? { model } : {}),
    };
  }

  return definitions;
}

/**
 * Fetch the resolved agent list from OpenCode.
 *
 * Throws on lookup failure. An unreachable OpenCode must not look like "this
 * agent grants nothing" — callers decide how to degrade, and the bridge's
 * fallback is the stricter `ask`, never a silent allow.
 *
 * @param {object} params
 * @param {string} params.directory
 * @param {(path: string, prefixOverride?: string) => string} params.buildOpenCodeUrl
 * @param {() => Record<string, string>} [params.getOpenCodeAuthHeaders]
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<unknown[]>}
 */
export async function fetchOpenCodeAgents(params) {
  const directory = asTrimmedString(params.directory);
  const buildOpenCodeUrl = params.buildOpenCodeUrl;
  const getAuthHeaders = typeof params.getOpenCodeAuthHeaders === 'function'
    ? params.getOpenCodeAuthHeaders
    : () => ({});
  const fetchImpl = typeof params.fetchImpl === 'function' ? params.fetchImpl : fetch;

  if (typeof buildOpenCodeUrl !== 'function') {
    throw agentError(
      'OpenCode is unavailable, so agent definitions cannot be inherited',
      'AGENT_UNAVAILABLE',
      503,
    );
  }

  let response;
  try {
    const base = buildOpenCodeUrl('/agent', '');
    const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getAuthHeaders() },
      signal: AbortSignal.timeout(AGENT_LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw agentError(
      `Failed to read OpenCode agents: ${error instanceof Error ? error.message : String(error)}`,
      'AGENT_LOOKUP_FAILED',
      502,
    );
  }

  if (!response?.ok) {
    throw agentError(
      `Failed to read OpenCode agents (${response?.status ?? 'no response'})`,
      'AGENT_LOOKUP_FAILED',
      502,
    );
  }

  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) {
    throw agentError('OpenCode returned an unexpected agent list', 'AGENT_LOOKUP_FAILED', 502);
  }
  return payload;
}

/**
 * @typedef {object} OpenCodeAgentInheritance
 * @property {string} agentName Selected agent, or '' when it could not be matched.
 * @property {string} systemPromptAppend Selected agent's prompt (may be empty).
 * @property {(toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask'} resolveToolPolicy
 * @property {Record<string, object>} agentDefinitions Claude subagent registrations.
 * @property {Record<string, (toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask'>} subagentPolicies
 *   Lowercased OpenCode subagent name → tool policy (for nested canUseTool).
 */

/**
 * Turn an OpenCode agent list into the Claude turn inputs.
 *
 * @param {unknown[]} agents
 * @param {string} [agentName]
 * @returns {OpenCodeAgentInheritance}
 */
export function buildOpenCodeAgentInheritance(agents, agentName) {
  const list = Array.isArray(agents) ? agents : [];
  const wanted = asTrimmedString(agentName).toLowerCase();
  const selected = wanted
    ? list.find((entry) => (
      entry && typeof entry === 'object'
      && asTrimmedString(/** @type {{ name?: unknown }} */ (entry).name).toLowerCase() === wanted
    ))
    : undefined;

  /** @type {Record<string, (toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask'>} */
  const subagentPolicies = {};
  for (const agent of list) {
    if (!agent || typeof agent !== 'object') continue;
    const entry = /** @type {Record<string, unknown>} */ (agent);
    if (isOpenCodeShippedAgent(entry) || entry.hidden === true) continue;
    const mode = asTrimmedString(entry.mode).toLowerCase();
    if (mode !== 'subagent' && mode !== 'all') continue;
    const name = asTrimmedString(entry.name);
    if (!name || !readAgentPrompt(entry)) continue;
    subagentPolicies[name.toLowerCase()] = createOpenCodeToolPolicy(entry.permission);
  }

  return {
    agentName: selected ? asTrimmedString(/** @type {{ name?: unknown }} */ (selected).name) : '',
    systemPromptAppend: selected ? readAgentPrompt(selected) : '',
    // An unmatched agent inherits nothing and therefore asks for everything —
    // it must never fall through to a permissive default.
    resolveToolPolicy: createOpenCodeToolPolicy(
      selected ? /** @type {{ permission?: unknown }} */ (selected).permission : null,
    ),
    agentDefinitions: buildClaudeAgentDefinitions(list),
    subagentPolicies,
  };
}

/**
 * Bind OpenCode transport to the agent inheritance resolver.
 *
 * Returns `null` when the runtime has no OpenCode URL builder, so callers leave
 * the dependency unset instead of registering a resolver that can only fail.
 *
 * @param {object} deps
 * @param {((path: string, prefixOverride?: string) => string) | null} [deps.buildOpenCodeUrl]
 * @param {() => Record<string, string>} [deps.getOpenCodeAuthHeaders]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {((params: { directory: string, agentName?: string }) => Promise<OpenCodeAgentInheritance>) | null}
 */
export function createOpenCodeAgentResolver(deps = {}) {
  const buildOpenCodeUrl = deps.buildOpenCodeUrl;
  if (typeof buildOpenCodeUrl !== 'function') return null;
  return async (params) => {
    const agents = await fetchOpenCodeAgents({
      directory: params.directory,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: deps.getOpenCodeAuthHeaders,
      fetchImpl: deps.fetchImpl,
    });
    return buildOpenCodeAgentInheritance(agents, params.agentName);
  };
}
