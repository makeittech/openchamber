import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PENDING_RETRY_RECORDS,
  MAX_PENDING_RETRY_STORE_BYTES,
  RETRY_STORE_UNAVAILABLE,
  createPendingRetryStore,
  resolvePendingRetryStorePath,
  sanitizePendingRetryRecord,
} from './pending-retry-store.js';

/** @type {string[]} */
const tempDirs = [];
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;

function makeStorePath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pending-retries-'));
  tempDirs.push(root);
  const directory = path.join(root, 'private');
  return {
    directory,
    filePath: path.join(directory, 'harness-pending-retries.json'),
  };
}

function makeRecord(overrides = {}) {
  return {
    sessionId: 'ses_1',
    directory: '/repo',
    foreignSessionId: 'claude-1',
    target: {
      harnessId: 'claude-code',
      modelRef: 'sonnet',
      permissionMode: 'acceptEdits',
      effort: 'high',
    },
    agentsMode: 'opencode',
    agentName: 'build',
    claudeAgentName: 'reviewer',
    state: 'waiting',
    generation: 1,
    attempt: 1,
    rateLimitType: 'five_hour',
    resetAt: 1_800_000_000_000,
    nextAttemptAt: 1_800_000_001_000,
    rateLimitAssistantUuid: 'assistant-uuid',
    expectedTailUuid: 'tail-uuid',
    launchUuid: 'launch-uuid',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    blockedReason: 'transcript-ambiguous',
    ...overrides,
  };
}

