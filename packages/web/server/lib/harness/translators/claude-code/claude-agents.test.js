import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  CLAUDE_BUILTIN_AGENTS,
  listClaudeAgents,
  parseClaudeAgentFrontmatter,
} from './claude-agents.js';

/**
 * @param {string} name
 * @param {boolean} isDirectory
 */
function dirent(name, isDirectory) {
  return {
    name,
    isDirectory: () => isDirectory,
    isFile: () => !isDirectory,
  };
}

function enoent() {
  const error = new Error('ENOENT: no such file or directory');
  error.code = 'ENOENT';
  return error;
}

function eacces() {
  const error = new Error('EACCES: permission denied');
  error.code = 'EACCES';
  return error;
}

describe('parseClaudeAgentFrontmatter', () => {
  it('parses full frontmatter', () => {
    const text = [
      '---',
      'name: my-agent',
      'description: Does a thing',
      'model: sonnet',
      'tools: Read, Grep',
      '---',
      'Body text goes here.',
    ].join('\n');
    expect(parseClaudeAgentFrontmatter(text)).toEqual({
      name: 'my-agent',
      description: 'Does a thing',
      model: 'sonnet',
    });
  });

  it('returns all-empty fields when frontmatter is missing entirely', () => {
    expect(parseClaudeAgentFrontmatter('Just a plain markdown body.\nNo frontmatter here.'))
      .toEqual({ name: '', description: '', model: '' });
    expect(parseClaudeAgentFrontmatter('')).toEqual({ name: '', description: '', model: '' });
  });

  it('strips matching single or double outer quotes', () => {
    const text = [
      '---',
      'name: "quoted-name"',
      "description: 'single quoted description'",
      'model: unquoted',
      '---',
    ].join('\n');
    expect(parseClaudeAgentFrontmatter(text)).toEqual({
      name: 'quoted-name',
      description: 'single quoted description',
      model: 'unquoted',
    });
  });

  it('ignores frontmatter keys other than name/description/model', () => {
    const text = [
      '---',
      'name: agent-x',
      'color: blue',
      'tools: Read, Grep',
      'unknownKey: whatever',
      '---',
    ].join('\n');
    expect(parseClaudeAgentFrontmatter(text)).toEqual({ name: 'agent-x', description: '', model: '' });
  });

  it('does not throw and returns whatever was parsed when there is no closing delimiter', () => {
    const text = [
      '---',
      'name: unterminated',
      'description: still readable',
    ].join('\n');
    expect(parseClaudeAgentFrontmatter(text)).toEqual({
      name: 'unterminated',
      description: 'still readable',
      model: '',
    });
  });
});

