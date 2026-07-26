import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostTools, isPathInsideRoot } from './host-tools.js';

/** @type {string[]} */
const tempDirs = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-host-tools-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('isPathInsideRoot', () => {
  it('accepts root and nested paths', () => {
    const root = path.resolve('/tmp/workspace-root');
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(path.join(root, 'src', 'a.js'), root)).toBe(true);
  });

  it('rejects sibling and parent escapes', () => {
    const root = path.resolve('/tmp/workspace-root');
    expect(isPathInsideRoot(path.resolve('/tmp/workspace-root-evil'), root)).toBe(false);
    expect(isPathInsideRoot(path.resolve('/tmp'), root)).toBe(false);
    expect(isPathInsideRoot(path.join(root, '..', 'other'), root)).toBe(false);
  });
});

describe('createHostTools sandbox', () => {
  it('rejects read/write outside cwd', async () => {
    const cwd = await makeTempDir();
    const tools = createHostTools({ cwd });
    const outside = path.join(cwd, '..', `escape-${Date.now()}.txt`);
    const read = await tools.read({ path: outside });
    expect(read.ok).toBe(false);
    expect(read.error).toMatch(/outside|accessible/i);

    const write = await tools.write({ path: outside, content: 'nope' });
    expect(write.ok).toBe(false);
    expect(write.error).toMatch(/outside|accessible/i);
  });

  it('supports write/read/edit/bash under cwd', async () => {
    const cwd = await makeTempDir();
    const tools = createHostTools({ cwd, timeoutMs: 15_000 });

    const written = await tools.write({ path: 'hello.txt', content: 'alpha\n' });
    expect(written.ok).toBe(true);

    const read = await tools.read({ path: 'hello.txt' });
    expect(read.ok).toBe(true);
    expect(read.output).toBe('alpha\n');

    const edited = await tools.edit({
      path: 'hello.txt',
      old_string: 'alpha',
      new_string: 'beta',
    });
    expect(edited.ok).toBe(true);

    const after = await tools.read({ path: 'hello.txt' });
    expect(after.output).toContain('beta');

    const bash = await tools.bash({ command: 'printf ok' });
    expect(bash.ok).toBe(true);
    expect(bash.output).toContain('ok');
  });

  it('errors when edit matches zero or multiple times', async () => {
    const cwd = await makeTempDir();
    const tools = createHostTools({ cwd });
    await tools.write({ path: 'a.txt', content: 'xx yy xx' });

    const none = await tools.edit({ path: 'a.txt', old_string: 'zz', new_string: 'q' });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/not found/i);

    const multi = await tools.edit({ path: 'a.txt', old_string: 'xx', new_string: 'q' });
    expect(multi.ok).toBe(false);
    expect(multi.error).toMatch(/more than once/i);
  });

  it('lists and globs files under cwd', async () => {
    const cwd = await makeTempDir();
    const tools = createHostTools({ cwd });
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src', 'a.js'), '1');
    await fs.writeFile(path.join(cwd, 'src', 'b.txt'), '2');

    const listed = await tools.list({ path: 'src' });
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain('a.js');
    expect(listed.output).toContain('b.txt');

    const globbed = await tools.glob({ pattern: '**/*.js' });
    expect(globbed.ok).toBe(true);
    expect(globbed.output).toContain(path.join('src', 'a.js'));
  });
});
