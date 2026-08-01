/**
 * Resolve a filesystem-spawnable Claude Code CLI path.
 *
 * Electron packs the Agent SDK into `app.asar`. The SDK's default resolver
 * often joins a sibling native package path that still points inside the asar
 * archive; spawning that path fails with ENOTDIR. Prefer PATH / explicit env,
 * then rewrite asar → asar.unpacked, then known Electron resource locations.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinaryOnPath } from '../../binary-path.js';

/**
 * @param {string | null | undefined} candidate
 * @returns {string | null}
 */
export function rewriteAsarUnpackedPath(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const normalized = candidate.trim();
  const asarUnpacked = `${path.sep}app.asar.unpacked${path.sep}`;
  if (normalized.includes(asarUnpacked)) return normalized;
  const asar = `${path.sep}app.asar${path.sep}`;
  if (!normalized.includes(asar)) return normalized;
  return normalized.split(asar).join(asarUnpacked);
}

/**
 * @param {string | null | undefined} candidate
 * @param {{ existsSync?: (path: string) => boolean, statSync?: (path: string) => { isFile(): boolean } }} [fsLike]
 * @returns {string | null}
 */
export function asSpawnableExecutable(candidate, fsLike = fs) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const rewritten = rewriteAsarUnpackedPath(candidate.trim()) || candidate.trim();
  try {
    if (!fsLike.existsSync(rewritten)) return null;
    const stat = fsLike.statSync(rewritten);
    if (!stat.isFile()) return null;
    return rewritten;
  } catch {
    return null;
  }
}

/**
 * Native Agent SDK package binary names by platform/arch.
 * @param {{ platform?: string, arch?: string }} [options]
 * @returns {string[]}
 */
export function listBundledClaudeNativePackageNames(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? ['claude-agent-sdk-darwin-arm64']
      : ['claude-agent-sdk-darwin-x64'];
  }
  if (platform === 'win32') {
    return ['claude-agent-sdk-win32-x64'];
  }
  if (platform === 'linux') {
    if (arch === 'arm64') {
      return ['claude-agent-sdk-linux-arm64', 'claude-agent-sdk-linux-arm64-musl'];
    }
    return ['claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl'];
  }
  return [];
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   resourcesPath?: string | null,
 *   findOnPath?: (name: string) => string | null,
 *   existsSync?: (path: string) => boolean,
 *   statSync?: (path: string) => { isFile(): boolean },
 *   platform?: string,
 *   arch?: string,
 *   homedir?: () => string,
 * }} [options]
 * @returns {string | null}
 */
export function resolveClaudeCodeExecutable(options = {}) {
  const env = options.env || process.env;
  const existsSync = options.existsSync || ((filePath) => fs.existsSync(filePath));
  const statSync = options.statSync || ((filePath) => fs.statSync(filePath));
  const fsLike = { existsSync, statSync };
  const findOnPath = options.findOnPath || ((name) => findBinaryOnPath(name, env.PATH || process.env.PATH || ''));

  const fromEnv = asSpawnableExecutable(env.CLAUDE_CODE_EXECUTABLE || env.CLAUDE_CODE_PATH, fsLike);
  if (fromEnv) return fromEnv;

  const fromPath = asSpawnableExecutable(findOnPath('claude'), fsLike);
  if (fromPath) return fromPath;

  const resourcesPath = typeof options.resourcesPath === 'string' && options.resourcesPath.trim()
    ? options.resourcesPath.trim()
    : (typeof process.resourcesPath === 'string' ? process.resourcesPath : null);

  const packageNames = listBundledClaudeNativePackageNames({
    platform: options.platform,
    arch: options.arch,
  });
  const binaryName = (options.platform || process.platform) === 'win32' ? 'claude.exe' : 'claude';

  if (resourcesPath) {
    for (const packageName of packageNames) {
      const candidate = path.join(
        resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        packageName,
        binaryName,
      );
      const spawnable = asSpawnableExecutable(candidate, fsLike);
      if (spawnable) return spawnable;
    }
  }

  // Dev / non-Electron: try resolving next to the SDK install via createRequire-like paths
  // without importing the SDK (keeps this module light). Walk common node_modules roots.
  const homedir = options.homedir || (() => os.homedir());
  const searchRoots = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
    path.join(homedir(), '.local', 'lib', 'node_modules'),
  ];
  for (const root of searchRoots) {
    for (const packageName of packageNames) {
      const candidate = path.join(root, 'node_modules', '@anthropic-ai', packageName, binaryName);
      const spawnable = asSpawnableExecutable(candidate, fsLike);
      if (spawnable) return spawnable;
      // bun nested install layout
      const bunCandidate = path.join(root, 'node_modules', '.bun');
      try {
        if (!existsSync(bunCandidate)) continue;
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Ensure cwd is a real directory before spawning Claude.
 * @param {unknown} cwd
 * @param {{ existsSync?: (path: string) => boolean, statSync?: (path: string) => { isDirectory(): boolean } }} [fsLike]
 * @returns {string}
 */
export function assertClaudeWorkingDirectory(cwd, fsLike = fs) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    const error = new Error('Claude Code working directory is required');
    error.code = 'CLAUDE_CWD_INVALID';
    error.statusCode = 400;
    throw error;
  }
  const resolved = path.resolve(cwd.trim());
  let isDirectory = false;
  try {
    isDirectory = fsLike.existsSync(resolved) && fsLike.statSync(resolved).isDirectory();
  } catch (error) {
    if (error?.code === 'CLAUDE_CWD_ENOTDIR' || error?.code === 'CLAUDE_CWD_INVALID') throw error;
    isDirectory = false;
  }
  if (isDirectory) return resolved;

  const error = new Error(`Claude Code working directory is not a directory: ${resolved}`);
  error.code = 'CLAUDE_CWD_ENOTDIR';
  error.statusCode = 400;
  throw error;
}
