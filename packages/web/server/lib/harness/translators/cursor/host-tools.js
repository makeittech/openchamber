/**
 * Sandboxed host tool executor for Cursor MCP tool loop.
 * All paths resolve under a session cwd root; never log file contents.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_GREP_OUTPUT_BYTES = 100 * 1024;

/**
 * Windows-aware path prefix check: resolved must equal root or be under root + sep.
 *
 * @param {string} resolved
 * @param {string} root
 * @returns {boolean}
 */
export function isPathInsideRoot(resolved, root) {
  if (typeof resolved !== 'string' || typeof root !== 'string') return false;
  const normResolved = path.resolve(resolved);
  const normRoot = path.resolve(root);
  if (process.platform === 'win32') {
    const a = normResolved.toLowerCase();
    const b = normRoot.toLowerCase();
    if (a === b) return true;
    const prefix = b.endsWith(path.sep) ? b : b + path.sep;
    return a.startsWith(prefix);
  }
  if (normResolved === normRoot) return true;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normResolved.startsWith(prefix);
}

/**
 * @param {string} root
 * @param {string} inputPath
 * @param {{ forWrite?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function resolveSandboxedPath(root, inputPath, opts = {}) {
  const raw = typeof inputPath === 'string' ? inputPath : '';
  if (!raw) {
    const err = new Error('Path is required');
    err.code = 'PATH_REQUIRED';
    throw err;
  }
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);

  let candidate = absolute;
  try {
    candidate = await fs.realpath(absolute);
  } catch (error) {
    if (!opts.forWrite || (error && /** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')) {
      const err = new Error('Path not accessible');
      err.code = 'PATH_ACCESS';
      throw err;
    }
    // New write target: realpath the parent, keep basename.
    const parent = path.dirname(absolute);
    let realParent;
    try {
      realParent = await fs.realpath(parent);
    } catch {
      const err = new Error('Path not accessible');
      err.code = 'PATH_ACCESS';
      throw err;
    }
    candidate = path.join(realParent, path.basename(absolute));
  }

  if (!isPathInsideRoot(candidate, root)) {
    const err = new Error('Path is outside the session workspace');
    err.code = 'PATH_OUTSIDE_ROOT';
    throw err;
  }
  return candidate;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ ok: boolean, output: string, error?: string, exitCode: number | null }>}
 */
function spawnCaptured(command, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
    });

    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const timer = options.timeoutMs > 0
      ? setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish({
          ok: false,
          output: Buffer.concat(outChunks).toString('utf8'),
          error: 'Command timed out',
          exitCode: null,
        });
      }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk) => outChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      finish({
        ok: false,
        output: Buffer.concat(outChunks).toString('utf8'),
        error: error?.message || 'Failed to spawn command',
        exitCode: null,
      });
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      const combined = stderr
        ? (stdout ? `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}` : stderr)
        : stdout;
      finish({
        ok: code === 0,
        output: combined,
        error: code === 0 ? undefined : (stderr.trim() || `Exit code ${code}`),
        exitCode: code,
      });
    });
  });
}

/**
 * Simple recursive glob (no external deps). Supports `*`, `**`, and `?`.
 *
 * @param {string} rootDir
 * @param {string} pattern
 * @returns {Promise<string[]>}
 */
async function walkGlob(rootDir, pattern) {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const parts = normalizedPattern.split('/').filter((p) => p.length > 0);
  /** @type {string[]} */
  const matches = [];

  /**
   * @param {string} dir
   * @param {number} partIndex
   */
  async function walk(dir, partIndex) {
    if (partIndex >= parts.length) return;
    const part = parts[partIndex];
    const isLast = partIndex === parts.length - 1;

    if (part === '**') {
      // Match zero or more directories.
      await walk(dir, partIndex + 1);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const next = path.join(dir, entry.name);
        if (!isPathInsideRoot(next, rootDir)) continue;
        await walk(next, partIndex);
      }
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const regex = globPartToRegExp(part);
    for (const entry of entries) {
      if (!regex.test(entry.name)) continue;
      const next = path.join(dir, entry.name);
      if (!isPathInsideRoot(next, rootDir)) continue;
      if (isLast) {
        matches.push(next);
      } else if (entry.isDirectory()) {
        await walk(next, partIndex + 1);
      }
    }
  }

  await walk(rootDir, 0);
  return matches;
}

