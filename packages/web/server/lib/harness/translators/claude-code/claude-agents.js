/** Discover built-in, user, and project Claude main-thread agents. */

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FRONTMATTER_DELIMITER = '---';
const FRONTMATTER_KEYS = new Set(['name', 'description', 'model']);
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SCANNED_FILES = 200;
const MAX_RECURSION_DEPTH = 5;

/**
 * Claude's built-in agent types, always available regardless of user/project
 * configuration. Order here is the order they appear in the merged list.
 *
 * @type {ReadonlyArray<Readonly<{ name: string, description: string }>>}
 */
export const CLAUDE_BUILTIN_AGENTS = Object.freeze([
  Object.freeze({
    name: 'general-purpose',
    description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.',
  }),
  Object.freeze({
    name: 'Explore',
    description: 'Read-only search agent for broad fan-out searches across many files and directories.',
  }),
  Object.freeze({
    name: 'Plan',
    description: 'Software architect agent for designing implementation plans.',
  }),
]);

/** @param {unknown} value @returns {string} */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Strip matching outer single/double quotes from a frontmatter value. */
function stripOuterQuotes(value) {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a Claude agent markdown file's YAML-ish frontmatter without pulling in
 * a YAML dependency. Only `name` / `description` / `model` are understood.
 * Missing frontmatter or a missing closing `---` never throws — both just yield
 * whatever could be read before giving up.
 *
 * @param {string} text
 * @returns {{ name: string, description: string, model: string }}
 */
export function parseClaudeAgentFrontmatter(text) {
  const result = { name: '', description: '', model: '' };
  if (typeof text !== 'string') return result;

  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== FRONTMATTER_DELIMITER) return result;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === FRONTMATTER_DELIMITER) break;

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    if (!FRONTMATTER_KEYS.has(key)) continue;

    result[key] = stripOuterQuotes(line.slice(colonIndex + 1).trim());
  }

  return result;
}

/**
 * Claude config directory candidates, in resolution order. Mirrors
 * `import-from-disk.js`'s `listClaudeConfigDirCandidates` (not exported there),
 * so this module does not invent a second resolution strategy.
 *
 * @returns {string[]}
 */
function listClaudeConfigDirCandidates(env, homeDir) {
  const candidates = [];
  const configDir = asTrimmedString(env?.CLAUDE_CONFIG_DIR);
  if (configDir) candidates.push(configDir);
  if (asTrimmedString(homeDir)) {
    candidates.push(path.join(homeDir, '.claude'));
    candidates.push(path.join(homeDir, '.config', 'claude'));
  }
  return candidates;
}

/**
 * Recursively collect `.md` file paths under `dirPath`, given its already
 * fetched entries. Enforces the shared scan budget (`ctx.scanned`, shared
 * across user + project sources so one pathological tree cannot spend the
 * whole request's budget twice) and the recursion depth cap, which also stops
 * symlink-cyclical trees from hanging the request.
 *
 * @param {number} depth Nesting level of `dirPath`; the root call is depth 1.
 * @returns {Promise<string[]>}
 */
async function collectAgentFilesFromEntries(dirPath, entries, readDirImpl, ctx, depth) {
  const files = [];

  for (const entry of entries) {
    if (ctx.scanned >= MAX_SCANNED_FILES) break;

    const name = entry && typeof entry.name === 'string' ? entry.name : '';
    if (!name) continue;
    const fullPath = path.join(dirPath, name);

    if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
      if (depth >= MAX_RECURSION_DEPTH) continue;
      let nestedEntries;
      try {
        nestedEntries = await readDirImpl(fullPath);
      } catch {
        // Unreadable subdirectory — skip it, keep scanning siblings.
        continue;
      }
      files.push(...await collectAgentFilesFromEntries(fullPath, nestedEntries, readDirImpl, ctx, depth + 1));
      continue;
    }

    if (typeof entry.isFile !== 'function' || !entry.isFile() || !name.endsWith('.md')) continue;

    ctx.scanned += 1;
    files.push(fullPath);
  }

  return files;
}

/**
 * Resolve one agent source (user or project) to its root directory + parsed
 * agents. The first candidate whose directory can be read wins outright — a
 * candidate that does not exist or cannot be read falls through to the next
 * (or to "no root"), and sources are never merged across candidates, mirroring
 * `resolveClaudeProjectsRoot`.
 *
 * @returns {Promise<{ root: string | null, agents: Array<{ name: string, description: string, model: string }> }>}
 */