function makeMinimalRecord(overrides = {}) {
  return {
    sessionId: 'ses_minimal',
    directory: '/repo',
    target: { harnessId: 'claude-code' },
    state: 'waiting',
    generation: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function omitField(record, field) {
  const copy = { ...record };
  delete copy[field];
  return copy;
}

function readPayload(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeFixture(filePath, content, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  fs.writeFileSync(filePath, content, { mode });
  if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
}

function makeFsError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected callback to throw');
}

function withFsFailures({
  failRename = () => false,
  failChmod = () => false,
  chmodErrorCode = () => null,
  readErrorCode = () => null,
  fstatErrorCode = () => null,
  fsyncErrorCode = () => null,
  transformFstat = (stats) => stats,
  transformLstat = (stats) => stats,
  operations,
} = {}) {
  const pathsByFd = new Map();
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'openSync') {
        return (...args) => {
          const fd = target.openSync(...args);
          pathsByFd.set(fd, String(args[0]));
          operations?.push(`open:${String(args[0])}`);
          return fd;
        };
      }
      if (property === 'fstatSync') {
        return (fd, ...args) => {
          const filePath = pathsByFd.get(fd);
          const code = fstatErrorCode(filePath, fd);
          if (code) throw makeFsError(code, 'injected fstat failure');
          operations?.push(`fstat:${filePath}`);
          return transformFstat(target.fstatSync(fd, ...args), filePath);
        };
      }
      if (property === 'lstatSync') {
        return (targetPath, ...args) => transformLstat(
          target.lstatSync(targetPath, ...args),
          String(targetPath),
        );
      }
      if (property === 'readSync') {
        return (fd, ...args) => {
          const filePath = pathsByFd.get(fd);
          const code = readErrorCode(filePath, fd);
          if (code) throw makeFsError(code, 'injected read failure');
          operations?.push(`read:${filePath}`);
          return target.readSync(fd, ...args);
        };
      }
      if (property === 'writeSync') {
        return (fd, ...args) => {
          const filePath = pathsByFd.get(fd);
          operations?.push(`write:${filePath}`);
          return target.writeSync(fd, ...args);
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          const filePath = pathsByFd.get(fd);
          const code = fsyncErrorCode(filePath, fd);
          if (code) throw makeFsError(code, 'injected fsync failure');
          operations?.push(`fsync:${filePath}`);
          return target.fsyncSync(fd);
        };
      }
      if (property === 'closeSync') {
        return (fd) => {
          const filePath = pathsByFd.get(fd);
          operations?.push(`close:${filePath}`);
          try {
            return target.closeSync(fd);
          } finally {
            pathsByFd.delete(fd);
          }
        };
      }
      if (property === 'renameSync') {
        return (...args) => {
          if (failRename()) {
            const error = new Error('injected rename failure');
            error.code = 'EIO';
            throw error;
          }
          operations?.push(`rename:${String(args[0])}->${String(args[1])}`);
          return target.renameSync(...args);
        };
      }
      if (property === 'chmodSync') {
        return (...args) => {
          const code = chmodErrorCode(...args) || (failChmod() ? 'ENOTSUP' : null);
          if (code) {
            const error = new Error('chmod unsupported');
            error.code = code;
            throw error;
          }
          return target.chmodSync(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('pending retry store paths and bounds', () => {
  it('resolves the production data path with the documented fallback', () => {
    const { directory } = makeStorePath();
    process.env.OPENCHAMBER_DATA_DIR = directory;
    expect(resolvePendingRetryStorePath()).toBe(
      path.join(path.resolve(directory), 'harness-pending-retries.json'),
    );

    delete process.env.OPENCHAMBER_DATA_DIR;
    expect(resolvePendingRetryStorePath()).toBe(
      path.join(os.homedir(), '.config', 'openchamber', 'harness-pending-retries.json'),
    );
  });

  it('publishes explicit default store bounds', () => {
    expect(MAX_PENDING_RETRY_RECORDS).toBe(500);
    expect(MAX_PENDING_RETRY_STORE_BYTES).toBe(1024 * 1024);
  });

  it('does not allow a factory override to raise the hard record cap', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({
      filePath,
      maxRecords: MAX_PENDING_RETRY_RECORDS + 500,
    });
    store.init();
    const records = Array.from(
      { length: MAX_PENDING_RETRY_RECORDS + 1 },
      (_, index) => makeMinimalRecord({ sessionId: `ses_${index}` }),
    );

    const error = captureError(() => store.replace(records));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('does not allow a factory override to raise the hard byte cap', () => {
    const { filePath } = makeStorePath();
    const validPrefix = JSON.stringify({ version: 1, retries: [] });
    writeFixture(
      filePath,
      `${validPrefix}${' '.repeat(MAX_PENDING_RETRY_STORE_BYTES + 1)}`,
    );
    const store = createPendingRetryStore({
      filePath,
      maxBytes: MAX_PENDING_RETRY_STORE_BYTES * 2,
    });

    const error = captureError(() => store.init());
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
  });
});

describe('harness pending retry exports', () => {
  it('exports focused operations without exposing the mutable production singleton', async () => {
    const harnessApi = await import('./index.js');
    for (const name of [
      'createPendingRetryStore',
      'resolvePendingRetryStorePath',
      'sanitizePendingRetryRecord',
      'initPendingRetryStore',
      'getPendingRetry',
      'listPendingRetries',
      'putPendingRetry',
      'deletePendingRetry',
      'replacePendingRetries',
    ]) {
      expect(typeof harnessApi[name], name).toBe('function');
    }
    expect('pendingRetryStore' in harnessApi).toBe(false);
  });
});

describe('sanitizePendingRetryRecord', () => {
  it('keeps only bounded recovery metadata and safe Claude target fields', () => {
    const sanitized = sanitizePendingRetryRecord(makeRecord({
      sessionId: 's'.repeat(512),
      directory: `/${'d'.repeat(4095)}`,
      foreignSessionId: 'f'.repeat(512),
      target: {
        harnessId: 'claude-code',
        modelRef: 'm'.repeat(200),
        permissionMode: 'bypassPermissions',
        effort: 'unlimited',
        token: 'target-secret',
        providerId: 'anthropic',
      },
      agentsMode: 'invalid',
      agentName: `  ${'a'.repeat(250)}  `,
      claudeAgentName: `  ${'c'.repeat(250)}  `,
      state: 'waiting',
      generation: -4,
      attempt: 3.9,
      resetAt: Number.POSITIVE_INFINITY,
      nextAttemptAt: Number.MAX_VALUE,
      prompt: 'private prompt',
      files: [{ url: 'private attachment' }],
      toolOutput: 'private tool output',
      token: 'private token',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'private oauth' },
      arbitrary: { nested: true },
    }));

    expect(sanitized.sessionId).toHaveLength(512);
    expect(sanitized.directory).toHaveLength(4096);
    expect(sanitized.foreignSessionId).toHaveLength(512);
    expect(sanitized.target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'm'.repeat(200),
    });
    expect(sanitized.agentName).toBe('a'.repeat(200));
    expect(sanitized.claudeAgentName).toBe('c'.repeat(200));
    expect(sanitized.agentsMode).toBeUndefined();
    expect(sanitized.generation).toBe(0);
    expect(sanitized.attempt).toBe(3);
    expect(sanitized.resetAt).toBeUndefined();
    expect(sanitized.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(Object.keys(sanitized).sort()).toEqual([
      'agentName',
      'attempt',
      'blockedReason',
      'claudeAgentName',
      'createdAt',
      'directory',
      'expectedTailUuid',
      'foreignSessionId',
      'generation',
      'launchUuid',
      'nextAttemptAt',
      'rateLimitAssistantUuid',
      'rateLimitType',
      'sessionId',
      'state',
      'target',
      'updatedAt',
    ]);
  });

  it('rejects records without a Claude recovery identity or valid state', () => {
    expect(sanitizePendingRetryRecord(null)).toBeNull();
    expect(sanitizePendingRetryRecord(makeRecord({ sessionId: '   ' }))).toBeNull();
    expect(sanitizePendingRetryRecord(makeRecord({ directory: '' }))).toBeNull();
    expect(sanitizePendingRetryRecord(makeRecord({ target: { harnessId: 'opencode' } }))).toBeNull();
    expect(sanitizePendingRetryRecord(makeRecord({ state: 'idle' }))).toBeNull();
  });

  it('rejects invalid authority identifiers instead of trimming or truncating them', () => {
    const invalidRecords = [
      makeRecord({ sessionId: ' ses_1' }),
      makeRecord({ sessionId: 'ses_1 ' }),
      makeRecord({ sessionId: 's'.repeat(513) }),
      makeRecord({ sessionId: 'ses_\0bad' }),
      makeRecord({ foreignSessionId: ' claude-1' }),
      makeRecord({ foreignSessionId: 'f'.repeat(513) }),
      makeRecord({ expectedTailUuid: 'tail\0uuid' }),
      makeRecord({ launchUuid: ' launch-uuid' }),
      makeRecord({ target: { ...makeRecord().target, modelRef: ' sonnet' } }),
      makeRecord({ target: { ...makeRecord().target, modelRef: 'm'.repeat(201) } }),
    ];

    for (const record of invalidRecords) {
      expect(sanitizePendingRetryRecord(record)).toBeNull();
    }
  });

  it('preserves an exact bounded absolute directory and rejects unsafe paths', () => {
    const directory = '/repo with space/project ';
    expect(sanitizePendingRetryRecord(makeRecord({ directory })).directory).toBe(directory);
    expect(sanitizePendingRetryRecord(makeRecord({ directory: 'relative/repo' }))).toBeNull();
    expect(sanitizePendingRetryRecord(makeRecord({ directory: '/repo\0secret' }))).toBeNull();
    expect(sanitizePendingRetryRecord(makeRecord({ directory: `/${'d'.repeat(4096)}` }))).toBeNull();
  });

  it('accepts only a bounded lowercase blocked reason code', () => {
    expect(sanitizePendingRetryRecord(makeRecord({ blockedReason: 'recovery-blocked' })).blockedReason)
      .toBe('recovery-blocked');
    for (const blockedReason of [
      'Recovery blocked',
      'recovery_blocked',
      'a'.repeat(65),
      '-recovery',
    ]) {
      expect(sanitizePendingRetryRecord(makeRecord({ blockedReason }))).toBeNull();
    }
  });
});

describe('durable pending retry journal', () => {
  it('round-trips only allowlisted recovery metadata in a secure versioned file', () => {
    const { directory, filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    expect(store.init()).toEqual({ records: [] });

    const stored = store.put(makeRecord({
      prompt: 'must not persist',
      attachments: [{ url: 'attachment-secret' }],
      files: [{ url: 'file-secret' }],
      toolOutput: 'tool-output-secret',
      token: 'token-secret',
      auth: 'auth-secret',
      env: { ANTHROPIC_API_KEY: 'environment-secret' },
      target: {
        harnessId: 'claude-code',
        modelRef: 'sonnet',
        permissionMode: 'acceptEdits',
        effort: 'high',
        authorization: 'Bearer target-secret',
      },
    }));

    expect(stored).toMatchObject({ sessionId: 'ses_1', state: 'waiting' });
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, 'utf8');
    const payload = JSON.parse(raw);
    expect(Object.keys(payload).sort()).toEqual(['retries', 'version']);
    expect(payload.version).toBe(1);
    expect(payload.retries).toHaveLength(1);
    expect(Object.keys(payload.retries[0]).sort()).toEqual(Object.keys(stored).sort());
    expect(payload.retries[0].target).toEqual({
      harnessId: 'claude-code',
      modelRef: 'sonnet',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });
    for (const sensitive of [
      'must not persist',
      'attachment-secret',
      'file-secret',
      'tool-output-secret',
      'token-secret',
      'auth-secret',
      'environment-secret',
      'Bearer target-secret',
    ]) {
      expect(raw).not.toContain(sensitive);
    }

    if (process.platform !== 'win32') {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }

    const reloaded = createPendingRetryStore({ filePath }).init();
    expect(reloaded.records).toEqual([stored]);
  });

  it('gets a defensive record copy and returns null for an unknown session', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    store.init();
    const stored = store.put(makeRecord());

    const result = store.get('ses_1');
    expect(result).toEqual(stored);
    result.sessionId = 'mutated';
    result.target.modelRef = 'mutated';
    expect(store.get('ses_1')).toEqual(stored);
    expect(store.get('ses_missing')).toBeNull();
  });

  for (const state of ['observed', 'waiting', 'launching', 'blocked']) {
    it(`accepts the ${state} recovery state`, () => {
      const { filePath } = makeStorePath();
      const store = createPendingRetryStore({ filePath });
      store.init();
      expect(store.put(makeRecord({ sessionId: `ses_${state}`, state })).state).toBe(state);
      expect(createPendingRetryStore({ filePath }).init().records[0].state).toBe(state);
    });
  }

  it('rejects an invalid state without replacing authoritative data', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    store.init();
    const prior = store.put(makeRecord());
    const diskBefore = fs.readFileSync(filePath, 'utf8');

    const error = captureError(() => store.put(makeRecord({ state: 'idle' })));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.list()).toEqual([prior]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
  });

  it('collapses duplicate session IDs on load by generation, then updatedAt', () => {
    const { directory, filePath } = makeStorePath();
    writeFixture(filePath, JSON.stringify({
      version: 1,
      retries: [
        makeRecord({ generation: 4, updatedAt: 400, blockedReason: 'older-generation-winner' }),
        makeRecord({ generation: 3, updatedAt: 900, blockedReason: 'lower-generation' }),
        makeRecord({ generation: 4, updatedAt: 500, blockedReason: 'newest-generation-winner' }),
      ],
    }));

    const store = createPendingRetryStore({ filePath });
    expect(store.init().records).toEqual([
      expect.objectContaining({
        sessionId: 'ses_1',
        generation: 4,
        updatedAt: 500,
        blockedReason: 'newest-generation-winner',
      }),
    ]);
  });

  it('collapses duplicate session IDs during replace using the same ordering', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    store.init();

    const records = store.replace([
      makeRecord({ generation: 8, updatedAt: 100, blockedReason: 'first' }),
      makeRecord({ generation: 8, updatedAt: 200, blockedReason: 'second' }),
      makeRecord({ generation: 7, updatedAt: 999, blockedReason: 'third' }),
    ]);

    expect(records).toEqual([
      expect.objectContaining({ generation: 8, updatedAt: 200, blockedReason: 'second' }),
    ]);
    expect(readPayload(filePath).retries).toEqual(records);
  });

  it('treats lower or tied put generations as no-ops returning the existing record', () => {
    const { filePath } = makeStorePath();
    let renameShouldFail = false;
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({ failRename: () => renameShouldFail }),
    });
    store.init();
    const existing = store.put(makeRecord({
      generation: 5,
      updatedAt: 500,
      blockedReason: 'authoritative',
    }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');
    renameShouldFail = true;

    for (const stale of [
      makeRecord({ generation: 4, updatedAt: 999, blockedReason: 'lower-generation' }),
      makeRecord({ generation: 5, updatedAt: 499, blockedReason: 'older-update' }),
      makeRecord({ generation: 5, updatedAt: 500, blockedReason: 'exact-rank-tie' }),
    ]) {
      expect(store.put(stale)).toEqual(existing);
      expect(store.get('ses_1')).toEqual(existing);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
    }
  });

  it('allows a newer updatedAt in the same generation and any higher generation', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    store.init();
    store.put(makeRecord({ generation: 5, updatedAt: 500 }));

    const sameGeneration = store.put(makeRecord({
      generation: 5,
      updatedAt: 501,
      blockedReason: 'newer-timestamp',
    }));
    expect(store.get('ses_1')).toEqual(sameGeneration);

    const higherGeneration = store.put(makeRecord({
      generation: 6,
      updatedAt: 1,
      blockedReason: 'newer-generation',
    }));
    expect(store.get('ses_1')).toEqual(higherGeneration);
  });

  it('persists put, delete, and replace before each synchronous mutation returns', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    store.init();

    store.put(makeRecord({ sessionId: 'ses_a' }));
    expect(readPayload(filePath).retries.map((record) => record.sessionId)).toEqual(['ses_a']);

    store.put(makeRecord({ sessionId: 'ses_b' }));
    expect(readPayload(filePath).retries.map((record) => record.sessionId)).toEqual(['ses_a', 'ses_b']);

    expect(store.delete('ses_a')).toBe(true);
    expect(readPayload(filePath).retries.map((record) => record.sessionId)).toEqual(['ses_b']);

    const replacement = makeRecord({ sessionId: 'ses_c', generation: 3 });
    expect(store.replace([replacement])).toEqual([sanitizePendingRetryRecord(replacement)]);
    expect(readPayload(filePath).retries).toEqual([sanitizePendingRetryRecord(replacement)]);
  });

  it('cleans temporary files when an atomic rename fails', () => {
    const { directory, filePath } = makeStorePath();
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({ failRename: () => true }),
    });
    store.init();

    const error = captureError(() => store.put(makeRecord()));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves prior memory and disk for every failed critical mutation', () => {
    const { directory, filePath } = makeStorePath();
    let renameShouldFail = false;
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({ failRename: () => renameShouldFail }),
    });
    store.init();
    const prior = store.put(makeRecord({ blockedReason: 'keep-me' }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');
    renameShouldFail = true;

    for (const mutate of [
      () => store.put(makeRecord({ generation: 2, blockedReason: 'put-replacement' })),
      () => store.delete('ses_1'),
      () => store.replace([makeRecord({ sessionId: 'ses_new' })]),
    ]) {
      const error = captureError(mutate);
      expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
      expect(store.list()).toEqual([prior]);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    }
  });

  it('treats chmod as best-effort when the platform does not support it', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({ failChmod: () => true }),
    });
    store.init();
    expect(store.put(makeRecord()).sessionId).toBe('ses_1');
    expect(createPendingRetryStore({ filePath }).init().records).toHaveLength(1);
  });

  it('aborts on a genuine chmod failure and preserves prior memory and disk', () => {
    const { directory, filePath } = makeStorePath();
    let failTemporaryChmod = false;
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({
        chmodErrorCode: (targetPath) => (
          failTemporaryChmod && String(targetPath).endsWith('.tmp') ? 'EACCES' : null
        ),
      }),
    });
    store.init();
    const existing = store.put(makeRecord({ generation: 1, blockedReason: 'keep-me' }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');
    failTemporaryChmod = true;

    const error = captureError(() => store.put(makeRecord({
      generation: 2,
      blockedReason: 'must-not-publish',
    })));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.get('ses_1')).toEqual(existing);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('treats ENOENT as a valid missing journal', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    expect(store.init()).toEqual({ records: [] });
    expect(store.list()).toEqual([]);
  });

  it('fails closed when a descriptor read returns ENOENT after open', () => {
    const { filePath } = makeStorePath();
    writeFixture(filePath, JSON.stringify({ version: 1, retries: [] }));
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({
        readErrorCode: (targetPath) => (targetPath === filePath ? 'ENOENT' : null),
      }),
    });

    const error = captureError(() => store.init());
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
  });

  it('fails closed when fstat fails after the journal is opened', () => {
    const { filePath } = makeStorePath();
    writeFixture(filePath, JSON.stringify({ version: 1, retries: [] }));
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({
        fstatErrorCode: (targetPath) => (targetPath === filePath ? 'EIO' : null),
      }),
    });

    const error = captureError(() => store.init());
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
  });

  it('fails closed on malformed UTF-8 bytes instead of accepting replacement text', () => {
    const { filePath } = makeStorePath();
    const payload = JSON.stringify({
      version: 1,
      retries: [makeRecord({ sessionId: 'ses_X' })],
    });
    const bytes = Buffer.from(payload);
    const marker = bytes.indexOf(Buffer.from('ses_X')) + 'ses_'.length;
    bytes[marker] = 0xff;
    writeFixture(filePath, bytes);

    const error = captureError(() => createPendingRetryStore({ filePath }).init());
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
  });

  it('fails closed for malformed, unsupported, invalid, or oversized journals', () => {
    const cases = [
      { name: 'malformed', content: '{' },
      { name: 'unsupported version', content: JSON.stringify({ version: 2, retries: [] }) },
      { name: 'invalid top level', content: JSON.stringify({ version: 1, retries: {} }) },
      { name: 'invalid record', content: JSON.stringify({ version: 1, retries: [null] }) },
      { name: 'oversized', content: ' '.repeat(MAX_PENDING_RETRY_STORE_BYTES + 1) },
    ];

    for (const testCase of cases) {
      const { filePath } = makeStorePath();
      writeFixture(filePath, testCase.content);
      const store = createPendingRetryStore({ filePath });
      const error = captureError(() => store.init());
      expect(error.code, testCase.name).toBe(RETRY_STORE_UNAVAILABLE);
    }
  });

  it('fails closed when the persisted envelope contains an unknown key', () => {
    const { filePath } = makeStorePath();
    writeFixture(filePath, JSON.stringify({
      version: 1,
      retries: [],
      token: 'must-not-be-authoritative',
    }));

    const error = captureError(() => createPendingRetryStore({ filePath }).init());
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
  });

  it('fails closed when a persisted record contains forbidden or unknown fields', () => {
    const cases = [
      { name: 'prompt', record: { ...makeRecord(), prompt: 'private prompt' } },
      { name: 'files', record: { ...makeRecord(), files: [{ url: 'private file' }] } },
      { name: 'unknown', record: { ...makeRecord(), arbitrary: true } },
      {
        name: 'target unknown',
        record: {
          ...makeRecord(),
          target: { ...makeRecord().target, authorization: 'Bearer private' },
        },
      },
    ];

    for (const testCase of cases) {
      const { filePath } = makeStorePath();
      writeFixture(filePath, JSON.stringify({
        version: 1,
        retries: [testCase.record],
      }));
      const error = captureError(() => createPendingRetryStore({ filePath }).init());
      expect(error.code, testCase.name).toBe(RETRY_STORE_UNAVAILABLE);
    }
  });

  const noncanonicalPersistedRecords = [
    {
      name: 'an invalid permission mode',
      record: makeRecord({
        target: { ...makeRecord().target, permissionMode: 'bypassPermissions' },
      }),
    },
    { name: 'an invalid state', record: makeRecord({ state: 'idle' }) },
    { name: 'a missing required session ID', record: omitField(makeRecord(), 'sessionId') },
    { name: 'a missing required generation', record: omitField(makeRecord(), 'generation') },
    { name: 'a nonnumeric generation', record: makeRecord({ generation: '1' }) },
    { name: 'a negative attempt', record: makeRecord({ attempt: -1 }) },
    { name: 'a fractional creation timestamp', record: makeRecord({ createdAt: 1.5 }) },
    { name: 'a negative reset timestamp', record: makeRecord({ resetAt: -1 }) },
    {
      name: 'a non-Claude target harness',
      record: makeRecord({ target: { ...makeRecord().target, harnessId: 'opencode' } }),
    },
    {
      name: 'a nonstring target model',
      record: makeRecord({ target: { ...makeRecord().target, modelRef: { id: 'sonnet' } } }),
    },
    {
      name: 'an invalid effort level',
      record: makeRecord({ target: { ...makeRecord().target, effort: 'unlimited' } }),
    },
    { name: 'an invalid agents mode', record: makeRecord({ agentsMode: 'all' }) },
    { name: 'an overlong agent name', record: makeRecord({ agentName: 'a'.repeat(201) }) },
    { name: 'a nonstring launch UUID', record: makeRecord({ launchUuid: { uuid: 'launch' } }) },
  ];

  for (const testCase of noncanonicalPersistedRecords) {
    it(`fails closed when a persisted record contains ${testCase.name}`, () => {
      const { filePath } = makeStorePath();
      writeFixture(filePath, JSON.stringify({
        version: 1,
        retries: [testCase.record],
      }));

      const error = captureError(() => createPendingRetryStore({ filePath }).init());
      expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    });
  }

  it('rejects a load whose record array exceeds the configured bound', () => {
    const { filePath } = makeStorePath();
    writeFixture(filePath, JSON.stringify({
      version: 1,
      retries: [
        makeRecord({ sessionId: 'ses_1' }),
        makeRecord({ sessionId: 'ses_2' }),
        makeRecord({ sessionId: 'ses_3' }),
      ],
    }));

    const store = createPendingRetryStore({ filePath, maxRecords: 2 });
    const error = captureError(() => store.init());
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
  });

  it('rejects a new record at capacity without evicting an obligation', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath, maxRecords: 2 });
    store.init();
    store.put(makeRecord({ sessionId: 'ses_1' }));
    store.put(makeRecord({ sessionId: 'ses_2' }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');

    const error = captureError(() => store.put(makeRecord({ sessionId: 'ses_3' })));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.list().map((record) => record.sessionId)).toEqual(['ses_1', 'ses_2']);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
  });

  it('rolls back a write-side byte overflow without replacing memory or disk', () => {
    const { directory, filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath, maxBytes: 700 });
    store.init();
    const existing = store.put(makeMinimalRecord());
    const diskBefore = fs.readFileSync(filePath, 'utf8');

    const error = captureError(() => store.put(makeMinimalRecord({
      generation: 2,
      updatedAt: 2,
      directory: `/${'x'.repeat(1000)}`,
    })));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.get('ses_minimal')).toEqual(existing);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('merges unrelated puts from independently initialized stores', () => {
    const { filePath } = makeStorePath();
    const first = createPendingRetryStore({ filePath });
    const second = createPendingRetryStore({ filePath });
    first.init();
    second.init();

    first.put(makeRecord({ sessionId: 'ses_first' }));
    second.put(makeRecord({ sessionId: 'ses_second' }));

    expect(createPendingRetryStore({ filePath }).init().records.map((record) => record.sessionId))
      .toEqual(['ses_first', 'ses_second']);
  });

  it('does not resurrect a deleted record when a stale store puts an unrelated record', () => {
    const { filePath } = makeStorePath();
    const deletingStore = createPendingRetryStore({ filePath });
    deletingStore.init();
    deletingStore.put(makeRecord({ sessionId: 'ses_deleted' }));

    const staleStore = createPendingRetryStore({ filePath });
    staleStore.init();
    deletingStore.delete('ses_deleted');
    staleStore.put(makeRecord({ sessionId: 'ses_unrelated' }));

    expect(createPendingRetryStore({ filePath }).init().records.map((record) => record.sessionId))
      .toEqual(['ses_unrelated']);
  });

  it('preserves a concurrent unrelated addition during stale replace', () => {
    const { filePath } = makeStorePath();
    const replacingStore = createPendingRetryStore({ filePath });
    const otherStore = createPendingRetryStore({ filePath });
    replacingStore.init();
    otherStore.init();
    otherStore.put(makeRecord({ sessionId: 'ses_other' }));

    replacingStore.replace([makeRecord({ sessionId: 'ses_replacement' })]);

    expect(createPendingRetryStore({ filePath }).init().records.map((record) => record.sessionId))
      .toEqual(['ses_other', 'ses_replacement']);
  });

  it('does not delete a concurrently advanced record during stale replace', () => {
    const { filePath } = makeStorePath();
    const currentStore = createPendingRetryStore({ filePath });
    currentStore.init();
    currentStore.put(makeRecord({ sessionId: 'ses_1', generation: 1, updatedAt: 1 }));
    const staleStore = createPendingRetryStore({ filePath });
    staleStore.init();
    const current = currentStore.put(makeRecord({ sessionId: 'ses_1', generation: 2, updatedAt: 2 }));

    staleStore.replace([]);

    expect(staleStore.get('ses_1')).toEqual(current);
    expect(createPendingRetryStore({ filePath }).init().records).toEqual([current]);
  });

  it('treats a put with a stale expected generation as a no-op conflict', () => {
    const { filePath } = makeStorePath();
    const currentStore = createPendingRetryStore({ filePath });
    currentStore.init();
    currentStore.put(makeRecord({ generation: 1, updatedAt: 1 }));
    const staleStore = createPendingRetryStore({ filePath });
    staleStore.init();
    const current = currentStore.put(makeRecord({ generation: 2, updatedAt: 2 }));

    expect(staleStore.put(
      makeRecord({ generation: 3, updatedAt: 3 }),
      { expectedGeneration: 1 },
    )).toEqual(current);
    expect(staleStore.get('ses_1')).toEqual(current);
    expect(createPendingRetryStore({ filePath }).init().records).toEqual([current]);
  });

  it('treats a delete with a stale expected generation as a no-op conflict', () => {
    const { filePath } = makeStorePath();
    const currentStore = createPendingRetryStore({ filePath });
    currentStore.init();
    currentStore.put(makeRecord({ generation: 1, updatedAt: 1 }));
    const staleStore = createPendingRetryStore({ filePath });
    staleStore.init();
    const current = currentStore.put(makeRecord({ generation: 2, updatedAt: 2 }));

    expect(staleStore.delete('ses_1', { expectedGeneration: 1 })).toBe(false);
    expect(staleStore.get('ses_1')).toEqual(current);
    expect(createPendingRetryStore({ filePath }).init().records).toEqual([current]);
  });

  it('times out on a live interprocess lock without deleting its owner', () => {
    const { filePath } = makeStorePath();
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFixture(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'live-owner',
      createdAt: Date.now(),
    }));
    const store = createPendingRetryStore({
      filePath,
      lockTimeoutMs: 5,
      lockPollMs: 1,
      staleLockMs: 60_000,
    });
    store.init();

    const error = captureError(() => store.put(makeRecord()));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('reclaims an old lock only when its owner is confirmed dead', () => {
    const { filePath } = makeStorePath();
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFixture(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 999_999_999,
      token: 'dead-owner',
      createdAt: 1,
    }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    const store = createPendingRetryStore({
      filePath,
      lockTimeoutMs: 50,
      lockPollMs: 1,
      staleLockMs: 10,
      isProcessAlive: () => false,
    });
    store.init();

    expect(store.put(makeRecord()).sessionId).toBe('ses_1');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim a lock whose directory identity changes during stale verification', () => {
    const { filePath } = makeStorePath();
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFixture(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 999_999_999,
      token: 'dead-owner',
      createdAt: 1,
    }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    let lockStatCount = 0;
    const store = createPendingRetryStore({
      filePath,
      lockTimeoutMs: 0,
      staleLockMs: 10,
      isProcessAlive: () => false,
      fs: withFsFailures({
        transformLstat: (stats, targetPath) => {
          if (targetPath !== lockPath || ++lockStatCount === 1) return stats;
          return new Proxy(stats, {
            get(target, property, receiver) {
              if (property === 'ino') return Number(target.ino) + 1;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      }),
    });
    store.init();

    const error = captureError(() => store.put(makeRecord()));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('writes and syncs the temp descriptor before rename, then syncs the parent directory', () => {
    const { directory, filePath } = makeStorePath();
    const operations = [];
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({ operations }),
    });
    store.init();
    operations.length = 0;

    store.put(makeMinimalRecord());

    const tempOpen = operations.findIndex((entry) => (
      entry.startsWith(`open:${filePath}.`) && entry.endsWith('.tmp')
    ));
    const tempPath = tempOpen >= 0 ? operations[tempOpen].slice('open:'.length) : '';
    const tempWrite = operations.indexOf(`write:${tempPath}`);
    const tempFsync = operations.indexOf(`fsync:${tempPath}`);
    const tempClose = operations.indexOf(`close:${tempPath}`);
    const rename = operations.findIndex((entry) => entry === `rename:${tempPath}->${filePath}`);
    const directoryFsync = operations.indexOf(`fsync:${directory}`);
    expect(tempOpen).toBeGreaterThanOrEqual(0);
    expect(tempWrite).toBeGreaterThan(tempOpen);
    expect(tempFsync).toBeGreaterThan(tempWrite);
    expect(tempClose).toBeGreaterThan(tempFsync);
    expect(rename).toBeGreaterThan(tempClose);
    if (process.platform !== 'win32') expect(directoryFsync).toBeGreaterThan(rename);
  });

  it('rolls back memory and disk when the temp-file fsync fails', () => {
    const { directory, filePath } = makeStorePath();
    let failTempFsync = false;
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({
        fsyncErrorCode: (targetPath) => (
          failTempFsync && String(targetPath).endsWith('.tmp') ? 'EIO' : null
        ),
      }),
    });
    store.init();
    const current = store.put(makeRecord({ generation: 1, updatedAt: 1 }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');
    failTempFsync = true;

    const error = captureError(() => store.put(makeRecord({ generation: 2, updatedAt: 2 })));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.get('ses_1')).toEqual(current);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  it('keeps memory unpublished and releases the lock when parent-directory fsync fails', () => {
    const { directory, filePath } = makeStorePath();
    let failDirectoryFsync = false;
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({
        fsyncErrorCode: (targetPath) => (
          failDirectoryFsync && targetPath === directory ? 'EIO' : null
        ),
      }),
    });
    store.init();
    const current = store.put(makeRecord({ generation: 1, updatedAt: 1 }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');
    failDirectoryFsync = true;

    const error = captureError(() => store.put(makeRecord({ generation: 2, updatedAt: 2 })));
    expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    expect(store.get('ses_1')).toEqual(current);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  it('ignores only an explicit unsupported parent-directory fsync error', () => {
    const { directory, filePath } = makeStorePath();
    const store = createPendingRetryStore({
      filePath,
      fs: withFsFailures({
        fsyncErrorCode: (targetPath) => (targetPath === directory ? 'EINVAL' : null),
      }),
    });
    store.init();
    expect(store.put(makeRecord()).sessionId).toBe('ses_1');
  });

  it('reads the journal through one descriptor instead of path stat/read helpers', () => {
    const { filePath } = makeStorePath();
    writeFixture(filePath, JSON.stringify({ version: 1, retries: [makeRecord()] }));
    const descriptorOnlyFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'statSync' || property === 'readFileSync') {
          return () => { throw makeFsError('EIO', 'path helper must not be used'); };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    expect(createPendingRetryStore({ filePath, fs: descriptorOnlyFs }).init().records)
      .toEqual([makeRecord()]);
  });

  if (process.platform !== 'win32') {
    it('rejects an existing journal with non-private mode', () => {
      const { filePath } = makeStorePath();
      writeFixture(filePath, JSON.stringify({ version: 1, retries: [makeRecord()] }), { mode: 0o644 });
      const error = captureError(() => createPendingRetryStore({ filePath }).init());
      expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    });

    it('rejects an existing journal owned by another uid', () => {
      const { filePath } = makeStorePath();
      writeFixture(filePath, JSON.stringify({ version: 1, retries: [makeRecord()] }));
      const store = createPendingRetryStore({
        filePath,
        fs: withFsFailures({
          transformFstat: (stats, targetPath) => (
            targetPath === filePath
              ? new Proxy(stats, {
                get(target, property, receiver) {
                  if (property === 'uid') return target.uid + 1;
                  return Reflect.get(target, property, receiver);
                },
              })
              : stats
          ),
        }),
      });
      const error = captureError(() => store.init());
      expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    });

    it('does not follow a symlink journal when O_NOFOLLOW is available', () => {
      const { filePath } = makeStorePath();
      const targetPath = `${filePath}.target`;
      writeFixture(targetPath, JSON.stringify({ version: 1, retries: [makeRecord()] }));
      fs.symlinkSync(targetPath, filePath);

      const error = captureError(() => createPendingRetryStore({ filePath }).init());
      expect(error.code).toBe(RETRY_STORE_UNAVAILABLE);
    });
  }
});
