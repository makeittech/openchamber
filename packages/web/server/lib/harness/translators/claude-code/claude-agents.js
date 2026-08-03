/**
 * Discover the agents a Claude Code session can select as its MAIN-THREAD agent.
 *
 * "Agent" here is Claude's own concept (`.claude/agents` definitions plus the
 * built-in types Claude ships with every session) — unrelated to OpenCode
 * agents, which `opencode-agents.js` inherits *onto* a Claude turn. This module
 * exists so the OpenChamber composer can list what Claude itself offers as a
 * main-thread agent, without shelling out to the CLI, and so the translator can
 * reject a name Claude would not recognize before it fails the whole turn.
 *
 * Sources, in ascending precedence (later wins on a case-insensitive name
 * collision, original casing preserved from whichever source wins):
 *   1. `CLAUDE_BUILTIN_AGENTS` — Claude's built-in agent types.
 *   2. User agents   — `<claudeConfigRoot>/agents/**\/*.md`
 *   3. Project agents — `<directory>/.claude/agents/**\/*.md`
 *
 * Config root resolution mirrors `import-from-disk.js`'s
 * `resolveClaudeProjectsRoot`: `CLAUDE_CONFIG_DIR`, then `~/.claude`, then
 * `~/.config/claude`, first candidate that resolves wins. A missing or
 * unreadable directory is not a failure — it contributes nothing and its root
 * is reported as `null`, exactly like the projects-root case.
 */

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Frontmatter delimiter line. */
const FRONTMATTER_DELIMITER = '---';

/** Frontmatter keys this module understands; everything else is ignored. */
const FRONTMATTER_KEYS = new Set(['name', 'description', 'model']);

/** Cap on `description` length so one runaway frontmatter field cannot bloat the list. */
const MAX_DESCRIPTION_CHARS = 500;

/** Cap on total `.md` files parsed across both user + project sources per call. */
const MAX_SCANNED_FILES = 200;

/** Cap on directory recursion depth (root counts as depth 1). */
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

/**
 * @param {unknown} value
 * @returns {string}
 */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Strip matching outer single/double quotes from a frontmatter value.
 *
 * @param {string} value
 * @returns {string}
 */
function stripOuterQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a Claude agent markdown file's YAML-ish frontmatter without pulling in
 * a YAML dependency. Only `name` / `description` / `model` are understood;
 * every other key is ignored. Missing frontmatter (no opening `---` on the
 * first line) or a missing closing `---` never throws — both just yield
 * whatever could be read before giving up.
 *
 * @param {string} text
 * @returns {{ name: string, description: string, model: string }}
 */
export function parseClaudeAgentFrontmatter(text) {
  const result = { name: '', description: '', model: '' };
  if (typeof text !== 'string') return result;

  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== FRONTMATTER_DELIMITER) {
    return result;
  }

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
 * `import-from-disk.js`'s `listClaudeConfigDirCandidates` (not exported
 * there), so this module does not invent a second resolution strategy.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} homeDir
 * @returns {string[]}
 */
function listClaudeConfigDirCandidates(env, homeDir) {
  const candidates = [];
  const configDir = asTrimmedString(env?.CLAUDE_CONFIG_DIR);
  if (configDir) {
    candidates.push(configDir);
  }
  if (typeof homeDir === 'string' && homeDir.trim()) {
    candidates.push(path.join(homeDir, '.claude'));
    candidates.push(path.join(homeDir, '.config', 'claude'));
  }
  return candidates;
}

