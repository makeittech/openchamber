/** @typedef {{
 *   sessionId: string,
 *   foreignSessionId?: string,
 *   slashCommands: string[],
 *   skills: string[],
 *   agents: string[],
 *   tools: string[],
 *   mcpServers: Array<{ name: string, status: string }>,
 *   updatedAt: number,
 * }} SessionCapabilities */

/** @type {Map<string, SessionCapabilities>} */
const bySessionId = new Map();

const SESSION_LIMIT = 500;

function evictOldest() {
  /** @type {SessionCapabilities | null} */
  let oldest = null;
  for (const caps of bySessionId.values()) {
    if (!oldest || caps.updatedAt < oldest.updatedAt) oldest = caps;
  }
  if (oldest) bySessionId.delete(oldest.sessionId);
}

export const CLAUDE_BUILTIN_SLASH_COMMANDS = Object.freeze([
  'clear',
  'compact',
  'context',
  'cost',
  'init',
  'pr-comments',
  'release-notes',
  'review',
  'security-review',
  'usage',
]);

function sanitizeStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sanitizeMcpServers(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Array<{ name: string, status: string }>} */
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const status = typeof entry.status === 'string' && entry.status.trim()
      ? entry.status.trim()
      : 'unknown';
    out.push({ name, status });
  }
  return out;
}

function getSessionCapabilities(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  return bySessionId.get(sessionId.trim()) || null;
}

export function getOrCreateSessionCapabilities(sessionId) {
  const existing = getSessionCapabilities(sessionId);
  if (existing) return existing;
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  return {
    sessionId: id,
    slashCommands: [...CLAUDE_BUILTIN_SLASH_COMMANDS],
    skills: [],
    agents: [],
    tools: [],
    mcpServers: [],
    updatedAt: 0,
  };
}

function sanitizeUpdate(input, key, legacyKey = key, sanitize = sanitizeStringList) {
  if (!Array.isArray(input[key]) && !Array.isArray(input[legacyKey])) return null;
  return sanitize(input[key] ?? input[legacyKey]);
}

export function updateSessionCapabilities(sessionId, input = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;

  const prev = bySessionId.get(id);
  const slashCommands = sanitizeUpdate(input, 'slashCommands', 'slash_commands');
  const skills = sanitizeUpdate(input, 'skills');
  const agents = sanitizeUpdate(input, 'agents');
  const tools = sanitizeUpdate(input, 'tools');
  const mcpServers = sanitizeUpdate(input, 'mcpServers', 'mcp_servers', sanitizeMcpServers);

  let foreignSessionId = prev?.foreignSessionId;
  if (typeof input.session_id === 'string' && input.session_id.trim()) {
    foreignSessionId = input.session_id.trim();
  }
  if (typeof input.foreignSessionId === 'string' && input.foreignSessionId.trim()) {
    foreignSessionId = input.foreignSessionId.trim();
  }

  /** @type {SessionCapabilities} */
  const next = {
    sessionId: id,
    slashCommands: slashCommands && slashCommands.length > 0
      ? slashCommands
      : (prev?.slashCommands?.length ? prev.slashCommands : [...CLAUDE_BUILTIN_SLASH_COMMANDS]),
    skills: skills ?? prev?.skills ?? [],
    agents: agents ?? prev?.agents ?? [],
    tools: tools ?? prev?.tools ?? [],
    mcpServers: mcpServers ?? prev?.mcpServers ?? [],
    updatedAt: Date.now(),
  };
  if (foreignSessionId) next.foreignSessionId = foreignSessionId;

  bySessionId.set(id, next);
  if (bySessionId.size > SESSION_LIMIT) evictOldest();
  return next;
}

export function clearSessionCapabilities(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return;
  bySessionId.delete(sessionId.trim());
}

export function resetSessionCapabilities() {
  bySessionId.clear();
}

export function isClaudeSlashCommand(sessionId, commandName) {
  const name = typeof commandName === 'string' ? commandName.trim().replace(/^\//, '') : '';
  if (!name) return false;
  const caps = getOrCreateSessionCapabilities(sessionId);
  const lower = name.toLowerCase();
  return caps.slashCommands.some((cmd) => cmd.toLowerCase() === lower)
    || caps.skills.some((skill) => skill.toLowerCase() === lower);
}
