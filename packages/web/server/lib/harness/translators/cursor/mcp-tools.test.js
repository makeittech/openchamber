import { describe, expect, it } from 'bun:test';
import { toBinary, fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  buildOpenChamberMcpTools,
  decodeMcpArgValue,
  decodeMcpArgsMap,
  executeMcpTool,
  normalizeMcpToolName,
} from './mcp-tools.js';

describe('buildOpenChamberMcpTools', () => {
  it('returns non-empty openchamber MCP tool definitions', () => {
    const tools = buildOpenChamberMcpTools();
    expect(tools.length).toBeGreaterThanOrEqual(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read');
    expect(names).toContain('grep');
    for (const tool of tools) {
      expect(tool.providerIdentifier).toBe('openchamber');
      expect(tool.inputSchema?.byteLength ?? tool.inputSchema?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('decodeMcpArgsMap', () => {
  it('decodes protobuf Value bytes to JSON values', () => {
    const encoded = toBinary(ValueSchema, fromJson(ValueSchema, 'hello'));
    expect(decodeMcpArgValue(encoded)).toBe('hello');

    const args = decodeMcpArgsMap({
      command: toBinary(ValueSchema, fromJson(ValueSchema, 'echo hi')),
      n: toBinary(ValueSchema, fromJson(ValueSchema, 3)),
    });
    expect(args.command).toBe('echo hi');
    expect(args.n).toBe(3);
  });
});

describe('executeMcpTool', () => {
  it('executes bash and read via injected hostTools mock', async () => {
    const calls = [];
    const hostTools = {
      async bash(args) {
        calls.push(['bash', args]);
        return { ok: true, output: 'ran' };
      },
      async read(args) {
        calls.push(['read', args]);
        return { ok: true, output: 'file-body' };
      },
      async write() { return { ok: false, output: '', error: 'unused' }; },
      async edit() { return { ok: false, output: '', error: 'unused' }; },
      async delete() { return { ok: false, output: '', error: 'unused' }; },
      async list() { return { ok: false, output: '', error: 'unused' }; },
      async glob() { return { ok: false, output: '', error: 'unused' }; },
      async grep() { return { ok: false, output: '', error: 'unused' }; },
    };

    const bash = await executeMcpTool('bash', { command: 'true' }, hostTools);
    expect(bash).toEqual({ ok: true, text: 'ran' });

    const shellAlias = await executeMcpTool('shell', { command: 'true' }, hostTools);
    expect(shellAlias.ok).toBe(true);
    expect(normalizeMcpToolName('shell')).toBe('bash');

    const read = await executeMcpTool('read', { path: 'a.txt' }, hostTools);
    expect(read).toEqual({ ok: true, text: 'file-body' });

    expect(calls[0][0]).toBe('bash');
    expect(calls[1][0]).toBe('bash');
    expect(calls[2][0]).toBe('read');
  });

  it('returns error text for unknown tools and host failures', async () => {
    const hostTools = {
      async bash() { return { ok: false, output: '', error: 'boom' }; },
      async read() { return { ok: true, output: '' }; },
      async write() { return { ok: true, output: '' }; },
      async edit() { return { ok: true, output: '' }; },
      async delete() { return { ok: true, output: '' }; },
      async list() { return { ok: true, output: '' }; },
      async glob() { return { ok: true, output: '' }; },
      async grep() { return { ok: true, output: '' }; },
    };
    const unknown = await executeMcpTool('nope', {}, hostTools);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toMatch(/Unknown MCP tool/i);

    const failed = await executeMcpTool('bash', { command: 'x' }, hostTools);
    expect(failed).toEqual({ ok: false, text: 'boom' });
  });
});