async function scanAgentsRoot(candidates, readDirImpl, readFileImpl, ctx) {
  for (const rootDir of candidates) {
    let entries;
    try {
      entries = await readDirImpl(rootDir);
    } catch {
      continue;
    }

    const files = await collectAgentFilesFromEntries(rootDir, entries, readDirImpl, ctx, 1);

    const agents = [];
    for (const filePath of files) {
      let content;
      try {
        content = await readFileImpl(filePath);
      } catch {
        // Unreadable file — skip it, do not fail the whole source.
        continue;
      }
      const parsed = parseClaudeAgentFrontmatter(typeof content === 'string' ? content : String(content));
      const name = asTrimmedString(parsed.name) || path.basename(filePath, '.md');
      if (!name) continue;

      agents.push({
        name,
        description: asTrimmedString(parsed.description).slice(0, MAX_DESCRIPTION_CHARS),
        model: asTrimmedString(parsed.model),
      });
    }

    return { root: rootDir, agents };
  }

  return { root: null, agents: [] };
}

/**
 * Merge builtin/user/project agents by name (case-insensitive), later source
 * wins on collision. An override replaces the entry's data (and casing) in
 * place at its FIRST position rather than moving it to the end — so a project
 * agent named `Helper` overriding a user agent `helper` keeps whatever index
 * the user agent held, it does not get appended again.
 *
 * @returns {Array<{ name: string, description: string, model: string, source: 'builtin' | 'user' | 'project' }>}
 */
function mergeAgents(builtins, userAgents, projectAgents) {
  const order = [];
  const byKey = new Map();

  const upsert = (agent, source) => {
    const key = agent.name.toLowerCase();
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, { ...agent, source });
  };
  const byName = (a, b) => a.name.localeCompare(b.name);

  for (const agent of builtins) upsert(agent, 'builtin');
  for (const agent of [...userAgents].sort(byName)) upsert(agent, 'user');
  for (const agent of [...projectAgents].sort(byName)) upsert(agent, 'project');

  return order.map((key) => byKey.get(key));
}

/**
 * @typedef {object} ClaudeAgentEntry
 * @property {string} name
 * @property {string} description
 * @property {string} model
 * @property {'builtin' | 'user' | 'project'} source
 */

/**
 * List every agent a Claude Code session can use as its main-thread agent:
 * built-ins + user agents (`<claudeConfigRoot>/agents`) + project agents
 * (`<directory>/.claude/agents`), merged and deduplicated by name.
 *
 * Filesystem access is injectable so callers (and tests) never need real files
 * on disk. Defaults call `node:fs/promises`, always with `{ withFileTypes: true }`.
 *
 * @param {object} [params]
 * @param {string} [params.directory] Session cwd; empty/undefined means "no project source".
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [params.env]
 * @param {string} [params.homeDir]
 * @param {(dirPath: string) => Promise<unknown[]>} [params.readDirImpl]
 * @param {(filePath: string) => Promise<string>} [params.readFileImpl]
 * @returns {Promise<{ agents: ClaudeAgentEntry[], roots: { user: string | null, project: string | null } }>}
 */
export async function listClaudeAgents(params = {}) {
  const directory = asTrimmedString(params.directory);
  const env = params.env || process.env;
  const homeDir = asTrimmedString(params.homeDir) || os.homedir();
  const readDirImpl = typeof params.readDirImpl === 'function'
    ? params.readDirImpl
    : (dirPath) => readdir(dirPath, { withFileTypes: true });
  const readFileImpl = typeof params.readFileImpl === 'function'
    ? params.readFileImpl
    : (filePath) => readFile(filePath, 'utf8');

  // Shared across both sources: a pathological user tree must not leave the
  // project source with its own separate 200-file budget.
  const ctx = { scanned: 0 };

  const userCandidates = listClaudeConfigDirCandidates(env, homeDir)
    .map((configDir) => path.join(configDir, 'agents'));
  const { root: userRoot, agents: userAgents } = await scanAgentsRoot(userCandidates, readDirImpl, readFileImpl, ctx);

  const projectCandidates = directory ? [path.join(directory, '.claude', 'agents')] : [];
  const { root: projectRoot, agents: projectAgents } = await scanAgentsRoot(projectCandidates, readDirImpl, readFileImpl, ctx);

  const builtins = CLAUDE_BUILTIN_AGENTS.map((agent) => ({ ...agent, model: '' }));

  return {
    agents: mergeAgents(builtins, userAgents, projectAgents),
    roots: { user: userRoot, project: projectRoot },
  };
}
