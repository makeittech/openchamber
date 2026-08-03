/**
 * Resolve OpenCode agent prompts, permissions, and subagents for Claude turns.
 * Only the agent name comes from the client; rules are re-read from OpenCode.
 */

/** Agent lookup budget — a slow OpenCode must not hang the turn. */
const AGENT_LOOKUP_TIMEOUT_MS = 10_000;
/** Bound on registered subagents so a huge catalog cannot bloat every turn. */
const MAX_SUBAGENT_DEFINITIONS = 50;
/** Bound on inherited prompt text (per agent). */
const MAX_PROMPT_CHARS = 100_000;

/**
 * Claude tool name → OpenCode permission key. Anything absent falls back to the
 * lowercased Claude tool name, so a rule for a Claude-only tool (`websearch`,
 * `todowrite`, …) works without this table knowing about it.
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
 * Tool input fields carrying the value an OpenCode `pattern` matches against,
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

/** @param {unknown} value @returns {string} */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @returns {Error & { code: string, statusCode: number }} */
function agentError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Match an OpenCode permission `pattern` (a glob: `*` any run, `?` one char)
 * against a tool argument. `*` alone matches everything, including tools whose
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
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  return new RegExp(source, 's').test(subject);
}

/**
 * Resolve the OpenCode permission key + pattern candidate for a Claude tool call.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @returns {{ key: string, candidate: string }}
 */
export function resolveToolPermissionTarget(toolName, input) {
  const lower = asTrimmedString(toolName).toLowerCase();
  // MCP tools arrive as `mcp__<server>__<tool>`; OpenCode names the whole call
  // the same way, so the full name is the permission key.
  const key = lower.startsWith('mcp__') ? lower : (TOOL_PERMISSION_KEYS[lower] || lower);

  const fields = TOOL_PATTERN_FIELDS[key];
  if (!fields || !input || typeof input !== 'object') return { key, candidate: '' };
  for (const field of fields) {
    const text = asTrimmedString(input[field]);
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
    const permission = asTrimmedString(entry.permission).toLowerCase();
    const action = asTrimmedString(entry.action).toLowerCase();
    if (!permission) continue;
    if (action !== 'allow' && action !== 'deny' && action !== 'ask') continue;
    rules.push({
      permission,
      pattern: asTrimmedString(entry.pattern) || '*',
      action,
    });
  }
  return rules;
}

/**
 * Last matching rule for one permission key, preferring a concrete pattern over
 * a catch-all one.
 *
 * Specificity has to beat position because OpenCode's resolved ruleset appends
 * broad config rules *after* narrow built-in ones: a real `build` agent ends
 * with `read:*→allow` while still carrying `read:*.env→ask` earlier in the
 * array. Pure last-wins would silently auto-approve reading `.env` files that
 * OpenCode itself still prompts for.
 *
 * @returns {'allow' | 'deny' | 'ask' | null}
 */
function resolveRuleAction(rules, permission, candidate) {
  let wildcardAction = null;
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule.permission !== permission) continue;
    if (!matchesPermissionPattern(rule.pattern, candidate)) continue;
    if (rule.pattern !== '*' && rule.pattern !== '**') return rule.action;
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
  if (rules.length === 0) return () => 'ask';

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

/** @param {unknown} agent @returns {string} */
function readAgentPrompt(agent) {
  return asTrimmedString(agent?.prompt).slice(0, MAX_PROMPT_CHARS);
}

/**
 * OpenCode permission key → Claude tool names for `AgentDefinition` allow/
 * disallow lists. A blanket OpenCode deny (`permission` + wildcard `*`) is
 * pushed into the SDK's `disallowedTools` so the SDK refuses before
 * `canUseTool` is even asked, matching OpenCode's silent deny.
 */