describe('listClaudeAgents', () => {
  it('always includes the builtins, in declared order, with builtin source', async () => {
    const result = await listClaudeAgents({
      env: {},
      homeDir: '/home/nobody',
      readDirImpl: async () => { throw enoent(); },
    });
    expect(result.agents).toEqual(
      CLAUDE_BUILTIN_AGENTS.map((agent) => ({ ...agent, model: '', source: 'builtin' })),
    );
  });

  it('falls back to the file basename when frontmatter omits name', async () => {
    const userAgentsDir = '/config/agents';
    const readDirImpl = async (dirPath) => {
      if (dirPath === userAgentsDir) return [dirent('no-name-field.md', false)];
      throw enoent();
    };
    const readFileImpl = async (filePath) => {
      if (filePath === path.join(userAgentsDir, 'no-name-field.md')) {
        return '---\ndescription: has no name key\n---\n';
      }
      throw enoent();
    };
    const result = await listClaudeAgents({
      env: { CLAUDE_CONFIG_DIR: '/config' },
      homeDir: '/home/nobody',
      readDirImpl,
      readFileImpl,
    });
    const fallback = result.agents.find((agent) => agent.source === 'user');
    expect(fallback).toEqual({
      name: 'no-name-field',
      description: 'has no name key',
      model: '',
      source: 'user',
    });
  });

  it('merges user + project agents, with a project agent overriding a same-named user agent in place', async () => {
    const userAgentsDir = '/config/agents';
    const projectAgentsDir = path.join('/repo', '.claude', 'agents');

    const readDirImpl = async (dirPath) => {
      if (dirPath === userAgentsDir) return [dirent('helper.md', false)];
      if (dirPath === projectAgentsDir) return [dirent('helper.md', false), dirent('zzz.md', false)];
      throw enoent();
    };
    const readFileImpl = async (filePath) => {
      if (filePath === path.join(userAgentsDir, 'helper.md')) {
        return '---\nname: helper\ndescription: user helper\nmodel: sonnet\n---\n';
      }
      if (filePath === path.join(projectAgentsDir, 'helper.md')) {
        return '---\nname: Helper\ndescription: project helper override\nmodel: opus\n---\n';
      }
      if (filePath === path.join(projectAgentsDir, 'zzz.md')) {
        return '---\nname: zzz\ndescription: a brand new project agent\n---\n';
      }
      throw enoent();
    };

    const result = await listClaudeAgents({
      directory: '/repo',
      env: { CLAUDE_CONFIG_DIR: '/config' },
      homeDir: '/home/nobody',
      readDirImpl,
      readFileImpl,
    });

    // 3 builtins, then the (overridden) helper entry, then the new zzz entry.
    expect(result.agents).toHaveLength(5);
    expect(result.agents[3]).toEqual({
      name: 'Helper',
      description: 'project helper override',
      model: 'opus',
      source: 'project',
    });
    expect(result.agents[4]).toEqual({
      name: 'zzz',
      description: 'a brand new project agent',
      model: '',
      source: 'project',
    });
    expect(result.roots).toEqual({ user: userAgentsDir, project: projectAgentsDir });
  });

  it('returns builtins and null roots when both the user and project agents directories are missing, without throwing', async () => {
    const result = await listClaudeAgents({
      directory: '/repo/does-not-matter',
      env: {},
      homeDir: '/home/nobody',
      readDirImpl: async () => { throw enoent(); },
      readFileImpl: async () => { throw enoent(); },
    });
    expect(result.roots).toEqual({ user: null, project: null });
    expect(result.agents).toEqual(
      CLAUDE_BUILTIN_AGENTS.map((agent) => ({ ...agent, model: '', source: 'builtin' })),
    );
  });

  it('lets one root fail with EACCES without preventing the other root from contributing', async () => {
    const projectAgentsDir = path.join('/repo', '.claude', 'agents');
    const readDirImpl = async (dirPath) => {
      if (dirPath === '/home/nobody/.claude/agents') throw eacces();
      if (dirPath === '/home/nobody/.config/claude/agents') throw eacces();
      if (dirPath === projectAgentsDir) return [dirent('local.md', false)];
      throw enoent();
    };
    const readFileImpl = async (filePath) => {
      if (filePath === path.join(projectAgentsDir, 'local.md')) {
        return '---\nname: local\ndescription: project-only agent\n---\n';
      }
      throw enoent();
    };

    const result = await listClaudeAgents({
      directory: '/repo',
      env: {},
      homeDir: '/home/nobody',
      readDirImpl,
      readFileImpl,
    });

    expect(result.roots.user).toBeNull();
    expect(result.roots.project).toBe(projectAgentsDir);
    expect(result.agents.find((agent) => agent.name === 'local')).toEqual({
      name: 'local',
      description: 'project-only agent',
      model: '',
      source: 'project',
    });
  });

  it('caps total scanned files at 200 across a wide directory', async () => {
    const userAgentsDir = '/config/agents';
    const wideEntries = Array.from({ length: 300 }, (_, i) => dirent(`agent${i}.md`, false));
    const readDirImpl = async (dirPath) => {
      if (dirPath === userAgentsDir) return wideEntries;
      throw enoent();
    };
    const readFileImpl = async () => '---\ndescription: wide\n---\n';

    const result = await listClaudeAgents({
      env: { CLAUDE_CONFIG_DIR: '/config' },
      homeDir: '/home/nobody',
      readDirImpl,
      readFileImpl,
    });

    const userAgents = result.agents.filter((agent) => agent.source === 'user');
    expect(userAgents).toHaveLength(200);
  });

  it('caps recursion depth so a deeply nested tree does not hang or return unbounded results', async () => {
    const userAgentsDir = '/config/agents';
    const depth = 20;
    const dirName = (level) => `level${level}`;
    const dirPathAt = (level) => path.join(userAgentsDir, ...Array.from({ length: level }, (_, i) => dirName(i + 1)));

    const readDirImpl = async (dirPath) => {
      if (dirPath === userAgentsDir) {
        return [dirent(dirName(1), true), dirent('root.md', false)];
      }
      for (let level = 1; level <= depth; level += 1) {
        if (dirPath === dirPathAt(level)) {
          const entries = [dirent(`agent-at-${level}.md`, false)];
          if (level < depth) entries.push(dirent(dirName(level + 1), true));
          return entries;
        }
      }
      throw enoent();
    };
    const readFileImpl = async () => '---\ndescription: nested\n---\n';

    const result = await listClaudeAgents({
      env: { CLAUDE_CONFIG_DIR: '/config' },
      homeDir: '/home/nobody',
      readDirImpl,
      readFileImpl,
    });

    const userAgents = result.agents.filter((agent) => agent.source === 'user');
    const names = userAgents.map((agent) => agent.name);
    // Root-level file is always reached.
    expect(names).toContain('root');
    // The deepest levels (well past any reasonable depth cap) must never be reached.
    expect(names).not.toContain(`agent-at-${depth}`);
    expect(names).not.toContain(`agent-at-${depth - 1}`);
    // The cap must actually bound recursion, not just "eventually stop".
    expect(userAgents.length).toBeLessThan(depth);
  });

  it('truncates description to 500 characters', async () => {
    const userAgentsDir = '/config/agents';
    const longDescription = 'x'.repeat(600);
    const readDirImpl = async (dirPath) => {
      if (dirPath === userAgentsDir) return [dirent('long.md', false)];
      throw enoent();
    };
    const readFileImpl = async (filePath) => {
      if (filePath === path.join(userAgentsDir, 'long.md')) {
        return `---\nname: long\ndescription: ${longDescription}\n---\n`;
      }
      throw enoent();
    };

    const result = await listClaudeAgents({
      env: { CLAUDE_CONFIG_DIR: '/config' },
      homeDir: '/home/nobody',
      readDirImpl,
      readFileImpl,
    });

    const long = result.agents.find((agent) => agent.name === 'long');
    expect(long.description).toHaveLength(500);
    expect(long.description).toBe('x'.repeat(500));
  });

  it('reports project root as null when directory is empty/undefined', async () => {
    const result = await listClaudeAgents({
      env: {},
      homeDir: '/home/nobody',
      readDirImpl: async () => { throw enoent(); },
    });
    expect(result.roots.project).toBeNull();

    const resultUndefinedDirectory = await listClaudeAgents({
      readDirImpl: async () => { throw enoent(); },
      env: {},
      homeDir: '/home/nobody',
    });
    expect(resultUndefinedDirectory.roots.project).toBeNull();
  });
});
