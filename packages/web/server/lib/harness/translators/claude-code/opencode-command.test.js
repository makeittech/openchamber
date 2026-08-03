import { describe, expect, it } from 'bun:test';
import {
  createOpenCodeCommandResolver,
  expandOpenCodeCommandTemplate,
  normalizeOpenCodeCommandRequest,
  resolveOpenCodeCommandDefinition,
  translateOpenCodeCommandForClaude,
} from './opencode-command.js';

const buildOpenCodeUrl = (path) => `http://127.0.0.1:4096${path}`;

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

describe('normalizeOpenCodeCommandRequest', () => {
  it('accepts a name with optional arguments', () => {
    expect(normalizeOpenCodeCommandRequest({ name: ' pr-review ', arguments: ' 42 ' }))
      .toEqual({ name: 'pr-review', args: '42' });
    expect(normalizeOpenCodeCommandRequest({ name: 'changelog' }))
      .toEqual({ name: 'changelog', args: '' });
  });

  it('rejects anything without a usable name', () => {
    expect(normalizeOpenCodeCommandRequest(null)).toBeNull();
    expect(normalizeOpenCodeCommandRequest('pr-review')).toBeNull();
    expect(normalizeOpenCodeCommandRequest({ name: '   ' })).toBeNull();
    expect(normalizeOpenCodeCommandRequest([{ name: 'x' }])).toBeNull();
  });
});

describe('expandOpenCodeCommandTemplate', () => {
  it('substitutes every $ARGUMENTS occurrence', async () => {
    const text = await expandOpenCodeCommandTemplate({
      template: 'Review $ARGUMENTS then summarize $ARGUMENTS',
      args: 'PR 42',
      cwd: '/tmp',
    });
    expect(text).toBe('Review PR 42 then summarize PR 42');
  });

  it('substitutes an empty string when no arguments were typed', async () => {
    const text = await expandOpenCodeCommandTemplate({
      template: 'Review this pull request: $ARGUMENTS',
      cwd: '/tmp',
    });
    expect(text).toBe('Review this pull request: ');
  });

  it('appends arguments when the template has no placeholder', async () => {
    const text = await expandOpenCodeCommandTemplate({
      template: 'Draft the changelog.\n',
      args: 'since v1.2.0',
      cwd: '/tmp',
    });
    expect(text).toBe('Draft the changelog.\n\nsince v1.2.0');
  });

  it('runs shell substitutions in template order and keeps surrounding text', async () => {
    const calls = [];
    const text = await expandOpenCodeCommandTemplate({
      template: 'head:\n!`first`\ntail:\n!`second`\ndone',
      cwd: '/repo',
      runShell: async (command, cwd) => {
        calls.push({ command, cwd });
        return { output: `<${command}>`, failed: false };
      },
    });
    expect(calls).toEqual([
      { command: 'first', cwd: '/repo' },
      { command: 'second', cwd: '/repo' },
    ]);
    expect(text).toBe('head:\n<first>\ntail:\n<second>\ndone');
  });

  it('keeps the rest of the template when one shell substitution fails', async () => {
    const text = await expandOpenCodeCommandTemplate({
      template: 'a !`boom` b !`ok` c',
      cwd: '/repo',
      runShell: async (command) => (command === 'boom'
        ? { output: '[command failed: exit 1]', failed: true }
        : { output: 'fine', failed: false }),
    });
    expect(text).toBe('a [command failed: exit 1] b fine c');
  });

  it('really executes shell substitutions in the given cwd', async () => {
    const text = await expandOpenCodeCommandTemplate({
      template: 'value=!`echo harness-ok`',
      cwd: process.cwd(),
    });
    expect(text).toBe('value=harness-ok');
  });

  it('reports a real non-zero exit without repeating the command output', async () => {
    const text = await expandOpenCodeCommandTemplate({
      template: '!`echo boom >&2; exit 3`',
      cwd: process.cwd(),
    });
    // execFile folds stderr into error.message, so building the reason from it
    // would print "boom" twice.
    expect(text).toBe('[command failed: exit 3]\nboom');
  });

  it('bounds how many shell substitutions one template may run', async () => {
    let ran = 0;
    const template = Array.from({ length: 25 }, (_, i) => `!\`cmd${i}\``).join(' ');
    const text = await expandOpenCodeCommandTemplate({
      template,
      cwd: '/repo',
      runShell: async () => {
        ran += 1;
        return { output: 'x', failed: false };
      },
    });
    expect(ran).toBe(20);
    expect(text).toContain('[command skipped:');
  });
});