/**
 * Recursively collect `.md` file paths under `dirPath`, given its already
 * fetched entries. Enforces both the shared scan budget (`ctx.scanned`,
 * shared across user + project sources so one pathological tree cannot spend
 * the whole request's budget twice) and the recursion depth cap.
 *
 * @param {string} dirPath
 * @param {Array<{ name: string, isDirectory: () => boolean, isFile: () => boolean }>} entries
 * @param {(dirPath: string) => Promise<unknown[]>} readDirImpl
 * @param {{ scanned: number }} ctx
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

    const isDirectory = typeof entry.isDirectory === 'function' && entry.isDirectory();
    if (isDirectory) {
      // Depth cap: do not descend past MAX_RECURSION_DEPTH so a pathological
      // (or symlink-cyclical) tree cannot hang the request.
      if (depth >= MAX_RECURSION_DEPTH) continue;
      let nestedEntries;
      try {
        nestedEntries = await readDirImpl(fullPath);
      } catch {
        // Unreadable subdirectory — skip it, keep scanning siblings.
        continue;
      }
      const nested = await collectAgentFilesFromEntries(fullPath, nestedEntries, readDirImpl, ctx, depth + 1);
      files.push(...nested);
      continue;
    }

    const isFile = typeof entry.isFile === 'function' && entry.isFile();
    if (!isFile || !name.endsWith('.md')) continue;

    ctx.scanned += 1;
    files.push(fullPath);
  }

  return files;
}

/**
 * Resolve one agent source (user or project) to its root directory + parsed
 * agents. Tries `candidates` in order and uses the first one whose directory
 * can be read; a candidate that does not exist or cannot be read is not an
 * error, it just falls through to the next candidate (or to "no root" when
 * every candidate fails) — mirroring `resolveClaudeProjectsRoot`.
 *
 * @param {string[]} candidates
 * @param {(dirPath: string) => Promise<unknown[]>} readDirImpl
 * @param {(filePath: string) => Promise<string>} readFileImpl
 * @param {{ scanned: number }} ctx
 * @returns {Promise<{ root: string | null, agents: Array<{ name: string, description: string, model: string }> }>}
 */
async function scanAgentsRoot(candidates, readDirImpl, readFileImpl, ctx) {
  for (const rootDir of candidates) {
    /** @type {unknown[]} */
    let entries;
    try {
      entries = await readDirImpl(rootDir);
    } catch {
      // Missing/unreadable directory is not a failure — try the next candidate.
      continue;
    }

    const files = await collectAgentFilesFromEntries(
      rootDir,
      /** @type {Array<{ name: string, isDirectory: () => boolean, isFile: () => boolean }>} */ (entries),
      readDirImpl,
      ctx,
      1,
    );

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
      const basename = path.basename(filePath, '.md');
      const name = asTrimmedString(parsed.name) || basename;
      if (!name) continue;

      agents.push({
        name,
        description: asTrimmedString(parsed.description).slice(0, MAX_DESCRIPTION_CHARS),
        model: asTrimmedString(parsed.model),
      });
    }

    // First candidate that resolves wins outright — do not merge across
    // candidates within the same source (matches resolveClaudeProjectsRoot).
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
 * @param {Array<{ name: string, description: string, model: string }>} builtins
 * @param {Array<{ name: string, description: string, model: string }>} userAgents
 * @param {Array<{ name: string, description: string, model: string }>} projectAgents
 * @returns {Array<{ name: string, description: string, model: string, source: 'builtin' | 'user' | 'project' }>}
 */
function mergeAgents(builtins, userAgents, projectAgents) {
  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, { name: string, description: string, model: string, source: 'builtin' | 'user' | 'project' }>} */
  const byKey = new Map();

  const upsert = (agent, source) => {
    const key = agent.name.toLowerCase();
    if (byKey.has(key)) {
      // Replace in place: keeps the original index, adopts the overriding
      // source's name/description/model/casing.
      byKey.set(key, { ...agent, source });
    } else {
      byKey.set(key, { ...agent, source });
      order.push(key);
    }
  };

  for (const agent of builtins) upsert(agent, 'builtin');
  for (const agent of [...userAgents].sort((a, b) => a.name.localeCompare(b.name))) upsert(agent, 'user');
  for (const agent of [...projectAgents].sort((a, b) => a.name.localeCompare(b.name))) upsert(agent, 'project');

  return order.map((key) => /** @type {{ name: string, description: string, model: string, source: 'builtin' | 'user' | 'project' }} */ (byKey.get(key)));
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
 * Filesystem access is injectable (`readDirImpl` / `readFileImpl`) so callers
 * (and tests) never need real files on disk. Defaults call `node:fs/promises`
 * directly, always with `{ withFileTypes: true }` for directory reads.
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

  const userCandidates = listClaudeConfigDirCandidates(env, homeDir).map((configDir) => path.join(configDir, 'agents'));
  const { root: userRoot, agents: userAgents } = await scanAgentsRoot(userCandidates, readDirImpl, readFileImpl, ctx);

  const projectCandidates = directory ? [path.join(directory, '.claude', 'agents')] : [];
  const { root: projectRoot, agents: projectAgents } = await scanAgentsRoot(projectCandidates, readDirImpl, readFileImpl, ctx);

  const builtins = CLAUDE_BUILTIN_AGENTS.map((agent) => ({ name: agent.name, description: agent.description, model: '' }));

  return {
    agents: mergeAgents(builtins, userAgents, projectAgents),
    roots: { user: userRoot, project: projectRoot },
  };
}