/**
 * @param {string} part
 * @returns {RegExp}
 */
function globPartToRegExp(part) {
  let source = '^';
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i];
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if ('\\.()+|^$[]{}'.includes(ch)) source += `\\${ch}`;
    else source += ch;
  }
  source += '$';
  return new RegExp(source, process.platform === 'win32' ? 'i' : undefined);
}

/**
 * @param {{ cwd: string, timeoutMs?: number }} options
 */
export function createHostTools(options) {
  const cwdInput = typeof options?.cwd === 'string' ? options.cwd.trim() : '';
  if (!cwdInput) {
    throw new Error('createHostTools requires cwd');
  }
  const root = path.resolve(cwdInput);
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_SHELL_TIMEOUT_MS;

  return {
    root,
    timeoutMs,

    /**
     * @param {{ command: string, working_directory?: string }} args
     */
    async bash(args) {
      const command = typeof args?.command === 'string' ? args.command : '';
      if (!command) {
        return { ok: false, output: '', error: 'command is required' };
      }

      let workDir = root;
      if (typeof args.working_directory === 'string' && args.working_directory.trim()) {
        try {
          workDir = await resolveSandboxedPath(root, args.working_directory.trim());
        } catch (error) {
          return {
            ok: false,
            output: '',
            error: error instanceof Error ? error.message : 'Invalid working_directory',
          };
        }
      }

      const isWin = process.platform === 'win32';
      const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
      const shellArgs = isWin ? ['/c', command] : ['-c', command];
      const result = await spawnCaptured(shell, shellArgs, { cwd: workDir, timeoutMs });
      return {
        ok: result.ok,
        output: result.output,
        error: result.error,
      };
    },

    /**
     * @param {{ path: string, offset?: number, limit?: number }} args
     */
    async read(args) {
      try {
        const filePath = await resolveSandboxedPath(root, args?.path);
        const text = await fs.readFile(filePath, 'utf8');
        const lines = text.split('\n');
        const offset = Number.isFinite(args?.offset) && args.offset > 0
          ? Math.floor(args.offset)
          : 1;
        const start = Math.max(0, offset - 1);
        let slice = lines.slice(start);
        if (Number.isFinite(args?.limit) && args.limit > 0) {
          slice = slice.slice(0, Math.floor(args.limit));
        }
        return { ok: true, output: slice.join('\n') };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    },

    /**
     * @param {{ path: string, content: string }} args
     */
    async write(args) {
      try {
        const filePath = await resolveSandboxedPath(root, args?.path, { forWrite: true });
        const content = typeof args?.content === 'string' ? args.content : '';
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return { ok: true, output: `Wrote ${filePath}` };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : 'Failed to write file',
        };
      }
    },

    /**
     * @param {{ path: string, old_string: string, new_string: string }} args
     */
    async edit(args) {
      try {
        const filePath = await resolveSandboxedPath(root, args?.path);
        const oldString = typeof args?.old_string === 'string' ? args.old_string : '';
        const newString = typeof args?.new_string === 'string' ? args.new_string : '';
        if (!oldString) {
          return { ok: false, output: '', error: 'old_string is required' };
        }
        const text = await fs.readFile(filePath, 'utf8');
        const parts = text.split(oldString);
        const matchCount = parts.length - 1;
        if (matchCount === 0) {
          return { ok: false, output: '', error: 'old_string not found' };
        }
        if (matchCount > 1) {
          return { ok: false, output: '', error: 'old_string matched more than once' };
        }
        await fs.writeFile(filePath, parts.join(newString), 'utf8');
        return { ok: true, output: `Edited ${filePath}` };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : 'Failed to edit file',
        };
      }
    },

    /**
     * @param {{ path: string }} args
     */
    async delete(args) {
      try {
        const filePath = await resolveSandboxedPath(root, args?.path);
        await fs.unlink(filePath);
        return { ok: true, output: `Deleted ${filePath}` };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : 'Failed to delete file',
        };
      }
    },

    /**
     * @param {{ path?: string }} args
     */
    async list(args) {
      try {
        const target = typeof args?.path === 'string' && args.path.trim()
          ? await resolveSandboxedPath(root, args.path.trim())
          : root;
        const entries = await fs.readdir(target, { withFileTypes: true });
        const lines = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((a, b) => a.localeCompare(b));
        return { ok: true, output: lines.join('\n') };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : 'Failed to list directory',
        };
      }
    },

    /**
     * @param {{ pattern: string, path?: string }} args
     */
    async glob(args) {
      try {
        const pattern = typeof args?.pattern === 'string' ? args.pattern.trim() : '';
        if (!pattern) {
          return { ok: false, output: '', error: 'pattern is required' };
        }
        const searchRoot = typeof args?.path === 'string' && args.path.trim()
          ? await resolveSandboxedPath(root, args.path.trim())
          : root;
        const matches = await walkGlob(searchRoot, pattern);
        const relative = matches
          .map((m) => path.relative(root, m))
          .sort((a, b) => a.localeCompare(b));
        return { ok: true, output: relative.join('\n') };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : 'Failed to glob',
        };
      }
    },

    /**
     * @param {{ pattern: string, path?: string, glob?: string, case_insensitive?: boolean }} args
     */
    async grep(args) {
      try {
        const pattern = typeof args?.pattern === 'string' ? args.pattern : '';
        if (!pattern) {
          return { ok: false, output: '', error: 'pattern is required' };
        }
        const searchRoot = typeof args?.path === 'string' && args.path.trim()
          ? await resolveSandboxedPath(root, args.path.trim())
          : root;
        const caseInsensitive = Boolean(args?.case_insensitive);
        const globFilter = typeof args?.glob === 'string' && args.glob.trim()
          ? args.glob.trim()
          : '';

        const rgArgs = ['--line-number', '--no-heading', '--color', 'never'];
        if (caseInsensitive) rgArgs.push('-i');
        if (globFilter) {
          rgArgs.push('--glob', globFilter);
        }
        rgArgs.push('--', pattern, searchRoot);
        const rgResult = await spawnCaptured('rg', rgArgs, {
          cwd: root,
          timeoutMs: Math.min(timeoutMs, 60_000),
        });
        // rg exit 0 = matches, 1 = no matches; both are success for tool UX.
        if (rgResult.exitCode === 0 || rgResult.exitCode === 1) {
          return {
            ok: true,
            output: truncateOutput(rgResult.output, MAX_GREP_OUTPUT_BYTES),
          };
        }

        const output = await nodeGrep(searchRoot, root, {
          pattern,
          caseInsensitive,
          globFilter,
        });
        return { ok: true, output: truncateOutput(output, MAX_GREP_OUTPUT_BYTES) };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : 'Failed to grep',
        };
      }
    },
  };
}

