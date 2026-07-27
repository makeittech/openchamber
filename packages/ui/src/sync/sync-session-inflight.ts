/**
 * Module-level coalescing for session renderable sync.
 * Shared across useSync() instances so chat/sidebar/model controls share one load.
 * Must be cleared when SyncProvider remounts so React Strict Mode cannot leave
 * the remounted tree joined to a disposed loader's empty completion.
 */
export const syncSessionInflightByKey = new Map<string, Promise<void>>()

/** Per-session generation so older in-flight syncSession writes are rejected. */
export const syncSessionGenerationByKey = new Map<string, number>()

export function resetSyncSessionInflight(): void {
  syncSessionInflightByKey.clear()
  syncSessionGenerationByKey.clear()
}
