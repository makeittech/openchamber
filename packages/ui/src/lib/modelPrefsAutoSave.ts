import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { ExecutionTarget } from '@/types/harness';

type ModelRef = { providerID: string; modelID: string };
type ModelPrefsPayload = {
  favoriteModels: ModelRef[];
  favoriteTargets: ExecutionTarget[];
  hiddenModels: ModelRef[];
  collapsedModelProviders: string[];
  recentModels: ModelRef[];
  recentTargets: ExecutionTarget[];
  recentAgents: string[];
  recentEfforts: Record<string, string[]>;
};

const refsEqual = (a: ModelRef[], b: ModelRef[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.providerID !== b[i]?.providerID) return false;
    if (a[i]?.modelID !== b[i]?.modelID) return false;
  }
  return true;
};

const targetsEqual = (a: ExecutionTarget[], b: ExecutionTarget[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
};

const stringsEqual = (a: string[], b: string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const recentEffortsEqual = (a: Record<string, string[]>, b: Record<string, string[]>): boolean => {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Array.isArray(b[key]) && stringsEqual(a[key], b[key]));
};

const snapshotModelPrefs = (): ModelPrefsPayload => {
  const state = useUIStore.getState();
  return {
    favoriteModels: state.favoriteModels,
    favoriteTargets: state.favoriteTargets,
    hiddenModels: state.hiddenModels,
    collapsedModelProviders: state.collapsedModelProviders,
    recentModels: state.recentModels,
    recentTargets: state.recentTargets,
    recentAgents: state.recentAgents,
    recentEfforts: state.recentEfforts,
  };
};

const modelPrefsEqual = (a: ModelPrefsPayload, b: ModelPrefsPayload): boolean => (
  refsEqual(a.favoriteModels, b.favoriteModels) &&
  targetsEqual(a.favoriteTargets, b.favoriteTargets) &&
  refsEqual(a.hiddenModels, b.hiddenModels) &&
  stringsEqual(a.collapsedModelProviders, b.collapsedModelProviders) &&
  refsEqual(a.recentModels, b.recentModels) &&
  targetsEqual(a.recentTargets, b.recentTargets) &&
  stringsEqual(a.recentAgents, b.recentAgents) &&
  recentEffortsEqual(a.recentEfforts, b.recentEfforts)
);

const cloneModelPrefs = (prefs: ModelPrefsPayload): ModelPrefsPayload => ({
  favoriteModels: prefs.favoriteModels.slice(),
  favoriteTargets: prefs.favoriteTargets.slice(),
  hiddenModels: prefs.hiddenModels.slice(),
  collapsedModelProviders: prefs.collapsedModelProviders.slice(),
  recentModels: prefs.recentModels.slice(),
  recentTargets: prefs.recentTargets.slice(),
  recentAgents: prefs.recentAgents.slice(),
  recentEfforts: Object.fromEntries(Object.entries(prefs.recentEfforts).map(([key, variants]) => [key, variants.slice()])),
});

export const startModelPrefsAutoSave = () => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let timer: number | null = null;
  let lastSent: ModelPrefsPayload | null = null;
  let didSkipInitial = false;
  let scheduledRuntimeKey: string | null = null;

  const flush = () => {
    timer = null;
    const runtimeKey = scheduledRuntimeKey;
    scheduledRuntimeKey = null;
    if (!runtimeKey || runtimeKey !== getRuntimeKey()) return;
    const payload = snapshotModelPrefs();

    if (lastSent && modelPrefsEqual(lastSent, payload)) {
      return;
    }

    lastSent = cloneModelPrefs(payload);

    void updateDesktopSettings(payload).catch(() => {});
  };

  const schedule = () => {
    if (!didSkipInitial) {
      didSkipInitial = true;
      return;
    }
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    scheduledRuntimeKey = getRuntimeKey();
    timer = window.setTimeout(flush, 1200);
  };

  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(() => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    scheduledRuntimeKey = null;
    lastSent = null;
  });

  const unsubscribe = useUIStore.subscribe((state, prevState) => {
    const next = {
      favoriteModels: state.favoriteModels,
      favoriteTargets: state.favoriteTargets,
      hiddenModels: state.hiddenModels,
      collapsedModelProviders: state.collapsedModelProviders,
      recentModels: state.recentModels,
      recentTargets: state.recentTargets,
      recentAgents: state.recentAgents,
      recentEfforts: state.recentEfforts,
    };
    const prev = {
      favoriteModels: prevState.favoriteModels,
      favoriteTargets: prevState.favoriteTargets,
      hiddenModels: prevState.hiddenModels,
      collapsedModelProviders: prevState.collapsedModelProviders,
      recentModels: prevState.recentModels,
      recentTargets: prevState.recentTargets,
      recentAgents: prevState.recentAgents,
      recentEfforts: prevState.recentEfforts,
    };
    if (modelPrefsEqual(next, prev)) {
      return;
    }
    schedule();
  });

  return () => {
    unsubscribe();
    unsubscribeRuntime();
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
};
