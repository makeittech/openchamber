import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  asSpawnableExecutable,
  assertClaudeWorkingDirectory,
  listBundledClaudeNativePackageNames,
  resolveClaudeCodeExecutable,
  rewriteAsarUnpackedPath,
} from './executable-path.js';

describe('rewriteAsarUnpackedPath', () => {
  it('rewrites app.asar segments to app.asar.unpacked', () => {
    const input = `/tmp/App/resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`;
    const expected = `/tmp/App/resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`;
    expect(rewriteAsarUnpackedPath(input)).toBe(expected);
  });

  it('leaves unpacked and non-asar paths alone', () => {
    const unpacked = `/tmp/App/resources/app.asar.unpacked/node_modules/x/claude`;
    expect(rewriteAsarUnpackedPath(unpacked)).toBe(unpacked);
    expect(rewriteAsarUnpackedPath('/usr/bin/claude')).toBe('/usr/bin/claude');
  });
});

describe('asSpawnableExecutable', () => {
  it('rejects missing or non-file paths after asar rewrite', () => {
    const files = new Map([
      ['/app/resources/app.asar.unpacked/node_modules/pkg/claude', { isFile: () => true }],
    ]);
    const fsLike = {
      existsSync: (filePath) => files.has(filePath),
      statSync: (filePath) => files.get(filePath) || { isFile: () => false },
    };

    expect(asSpawnableExecutable(
      '/app/resources/app.asar/node_modules/pkg/claude',
      fsLike,
    )).toBe('/app/resources/app.asar.unpacked/node_modules/pkg/claude');

    expect(asSpawnableExecutable('/missing', fsLike)).toBeNull();
  });
});

describe('resolveClaudeCodeExecutable', () => {
  it('prefers CLAUDE_CODE_EXECUTABLE over PATH', () => {
    const files = new Map([
      ['/opt/explicit/claude', { isFile: () => true }],
      ['/usr/bin/claude', { isFile: () => true }],
    ]);
    const resolved = resolveClaudeCodeExecutable({
      env: {
        CLAUDE_CODE_EXECUTABLE: '/opt/explicit/claude',
        PATH: '/usr/bin',
      },
      findOnPath: () => '/usr/bin/claude',
      existsSync: (filePath) => files.has(filePath),
      statSync: (filePath) => files.get(filePath) || { isFile: () => false },
    });
    expect(resolved).toBe('/opt/explicit/claude');
  });

  it('uses Electron unpacked native package when PATH has no claude', () => {
    const resourcesPath = '/tmp/OpenChamber.app/Contents/Resources';
    const candidate = path.join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-linux-x64',
      'claude',
    );
    const files = new Map([[candidate, { isFile: () => true }]]);
    const resolved = resolveClaudeCodeExecutable({
      env: { PATH: '' },
      resourcesPath,
      platform: 'linux',
      arch: 'x64',
      findOnPath: () => null,
      existsSync: (filePath) => files.has(filePath),
      statSync: (filePath) => files.get(filePath) || { isFile: () => false },
    });
    expect(resolved).toBe(candidate);
  });

  it('lists platform native package names', () => {
    expect(listBundledClaudeNativePackageNames({ platform: 'linux', arch: 'x64' })).toContain(
      'claude-agent-sdk-linux-x64',
    );
  });
});

describe('assertClaudeWorkingDirectory', () => {
  it('accepts real directories and rejects files/missing paths', () => {
    const dirs = new Set(['/project']);
    const fsLike = {
      existsSync: (filePath) => dirs.has(filePath) || filePath === '/file',
      statSync: (filePath) => ({
        isDirectory: () => dirs.has(filePath),
      }),
    };
    expect(assertClaudeWorkingDirectory('/project', fsLike)).toBe(path.resolve('/project'));
    expect(() => assertClaudeWorkingDirectory('/file', fsLike)).toThrow(/not a directory/i);
    expect(() => assertClaudeWorkingDirectory('', fsLike)).toThrow(/required/i);
  });
});
