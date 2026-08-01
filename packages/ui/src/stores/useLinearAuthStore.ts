import { create } from 'zustand';
import type { LinearAuthStatus, RuntimeAPIs } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';

type LinearAuthStatusWithError = LinearAuthStatus & { error?: string };

type LinearAuthStore = {
  status: LinearAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
  setStatus: (status: LinearAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeLinear?: RuntimeAPIs['linear'],
    options?: { force?: boolean }
  ) => Promise<LinearAuthStatusWithError | null>;
};

const fetchStatus = async (
  runtimeLinear?: RuntimeAPIs['linear']
): Promise<LinearAuthStatusWithError> => {
  if (runtimeLinear) {
    return runtimeLinear.authStatus();
  }

  const response = await runtimeFetch('/api/linear/auth/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = (await response.json().catch(() => null)) as LinearAuthStatusWithError | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || response.statusText || 'Failed to load Linear status');
  }
  return payload;
};

// In-flight dedup for refreshStatus
let _inFlightAuthRefresh: Promise<LinearAuthStatusWithError | null> | null = null;

export const useLinearAuthStore = create<LinearAuthStore>((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  setStatus: (status) => set({ status, hasChecked: true }),
  refreshStatus: async (runtimeLinear, options) => {
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) {
      return status;
    }

    if (_inFlightAuthRefresh) return _inFlightAuthRefresh;

    set({ isLoading: true });
    _inFlightAuthRefresh = (async () => {
      try {
        const payload = await fetchStatus(runtimeLinear);
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          status: { configured: false, connected: false, error: message },
          isLoading: false,
          hasChecked: true,
        });
        return null;
      }
    })().finally(() => { _inFlightAuthRefresh = null; });

    return _inFlightAuthRefresh;
  },
}));
