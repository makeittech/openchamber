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

function makeTargetRecord(targetOverrides) {
  return { ...makeRecord(), target: { ...makeRecord().target, ...targetOverrides } };
}

function omitField(record, field) {
  const copy = { ...record };
  delete copy[field];
  return copy;
}

function readPayload(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reloadRecords(filePath) {
  return createPendingRetryStore({ filePath }).init().records;
}

function initStore(filePath, options = {}) {
  const store = createPendingRetryStore({ filePath, ...options });
  store.init();
  return store;
}

function recordSessionIds(records) {
  return records.map((record) => record.sessionId);
}

function temporaryFiles(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
}

function writeJournal(filePath, retries, extra = {}) {
  writeFixture(filePath, JSON.stringify({ version: 1, retries, ...extra }));
}

function writeFixture(filePath, content, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  fs.writeFileSync(filePath, content, { mode });
  if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
}

const DEAD_LOCK_OWNER = { pid: 999_999_999, token: 'dead-owner', createdAt: 1 };

function seedLock(filePath, owner, { ageMs = 0 } = {}) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  writeFixture(path.join(lockPath, 'owner.json'), JSON.stringify({
    createdAt: Date.now(),
    ...owner,
  }));
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath, stamp, stamp);
  }
  return lockPath;
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

function expectUnavailable(callback, label) {
  expect(captureError(callback).code, label).toBe(RETRY_STORE_UNAVAILABLE);
}