/**
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateOutput(text, maxBytes) {
  if (!text) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n…[truncated]`;
}

/**
 * @param {string} searchRoot
 * @param {string} displayRoot
 * @param {{ pattern: string, caseInsensitive: boolean, globFilter: string }} opts
 * @returns {Promise<string>}
 */
async function nodeGrep(searchRoot, displayRoot, opts) {
  let regex;
  try {
    regex = new RegExp(opts.pattern, opts.caseInsensitive ? 'i' : undefined);
  } catch {
    throw new Error('Invalid grep pattern');
  }

  /** @type {string[]} */
  const lines = [];
  const globRegex = opts.globFilter
    ? globPartToRegExp(opts.globFilter.replace(/^\*\*\//, ''))
    : null;

  /**
   * @param {string} dir
   */
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!isPathInsideRoot(full, searchRoot) && !isPathInsideRoot(full, displayRoot)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (globRegex && !globRegex.test(entry.name)) continue;
      let content;
      try {
        content = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const fileLines = content.split('\n');
      for (let i = 0; i < fileLines.length; i += 1) {
        if (regex.test(fileLines[i])) {
          const rel = path.relative(displayRoot, full);
          lines.push(`${rel}:${i + 1}:${fileLines[i]}`);
          if (Buffer.byteLength(lines.join('\n'), 'utf8') > MAX_GREP_OUTPUT_BYTES) {
            return;
          }
        }
      }
    }
  }

  await walk(searchRoot);
  return lines.join('\n');
}
