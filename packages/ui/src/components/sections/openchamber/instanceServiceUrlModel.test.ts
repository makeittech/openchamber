import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const flags = {
  isDesktopLocalOriginActive: false,
  isCapacitorApp: false,
  isRelayModeActive: false,
};

mock.module('@/lib/desktop', () => ({
  isDesktopLocalOriginActive: () => flags.isDesktopLocalOriginActive,
}));
mock.module('@/lib/platform', () => ({
  isCapacitorApp: () => flags.isCapacitorApp,
}));
mock.module('@/lib/relay/runtime-tunnel', () => ({
  isRelayModeActive: () => flags.isRelayModeActive,
}));

import {
  buildInstanceServices,
  parseInstanceServiceInfo,
  resolveLocalApplicationUrl,
} from './instanceServiceUrlModel';

const originalWindow = globalThis.window;

beforeEach(() => {
  globalThis.window = {
    location: { origin: 'http://localhost:3000' },
  } as Window & typeof globalThis;
  flags.isDesktopLocalOriginActive = false;
  flags.isCapacitorApp = false;
  flags.isRelayModeActive = false;
});

afterEach(() => {
  globalThis.window = originalWindow;
});

const setOrigin = (origin: string) => {
  globalThis.window = {
    location: { origin },
  } as Window & typeof globalThis;
};

describe('parseInstanceServiceInfo', () => {
  test('keeps finite positive ports and non-empty tunnel URLs', () => {
    expect(parseInstanceServiceInfo({
      port: 4090,
      tunnelUrl: ' https://worktree.example.trycloudflare.com ',
    })).toEqual({
      port: 4090,
      tunnelUrl: 'https://worktree.example.trycloudflare.com',
    });
  });

  test('rejects invalid port and tunnel values', () => {
    expect(parseInstanceServiceInfo({ port: 0, tunnelUrl: '   ' })).toEqual({
      port: null,
      tunnelUrl: null,
    });
    expect(parseInstanceServiceInfo(null)).toEqual({
      port: null,
      tunnelUrl: null,
    });
  });
});

describe('resolveLocalApplicationUrl', () => {
  test('uses the browser origin on loopback so HMR UI ports stay correct', () => {
    setOrigin('http://localhost:5173');
    expect(resolveLocalApplicationUrl(3000)).toBe('http://localhost:5173/');
  });

  test('uses localhost port for packaged Electron local pages', () => {
    setOrigin('openchamber-ui://app');
    flags.isDesktopLocalOriginActive = true;
    expect(resolveLocalApplicationUrl(4090)).toBe('http://localhost:4090/');
  });

  test('hides the Application URL for remote browser origins', () => {
    setOrigin('https://worktree.example.trycloudflare.com');
    expect(resolveLocalApplicationUrl(4090)).toBeNull();
  });

  test('hides the Application URL on Capacitor and relay clients', () => {
    setOrigin('http://localhost:3000');
    flags.isCapacitorApp = true;
    expect(resolveLocalApplicationUrl(3000)).toBeNull();

    flags.isCapacitorApp = false;
    flags.isRelayModeActive = true;
    expect(resolveLocalApplicationUrl(3000)).toBeNull();
  });
});

describe('buildInstanceServices', () => {
  test('omits Application and keeps Tunnel for remote viewers', () => {
    setOrigin('https://phone.example.com');
    const services = buildInstanceServices(
      { port: 4090, tunnelUrl: 'https://worktree.example.trycloudflare.com' },
      { application: 'Application', tunnel: 'Tunnel' },
    );
    expect(services).toEqual([
      {
        key: 'tunnel',
        label: 'Tunnel',
        url: 'https://worktree.example.trycloudflare.com',
      },
    ]);
  });

  test('returns both services for a local loopback viewer', () => {
    setOrigin('http://127.0.0.1:3000');
    const services = buildInstanceServices(
      { port: 3000, tunnelUrl: 'https://worktree.example.trycloudflare.com' },
      { application: 'Application', tunnel: 'Tunnel' },
    );
    expect(services.map((service) => service.key)).toEqual(['application', 'tunnel']);
    expect(services[0]?.url).toBe('http://127.0.0.1:3000/');
  });
});