function expectPersistedRecordRejected(record, label) {
  const { filePath } = makeStorePath();
  writeJournal(filePath, [record]);
  expectUnavailable(() => createPendingRetryStore({ filePath }).init(), label);
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
  const trace = (entry) => { operations?.push(entry); };
  const failIf = (code, operation) => {
    if (code) throw makeFsError(code, `injected ${operation} failure`);
  };

  const overrides = {
    openSync: (targetPath, ...args) => {
      const fd = fs.openSync(targetPath, ...args);
      pathsByFd.set(fd, String(targetPath));
      trace(`open:${String(targetPath)}`);
      return fd;
    },
    fstatSync: (fd, ...args) => {
      const filePath = pathsByFd.get(fd);
      failIf(fstatErrorCode(filePath, fd), 'fstat');
      trace(`fstat:${filePath}`);
      return transformFstat(fs.fstatSync(fd, ...args), filePath);
    },
    lstatSync: (targetPath, ...args) => transformLstat(
      fs.lstatSync(targetPath, ...args),
      String(targetPath),
    ),
    readSync: (fd, ...args) => {
      const filePath = pathsByFd.get(fd);
      failIf(readErrorCode(filePath, fd), 'read');
      trace(`read:${filePath}`);
      return fs.readSync(fd, ...args);
    },
    writeSync: (fd, ...args) => {
      trace(`write:${pathsByFd.get(fd)}`);
      return fs.writeSync(fd, ...args);
    },
    fsyncSync: (fd) => {
      const filePath = pathsByFd.get(fd);
      failIf(fsyncErrorCode(filePath, fd), 'fsync');
      trace(`fsync:${filePath}`);
      return fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      trace(`close:${pathsByFd.get(fd)}`);
      try {
        return fs.closeSync(fd);
      } finally {
        pathsByFd.delete(fd);
      }
    },
    renameSync: (from, to) => {
      failIf(failRename() ? 'EIO' : null, 'rename');
      trace(`rename:${String(from)}->${String(to)}`);
      return fs.renameSync(from, to);
    },
    chmodSync: (...args) => {
      failIf(chmodErrorCode(...args) || (failChmod() ? 'ENOTSUP' : null), 'chmod');
      return fs.chmodSync(...args);
    },
  };

  return new Proxy(fs, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
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

    expectUnavailable(() => store.replace(records));
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

    expectUnavailable(() => store.init());
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
      makeTargetRecord({ modelRef: ' sonnet' }),
      makeTargetRecord({ modelRef: 'm'.repeat(201) }),
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
    const store = initStore(filePath);
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
      const store = initStore(filePath);
      expect(store.put(makeRecord({ sessionId: `ses_${state}`, state })).state).toBe(state);
      expect(reloadRecords(filePath)[0].state).toBe(state);
    });
  }

  it('rejects an invalid state without replacing authoritative data', () => {
    const { filePath } = makeStorePath();
    const store = initStore(filePath);
    const prior = store.put(makeRecord());
    const diskBefore = fs.readFileSync(filePath, 'utf8');

    expectUnavailable(() => store.put(makeRecord({ state: 'idle' })));
    expect(store.list()).toEqual([prior]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
  });

  it('collapses duplicate session IDs on load by generation, then updatedAt', () => {
    const { directory, filePath } = makeStorePath();
    writeJournal(filePath, [
      makeRecord({ generation: 4, updatedAt: 400, blockedReason: 'older-generation-winner' }),
      makeRecord({ generation: 3, updatedAt: 900, blockedReason: 'lower-generation' }),
      makeRecord({ generation: 4, updatedAt: 500, blockedReason: 'newest-generation-winner' }),
    ]);

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
    const store = initStore(filePath);

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
    const store = initStore(filePath);
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
    const store = initStore(filePath);

    store.put(makeRecord({ sessionId: 'ses_a' }));
    expect(recordSessionIds(readPayload(filePath).retries)).toEqual(['ses_a']);

    store.put(makeRecord({ sessionId: 'ses_b' }));
    expect(recordSessionIds(readPayload(filePath).retries)).toEqual(['ses_a', 'ses_b']);

    expect(store.delete('ses_a')).toBe(true);
    expect(recordSessionIds(readPayload(filePath).retries)).toEqual(['ses_b']);

    const replacement = makeRecord({ sessionId: 'ses_c', generation: 3 });
    expect(store.replace([replacement])).toEqual([sanitizePendingRetryRecord(replacement)]);
    expect(readPayload(filePath).retries).toEqual([sanitizePendingRetryRecord(replacement)]);
  });

  it('cleans temporary files when an atomic rename fails', () => {
    const { directory, filePath } = makeStorePath();
    const store = initStore(filePath, {
      fs: withFsFailures({ failRename: () => true }),
    });

    expectUnavailable(() => store.put(makeRecord()));
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(temporaryFiles(directory)).toEqual([]);
  });

  it('preserves prior memory and disk for every failed critical mutation', () => {
    const { directory, filePath } = makeStorePath();
    let renameShouldFail = false;
    const store = initStore(filePath, {
      fs: withFsFailures({ failRename: () => renameShouldFail }),
    });
    const prior = store.put(makeRecord({ blockedReason: 'keep-me' }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');
    renameShouldFail = true;

    for (const mutate of [
      () => store.put(makeRecord({ generation: 2, blockedReason: 'put-replacement' })),
      () => store.delete('ses_1'),
      () => store.replace([makeRecord({ sessionId: 'ses_new' })]),
    ]) {
      expectUnavailable(mutate);
      expect(store.list()).toEqual([prior]);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
      expect(temporaryFiles(directory)).toEqual([]);
    }
  });

  it('treats chmod as best-effort when the platform does not support it', () => {
    const { filePath } = makeStorePath();
    const store = initStore(filePath, {
      fs: withFsFailures({ failChmod: () => true }),
    });
    expect(store.put(makeRecord()).sessionId).toBe('ses_1');
    expect(createPendingRetryStore({ filePath }).init().records).toHaveLength(1);
  });

  it('rolls back memory, disk, temp files, and the lock for each injected write failure', () => {
    // Each case arms its failure only after an authoritative record exists, so a
    // durability failure can never publish the replacement.
    const writeFailures = [
      {
        name: 'temp-file chmod',
        inject: (armed) => ({
          chmodErrorCode: (targetPath) => (
            armed() && String(targetPath).endsWith('.tmp') ? 'EACCES' : null
          ),
        }),
      },
      {
        name: 'temp-file fsync',
        inject: (armed) => ({
          fsyncErrorCode: (targetPath) => (
            armed() && String(targetPath).endsWith('.tmp') ? 'EIO' : null
          ),
        }),
      },
      {
        name: 'parent-directory fsync',
        inject: (armed, directory) => ({
          fsyncErrorCode: (targetPath) => (armed() && targetPath === directory ? 'EIO' : null),
        }),
      },
    ];

    for (const failure of writeFailures) {
      const { directory, filePath } = makeStorePath();
      let armed = false;
      const store = initStore(filePath, {
        fs: withFsFailures(failure.inject(() => armed, directory)),
      });
      const existing = store.put(makeRecord({
        generation: 1,
        updatedAt: 1,
        blockedReason: 'keep-me',
      }));
      const diskBefore = fs.readFileSync(filePath, 'utf8');
      armed = true;

      expectUnavailable(() => store.put(makeRecord({
        generation: 2,
        updatedAt: 2,
        blockedReason: 'must-not-publish',
      })), failure.name);
      expect(store.get('ses_1'), failure.name).toEqual(existing);
      expect(fs.readFileSync(filePath, 'utf8'), failure.name).toBe(diskBefore);
      expect(temporaryFiles(directory), failure.name).toEqual([]);
      expect(fs.existsSync(`${filePath}.lock`), failure.name).toBe(false);
    }
  });

  it('treats ENOENT as a valid missing journal', () => {
    const { filePath } = makeStorePath();
    const store = createPendingRetryStore({ filePath });
    expect(store.init()).toEqual({ records: [] });
    expect(store.list()).toEqual([]);
  });

  for (const [operation, code] of [['read', 'ENOENT'], ['fstat', 'EIO']]) {
    it(`fails closed when ${operation} fails after the journal is opened`, () => {
      const { filePath } = makeStorePath();
      writeJournal(filePath, []);
      const errorCode = (targetPath) => (targetPath === filePath ? code : null);
      const store = createPendingRetryStore({
        filePath,
        fs: withFsFailures(operation === 'read'
          ? { readErrorCode: errorCode }
          : { fstatErrorCode: errorCode }),
      });

      expectUnavailable(() => store.init());
    });
  }

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

    expectUnavailable(() => createPendingRetryStore({ filePath }).init());
  });

  it('fails closed for malformed, unsupported, invalid, or oversized journals', () => {
    const cases = [
      ['malformed', '{'],
      ['unsupported version', JSON.stringify({ version: 2, retries: [] })],
      ['invalid top level', JSON.stringify({ version: 1, retries: {} })],
      ['invalid record', JSON.stringify({ version: 1, retries: [null] })],
      ['oversized', ' '.repeat(MAX_PENDING_RETRY_STORE_BYTES + 1)],
    ];

    for (const [name, content] of cases) {
      const { filePath } = makeStorePath();
      writeFixture(filePath, content);
      expectUnavailable(() => createPendingRetryStore({ filePath }).init(), name);
    }
  });

  it('fails closed when the persisted envelope contains an unknown key', () => {
    const { filePath } = makeStorePath();
    writeJournal(filePath, [], { token: 'must-not-be-authoritative' });

    expectUnavailable(() => createPendingRetryStore({ filePath }).init());
  });

  it('fails closed when a persisted record contains forbidden or unknown fields', () => {
    const cases = [
      ['prompt', { ...makeRecord(), prompt: 'private prompt' }],
      ['files', { ...makeRecord(), files: [{ url: 'private file' }] }],
      ['unknown', { ...makeRecord(), arbitrary: true }],
      ['target unknown', makeTargetRecord({ authorization: 'Bearer private' })],
    ];

    for (const [name, record] of cases) expectPersistedRecordRejected(record, name);
  });

  it('fails closed on noncanonical persisted records', () => {
    const cases = [
      ['an invalid permission mode', makeTargetRecord({ permissionMode: 'bypassPermissions' })],
      ['an invalid state', makeRecord({ state: 'idle' })],
      ['a missing required session ID', omitField(makeRecord(), 'sessionId')],
      ['a missing required generation', omitField(makeRecord(), 'generation')],
      ['a nonnumeric generation', makeRecord({ generation: '1' })],
      ['a negative attempt', makeRecord({ attempt: -1 })],
      ['a fractional creation timestamp', makeRecord({ createdAt: 1.5 })],
      ['a negative reset timestamp', makeRecord({ resetAt: -1 })],
      ['a non-Claude target harness', makeTargetRecord({ harnessId: 'opencode' })],
      ['a nonstring target model', makeTargetRecord({ modelRef: { id: 'sonnet' } })],
      ['an invalid effort level', makeTargetRecord({ effort: 'unlimited' })],
      ['an invalid agents mode', makeRecord({ agentsMode: 'all' })],
      ['an overlong agent name', makeRecord({ agentName: 'a'.repeat(201) })],
      ['a nonstring launch UUID', makeRecord({ launchUuid: { uuid: 'launch' } })],
    ];

    for (const [name, record] of cases) expectPersistedRecordRejected(record, name);
  });

  it('rejects a load whose record array exceeds the configured bound', () => {
    const { filePath } = makeStorePath();
    writeJournal(filePath, [
        makeRecord({ sessionId: 'ses_1' }),
        makeRecord({ sessionId: 'ses_2' }),
        makeRecord({ sessionId: 'ses_3' }),
    ]);

    const store = createPendingRetryStore({ filePath, maxRecords: 2 });
    expectUnavailable(() => store.init());
  });

  it('rejects a new record at capacity without evicting an obligation', () => {
    const { filePath } = makeStorePath();
    const store = initStore(filePath, { maxRecords: 2 });
    store.put(makeRecord({ sessionId: 'ses_1' }));
    store.put(makeRecord({ sessionId: 'ses_2' }));
    const diskBefore = fs.readFileSync(filePath, 'utf8');

    expectUnavailable(() => store.put(makeRecord({ sessionId: 'ses_3' })));
    expect(recordSessionIds(store.list())).toEqual(['ses_1', 'ses_2']);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
  });

  it('rolls back a write-side byte overflow without replacing memory or disk', () => {
    const { directory, filePath } = makeStorePath();
    const store = initStore(filePath, { maxBytes: 700 });
    const existing = store.put(makeMinimalRecord());
    const diskBefore = fs.readFileSync(filePath, 'utf8');

    expectUnavailable(() => store.put(makeMinimalRecord({
      generation: 2,
      updatedAt: 2,
      directory: `/${'x'.repeat(1000)}`,
    })));
    expect(store.get('ses_minimal')).toEqual(existing);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(diskBefore);
    expect(temporaryFiles(directory)).toEqual([]);
  });

  it('merges unrelated puts from independently initialized stores', () => {
    const { filePath } = makeStorePath();
    const first = initStore(filePath);
    const second = initStore(filePath);

    first.put(makeRecord({ sessionId: 'ses_first' }));
    second.put(makeRecord({ sessionId: 'ses_second' }));

    expect(recordSessionIds(reloadRecords(filePath))).toEqual(['ses_first', 'ses_second']);
  });

  it('does not resurrect a deleted record when a stale store puts an unrelated record', () => {
    const { filePath } = makeStorePath();
    const deletingStore = initStore(filePath);
    deletingStore.put(makeRecord({ sessionId: 'ses_deleted' }));

    const staleStore = initStore(filePath);
    deletingStore.delete('ses_deleted');
    staleStore.put(makeRecord({ sessionId: 'ses_unrelated' }));

    expect(recordSessionIds(reloadRecords(filePath))).toEqual(['ses_unrelated']);
  });

  it('preserves a concurrent unrelated addition during stale replace', () => {
    const { filePath } = makeStorePath();
    const replacingStore = initStore(filePath);
    const otherStore = initStore(filePath);
    otherStore.put(makeRecord({ sessionId: 'ses_other' }));

    replacingStore.replace([makeRecord({ sessionId: 'ses_replacement' })]);

    expect(recordSessionIds(reloadRecords(filePath))).toEqual(['ses_other', 'ses_replacement']);
  });

  it('does not delete a concurrently advanced record during stale replace', () => {
    const { filePath } = makeStorePath();
    const currentStore = initStore(filePath);
    currentStore.put(makeRecord({ sessionId: 'ses_1', generation: 1, updatedAt: 1 }));
    const staleStore = initStore(filePath);
    const current = currentStore.put(makeRecord({ sessionId: 'ses_1', generation: 2, updatedAt: 2 }));

    staleStore.replace([]);

    expect(staleStore.get('ses_1')).toEqual(current);
    expect(reloadRecords(filePath)).toEqual([current]);
  });

  it('treats a put with a stale expected generation as a no-op conflict', () => {
    const { filePath } = makeStorePath();
    const currentStore = initStore(filePath);
    currentStore.put(makeRecord({ generation: 1, updatedAt: 1 }));
    const staleStore = initStore(filePath);
    const current = currentStore.put(makeRecord({ generation: 2, updatedAt: 2 }));

    expect(staleStore.put(
      makeRecord({ generation: 3, updatedAt: 3 }),
      { expectedGeneration: 1 },
    )).toEqual(current);
    expect(staleStore.get('ses_1')).toEqual(current);
    expect(reloadRecords(filePath)).toEqual([current]);
  });

  it('treats a delete with a stale expected generation as a no-op conflict', () => {
    const { filePath } = makeStorePath();
    const currentStore = initStore(filePath);
    currentStore.put(makeRecord({ generation: 1, updatedAt: 1 }));
    const staleStore = initStore(filePath);
    const current = currentStore.put(makeRecord({ generation: 2, updatedAt: 2 }));

    expect(staleStore.delete('ses_1', { expectedGeneration: 1 })).toBe(false);
    expect(staleStore.get('ses_1')).toEqual(current);
    expect(reloadRecords(filePath)).toEqual([current]);
  });

  it('times out on a live interprocess lock without deleting its owner', () => {
    const { filePath } = makeStorePath();
    const lockPath = seedLock(filePath, { pid: process.pid, token: 'live-owner' });
    const store = initStore(filePath, {
      lockTimeoutMs: 5,
      lockPollMs: 1,
      staleLockMs: 60_000,
    });

    expectUnavailable(() => store.put(makeRecord()));
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('reclaims an old lock only when its owner is confirmed dead', () => {
    const { filePath } = makeStorePath();
    const lockPath = seedLock(filePath, DEAD_LOCK_OWNER, { ageMs: 60_000 });
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
    const lockPath = seedLock(filePath, DEAD_LOCK_OWNER, { ageMs: 60_000 });
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

    expectUnavailable(() => store.put(makeRecord()));
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
    writeJournal(filePath, [makeRecord()]);
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
      expectUnavailable(() => createPendingRetryStore({ filePath }).init());
    });

    it('rejects an existing journal owned by another uid', () => {
      const { filePath } = makeStorePath();
      writeJournal(filePath, [makeRecord()]);
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
      expectUnavailable(() => store.init());
    });

    it('does not follow a symlink journal when O_NOFOLLOW is available', () => {
      const { filePath } = makeStorePath();
      const targetPath = `${filePath}.target`;
      writeFixture(targetPath, JSON.stringify({ version: 1, retries: [makeRecord()] }));
      fs.symlinkSync(targetPath, filePath);

      expectUnavailable(() => createPendingRetryStore({ filePath }).init());
    });
  }
});