describe('resolveOpenCodeCommandDefinition', () => {
  it('returns the authoritative template from OpenCode', async () => {
    let requestedUrl = '';
    const definition = await resolveOpenCodeCommandDefinition({
      name: 'PR-Review',
      directory: '/repo/a b',
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      fetchImpl: async (url) => {
        requestedUrl = url;
        return jsonResponse([
          { name: 'changelog', template: 'other' },
          { name: 'pr-review', template: 'Review $ARGUMENTS' },
        ]);
      },
    });
    expect(definition).toEqual({ name: 'pr-review', template: 'Review $ARGUMENTS' });
    expect(requestedUrl).toBe('http://127.0.0.1:4096/command?directory=%2Frepo%2Fa%20b');
  });

  it('reports a missing command as not found', async () => {
    const caught = await resolveOpenCodeCommandDefinition({
      name: 'nope',
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse([]),
    }).catch((error) => error);
    expect(caught.code).toBe('COMMAND_NOT_FOUND');
    expect(caught.statusCode).toBe(404);
  });

  it('does not turn an upstream failure into a missing command', async () => {
    const failed = await resolveOpenCodeCommandDefinition({
      name: 'pr-review',
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse({ error: 'boom' }, 500),
    }).catch((error) => error);
    expect(failed.code).toBe('COMMAND_LOOKUP_FAILED');
    expect(failed.statusCode).toBe(502);

    const threw = await resolveOpenCodeCommandDefinition({
      name: 'pr-review',
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }).catch((error) => error);
    expect(threw.code).toBe('COMMAND_LOOKUP_FAILED');
  });

  it('fails closed when OpenCode is unreachable by configuration', async () => {
    const caught = await resolveOpenCodeCommandDefinition({
      name: 'pr-review',
      directory: '/repo',
    }).catch((error) => error);
    expect(caught.code).toBe('COMMAND_UNAVAILABLE');
    expect(caught.statusCode).toBe(503);
  });
});

describe('translateOpenCodeCommandForClaude', () => {
  it('resolves and expands a command into Claude prompt text', async () => {
    const result = await translateOpenCodeCommandForClaude({
      name: 'pr-review',
      args: '2480',
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse([
        { name: 'pr-review', template: 'Review this pull request: $ARGUMENTS\n\nBranch: !`git branch`' },
      ]),
      runShell: async () => ({ output: 'main', failed: false }),
    });
    expect(result).toEqual({
      name: 'pr-review',
      text: 'Review this pull request: 2480\n\nBranch: main',
    });
  });

  it('rejects a command whose template is empty', async () => {
    const caught = await translateOpenCodeCommandForClaude({
      name: 'blank',
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse([{ name: 'blank', template: '   ' }]),
    }).catch((error) => error);
    expect(caught.code).toBe('COMMAND_INVALID');
  });

  it('binds OpenCode transport into a translator dependency', async () => {
    const resolve = createOpenCodeCommandResolver({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async () => jsonResponse([{ name: 'pr-review', template: 'Review $ARGUMENTS' }]),
    });
    expect(await resolve({ name: 'pr-review', args: '7', directory: '/repo' }))
      .toEqual({ name: 'pr-review', text: 'Review 7' });
  });

  it('has no resolver when the runtime cannot reach OpenCode', () => {
    expect(createOpenCodeCommandResolver({})).toBeNull();
    expect(createOpenCodeCommandResolver({ buildOpenCodeUrl: null })).toBeNull();
  });

  it('leaves @file mentions for Claude to resolve natively', async () => {
    const result = await translateOpenCodeCommandForClaude({
      name: 'changelog',
      directory: '/repo',
      buildOpenCodeUrl,
      fetchImpl: async () => jsonResponse([
        { name: 'changelog', template: 'You are updating @CHANGELOG.md.' },
      ]),
    });
    expect(result.text).toBe('You are updating @CHANGELOG.md.');
  });
});