const PERMISSION_KEY_CLAUDE_TOOLS = Object.freeze({
  bash: ['Bash', 'BashOutput', 'KillShell', 'KillBash'],
  edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
  read: ['Read', 'NotebookRead'],
  glob: ['Glob'],
  grep: ['Grep'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  todowrite: ['TodoWrite', 'TodoRead'],
  skill: ['Skill'],
  task: ['Task', 'Agent'],
});

/**
 * Claude tool names the SDK should refuse outright for a subagent: every
 * blanket `deny` rule (wildcard pattern) on a known permission key maps to
 * its Claude tools. Concrete-pattern denies cannot be expressed here and
 * stay enforced by the `canUseTool` policy path.
 *
 * @param {unknown} ruleset
 * @returns {string[]}
 */
export function claudeDisallowedToolNames(ruleset) {
  const rules = normalizePermissionRuleset(ruleset);
  const denied = [];
  for (const rule of rules) {
    if (rule.action !== 'deny') continue;
    if (rule.pattern !== '*' && rule.pattern !== '**') continue;
    const tools = PERMISSION_KEY_CLAUDE_TOOLS[rule.permission];
    if (!tools) continue;
    for (const tool of tools) {
      if (!denied.includes(tool)) denied.push(tool);
    }
  }
  return denied;
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
  const entries = Object.entries(tools);
  if (!entries.some(([, enabled]) => enabled === false)) return null;
  const allowed = entries
    .filter(([, enabled]) => enabled !== false)
    .map(([name]) => name.trim())
    .filter(Boolean);
  return allowed.length > 0 ? allowed : null;
}

/**
 * Map OpenCode subagents onto Claude `AgentDefinition`s.
 *
 * Only **user-authored** agents are registered. OpenCode's own agents (`build`,
 * `plan`, `general`, `explore`, …) report a `prompt` that is just the config
 * addendum from `opencode.json` — a one-liner, not a system prompt — and a
 * Claude `AgentDefinition.prompt` *replaces* that agent's whole system prompt.
 * Registering them would gut Claude's general-purpose/Explore agents. The live
 * `/agent` payload marks them `native`, while the SDK type documents `builtIn`;
 * both are checked so a schema change on either side cannot quietly register
 * every OpenCode built-in. Hidden agents (`title`, `summary`, `compaction`) are
 * internal machinery and never user-selectable.
 *
 * @param {unknown[]} agents
 * @returns {Record<string, object>}
 */
export function buildClaudeAgentDefinitions(agents) {
  if (!Array.isArray(agents)) return {};
  /** @type {Record<string, object>} */
  const definitions = {};

  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    if (Object.keys(definitions).length >= MAX_SUBAGENT_DEFINITIONS) break;

    const name = asTrimmedString(entry.name);
    if (!name) continue;
    if (entry.native === true || entry.builtIn === true || entry.hidden === true) continue;

    const mode = asTrimmedString(entry.mode).toLowerCase();
    if (mode !== 'subagent' && mode !== 'all') continue;

    // Without a prompt there is nothing to substitute; Claude's own agent set
    // stays intact rather than gaining an empty-brained duplicate.
    const prompt = readAgentPrompt(entry);
    if (!prompt) continue;

    const tools = buildToolAllowlist(entry.tools);
    const disallowedTools = claudeDisallowedToolNames(entry.permission);
    const model = entry.model && typeof entry.model === 'object'
      ? asTrimmedString(entry.model.modelID)
      : '';

    definitions[name] = {
      description: asTrimmedString(entry.description) || `OpenCode agent "${name}"`,
      prompt,
      ...(tools ? { tools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      // OpenCode model ids are provider-scoped; only a bare Claude alias/id is
      // meaningful to the Agent SDK, so anything else inherits the main model.
      ...(/^(fable|opus|sonnet|haiku|claude-)/i.test(model) ? { model } : {}),
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
  const { buildOpenCodeUrl } = params;
  if (typeof buildOpenCodeUrl !== 'function') {
    throw agentError(
      'OpenCode is unavailable, so agent definitions cannot be inherited',
      'AGENT_UNAVAILABLE',
      503,
    );
  }
  const directory = asTrimmedString(params.directory);
  const getAuthHeaders = typeof params.getOpenCodeAuthHeaders === 'function'
    ? params.getOpenCodeAuthHeaders
    : () => ({});
  const fetchImpl = typeof params.fetchImpl === 'function' ? params.fetchImpl : fetch;

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
 *   Lowercased OpenCode subagent name → its own tool policy, so permission asks
 *   made *inside* a running subagent resolve against that subagent's ruleset
 *   instead of the parent agent's.
 */

/**
 * Build a lowercased-name → tool policy map for every registered OpenCode
 * subagent. Subagents without a ruleset ask for everything, matching the
 * parent fallback — never a permissive default.
 *
 * @param {unknown[]} agents
 * @returns {Record<string, (toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask'>}
 */
function buildSubagentPolicies(agents) {
  if (!Array.isArray(agents)) return {};
  /** @type {Record<string, (toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask'>} */
  const policies = {};
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    const name = asTrimmedString(entry.name);
    if (!name) continue;
    if (entry.native === true || entry.builtIn === true || entry.hidden === true) continue;
    const mode = asTrimmedString(entry.mode).toLowerCase();
    if (mode !== 'subagent' && mode !== 'all') continue;
    policies[name.toLowerCase()] = createOpenCodeToolPolicy(entry.permission);
  }
  return policies;
}

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
      entry && typeof entry === 'object' && asTrimmedString(entry.name).toLowerCase() === wanted
    ))
    : undefined;

  return {
    agentName: selected ? asTrimmedString(selected.name) : '',
    systemPromptAppend: selected ? readAgentPrompt(selected) : '',
    // An unmatched agent inherits nothing and therefore asks for everything —
    // it must never fall through to a permissive default.
    resolveToolPolicy: createOpenCodeToolPolicy(selected ? selected.permission : null),
    agentDefinitions: buildClaudeAgentDefinitions(list),
    subagentPolicies: buildSubagentPolicies(list),
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
  const { buildOpenCodeUrl } = deps;
  if (typeof buildOpenCodeUrl !== 'function') return null;
  return async (params) => buildOpenCodeAgentInheritance(
    await fetchOpenCodeAgents({
      directory: params.directory,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: deps.getOpenCodeAuthHeaders,
      fetchImpl: deps.fetchImpl,
    }),
    params.agentName,
  );
}
