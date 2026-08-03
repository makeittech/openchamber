import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { HARNESS_CAPABILITIES } from '@/types/harness';

const originalFetch = globalThis.fetch;

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({ getActiveProject: () => ({ path: '/workspace/project' }) }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/fallback/project',
    setDirectory: () => undefined,
    sendMessage: async () => 'msg',
    shellSession: async () => undefined,
    sendCommand: async () => undefined,
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const { useHarnessStore } = await import('./useHarnessStore');

const capabilities = Object.fromEntries(HARNESS_CAPABILITIES.map((name) => [name, 'full']));
const catalog = (id: 'opencode' | 'claude-code') => ({
  descriptor: {
    id,
    displayName: id === 'opencode' ? 'OpenCode' : 'Claude Code',
    shortName: id === 'opencode' ? 'OpenCode' : 'Claude',
    auth: { mode: id === 'opencode' ? 'opencode-providers' : 'subscription-cli' },
    capabilities,
    install: { binaryNames: id === 'opencode' ? [] : ['claude'], docsUrl: `https://example.com/${id}` },
  },
  status: id === 'opencode' ? 'ready' : 'needs-login',
  ...(id === 'claude-code' ? { version: '1.2.3' } : {}),
  sections: id === 'claude-code'
    ? [{ id: 'models', name: 'Models', kind: 'models', models: [{ id: 'sonnet', name: 'Sonnet' }] }]
    : [],
});

const opencodeCatalog = catalog('opencode');
const claudeCatalog = catalog('claude-code');
const catalogResponse = () => jsonResponse({ catalogs: [opencodeCatalog, claudeCatalog] });
const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => catalogResponse();

beforeEach(() => {
  useHarnessStore.getState().resetForRuntimeSwitch();
  fetchImpl = async () => catalogResponse();
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init)) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('useHarnessStore', () => {
  test('refresh loads the catalog', async () => {
    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(true);
    const state = useHarnessStore.getState();
    expect(state.loadState).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.catalogs).toHaveLength(2);
    expect(state.catalogsById['claude-code']?.status).toBe('needs-login');
    expect(state.catalogsById['claude-code']?.version).toBe('1.2.3');
  });

  test('failure preserves a previous catalog but errors on the first load', async () => {
    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(true);
    fetchImpl = async () => jsonResponse({ error: 'boom' }, 503);

    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(false);
    let state = useHarnessStore.getState();
    expect(state.loadState).toBe('ready');
    expect(state.error).toBe('boom');
    expect(state.catalogs).toHaveLength(2);

    useHarnessStore.getState().resetForRuntimeSwitch();
    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(false);
    state = useHarnessStore.getState();
    expect(state.loadState).toBe('error');
    expect(state.error).toBe('boom');
    expect(state.catalogs).toEqual([]);
  });

  test('malformed success is a failure, not an authoritative empty catalog', async () => {
    fetchImpl = async () => jsonResponse({ catalogs: [{ bad: true }] });
    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(false);
    const state = useHarnessStore.getState();
    expect(state.catalogs).toEqual([]);
    expect(state.loadState).toBe('error');
    expect(state.error).toBe('Invalid harness catalog response');
  });

  test('detect updates only its catalog and preserves both catalogs on failure', async () => {
    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(true);
    fetchImpl = async (input) => String(input).includes('/detect')
      ? jsonResponse({ ...claudeCatalog, status: 'ready', version: '9.9.9' })
      : catalogResponse();

    expect(await useHarnessStore.getState().detect('claude-code')).toBe(true);
    expect(useHarnessStore.getState().catalogsById['claude-code']?.status).toBe('ready');
    expect(useHarnessStore.getState().catalogsById['claude-code']?.version).toBe('9.9.9');
    expect(useHarnessStore.getState().catalogsById.opencode?.status).toBe('ready');

    fetchImpl = async () => jsonResponse({ error: 'detect failed' }, 500);
    expect(await useHarnessStore.getState().detect('claude-code')).toBe(false);
    expect(useHarnessStore.getState().error).toBe('detect failed');
    expect(useHarnessStore.getState().catalogs).toHaveLength(2);
  });

  test('runtime reset rejects an in-flight catalog load', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchImpl = () => new Promise((resolve) => { resolveResponse = resolve; });
    const refresh = useHarnessStore.getState().refresh({ force: true });

    useHarnessStore.getState().resetForRuntimeSwitch();
    resolveResponse?.(catalogResponse());

    expect(await refresh).toBe(false);
    const state = useHarnessStore.getState();
    expect(state.catalogs).toEqual([]);
    expect(state.loadState).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.scopeKey).toBeNull();
  });
});
