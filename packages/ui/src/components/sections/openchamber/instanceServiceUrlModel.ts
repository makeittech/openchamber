import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { isLoopbackHttpUrl } from '@/lib/url';

export type InstanceServiceInfo = {
  port: number | null;
  tunnelUrl: string | null;
};

type InstanceService = {
  key: string;
  label: string;
  url: string;
};

export const parseInstanceServiceInfo = (data: unknown): InstanceServiceInfo => {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : null;
  const port = typeof record?.port === 'number' && Number.isFinite(record.port) && record.port > 0
    ? record.port
    : null;
  const tunnelUrl = typeof record?.tunnelUrl === 'string' && record.tunnelUrl.trim().length > 0
    ? record.tunnelUrl.trim()
    : null;
  return { port, tunnelUrl };
};

/**
 * Local Application URL for the active instance.
 *
 * - Loopback browser origins use `window.location.origin` so HMR/dev UI ports
 *   stay correct (instead of the Express API port alone).
 * - Packaged Electron local pages use `http://localhost:<port>/` because the
 *   renderer origin is `openchamber-ui://`.
 * - Capacitor, relay, and remote origins return null so we never offer a dead
 *   localhost link that points at the viewer's device.
 */
export const resolveLocalApplicationUrl = (port: number | null): string | null => {
  if (typeof window === 'undefined') return null;
  if (isCapacitorApp()) return null;
  if (isRelayModeActive()) return null;

  const origin = window.location.origin;
  if (isLoopbackHttpUrl(origin)) {
    return `${origin.replace(/\/$/, '')}/`;
  }

  if (isDesktopLocalOriginActive() && typeof port === 'number' && port > 0) {
    return `http://localhost:${port}/`;
  }

  return null;
};

export const buildInstanceServices = (
  info: InstanceServiceInfo | null | undefined,
  labels: { application: string; tunnel: string },
): InstanceService[] => {
  if (!info) return [];

  const services: InstanceService[] = [];
  const applicationUrl = resolveLocalApplicationUrl(info.port);
  if (applicationUrl) {
    services.push({
      key: 'application',
      label: labels.application,
      url: applicationUrl,
    });
  }
  if (info.tunnelUrl) {
    services.push({
      key: 'tunnel',
      label: labels.tunnel,
      url: info.tunnelUrl,
    });
  }
  return services;
};
