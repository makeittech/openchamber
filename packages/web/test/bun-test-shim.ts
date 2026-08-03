import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from 'vitest';

const mock = Object.assign(
  <T extends (...args: never[]) => unknown>(implementation?: T) => vi.fn(implementation),
  {
    module: vi.mock,
    // bun's `mock.restore()` restores every mock; vitest spells it differently.
    restore: () => vi.restoreAllMocks(),
  },
);

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  test,
  vi,
};
