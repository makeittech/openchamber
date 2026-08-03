/**
 * Selection Store — per-session model, agent, variant, and execution-target selections.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { createDeferredSafeJSONStorage } from "@/stores/utils/safeStorage"
import type { ExecutionTarget } from "@/types/harness"
import { isExecutionTarget } from "@/types/harness"

type ModelSelection = { providerId: string; modelId: string }
type LastUsedProvider = { providerID: string; modelID: string }
type AgentModelSelectionEntries = [string, [string, ModelSelection][]][]
type PersistedSelectionState = {
  sessionModelSelections?: [string, ModelSelection][]
  sessionAgentSelections?: [string, string][]
  sessionAgentModelSelections?: AgentModelSelectionEntries
  sessionTargets?: [string, ExecutionTarget][]
  lastUsedProvider?: LastUsedProvider | null
  lastUsedTarget?: ExecutionTarget | null
}

export type SelectionState = {
  sessionModelSelections: Map<string, ModelSelection>
  sessionAgentSelections: Map<string, string>
  sessionAgentModelSelections: Map<string, Map<string, ModelSelection>>
  sessionTargets: Map<string, ExecutionTarget>
  /** Ephemeral: engine switch on a used session waits for Send to create a new session. */
  pendingHandoffTargets: Map<string, ExecutionTarget>
  lastUsedProvider: LastUsedProvider | null
  lastUsedTarget: ExecutionTarget | null

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined
  saveSessionTarget: (sessionId: string, target: ExecutionTarget) => void
  getSessionTarget: (sessionId: string) => ExecutionTarget | null
  setPendingHandoffTarget: (sessionId: string, target: ExecutionTarget) => void
  getPendingHandoffTarget: (sessionId: string) => ExecutionTarget | null
  clearPendingHandoffTarget: (sessionId: string) => void
  saveLastUsedTarget: (target: ExecutionTarget) => void
  getLastUsedTarget: () => ExecutionTarget | null
}

const isPersistedSelectionState = (state: unknown): state is PersistedSelectionState => (
  typeof state === "object" && state !== null
)

// In-memory variant storage (not persisted)
const agentModelVariantSelections = new Map<string, Map<string, Map<string, string>>>()

// Maximum number of sessions to persist to local storage to prevent unbounded growth
const MAX_PERSISTED_SESSIONS = 150

const sanitizePersistedTargets = (entries: unknown): Map<string, ExecutionTarget> => {
  const map = new Map<string, ExecutionTarget>()
  if (!Array.isArray(entries)) {
    return map
  }
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue
    }
    const [sessionId, target] = entry
    if (typeof sessionId !== "string" || sessionId.length === 0 || !isExecutionTarget(target)) {
      continue
    }
    map.set(sessionId, target)
  }
  return map
}

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      sessionTargets: new Map(),
      pendingHandoffTargets: new Map(),
      lastUsedProvider: null,
      lastUsedTarget: null,

      saveSessionModelSelection: (sessionId, providerId, modelId) =>
        set((s) => {
          const map = new Map(s.sessionModelSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(sessionId, { providerId, modelId })
          return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
        }),

      getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

      saveSessionAgentSelection: (sessionId, agentName) =>
        set((s) => {
          if (s.sessionAgentSelections.get(sessionId) === agentName) return s
          const map = new Map(s.sessionAgentSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(sessionId, agentName)
          return { sessionAgentSelections: map }
        }),

      getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,

      saveAgentModelForSession: (sessionId, agentName, providerId, modelId) =>
        set((s) => {
          const existing = s.sessionAgentModelSelections.get(sessionId)?.get(agentName)
          if (existing?.providerId === providerId && existing?.modelId === modelId) return s
          const outer = new Map(s.sessionAgentModelSelections)
          const inner = new Map(outer.get(sessionId) ?? new Map())

          outer.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          inner.set(agentName, { providerId, modelId })
          outer.set(sessionId, inner)

          return { sessionAgentModelSelections: outer }
        }),

      getAgentModelForSession: (sessionId, agentName) =>
        get().sessionAgentModelSelections.get(sessionId)?.get(agentName) ?? null,

      saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
        const key = `${providerId}/${modelId}`
        let agentMap = agentModelVariantSelections.get(sessionId)
        if (!agentMap && variant) {
          agentMap = new Map()
          agentModelVariantSelections.set(sessionId, agentMap)
        }
        if (!agentMap) return
        let modelMap = agentMap.get(agentName)
        if (!modelMap && variant) {
          modelMap = new Map()
          agentMap.set(agentName, modelMap)
        }
        if (!modelMap) return

        if (!variant) {
          modelMap.delete(key)
          if (modelMap.size === 0) {
            agentMap.delete(agentName)
          }
          if (agentMap.size === 0) {
            agentModelVariantSelections.delete(sessionId)
          }
          return
        }

        modelMap.set(key, variant)
      },

      getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
        const key = `${providerId}/${modelId}`
        return agentModelVariantSelections.get(sessionId)?.get(agentName)?.get(key)
      },

      saveSessionTarget: (sessionId, target) =>
        set((s) => {
          if (!isExecutionTarget(target)) return s
          const existing = s.sessionTargets.get(sessionId)
          if (existing && JSON.stringify(existing) === JSON.stringify(target)) {
            return { lastUsedTarget: target }
          }
          const map = new Map(s.sessionTargets)
          map.delete(sessionId)
          map.set(sessionId, target)
          return { sessionTargets: map, lastUsedTarget: target }
        }),

      getSessionTarget: (sessionId) => get().sessionTargets.get(sessionId) ?? null,

      setPendingHandoffTarget: (sessionId, target) =>
        set((s) => {
          if (!sessionId.trim() || !isExecutionTarget(target)) return s
          const existing = s.pendingHandoffTargets.get(sessionId)
          if (existing && JSON.stringify(existing) === JSON.stringify(target)) return s
          const map = new Map(s.pendingHandoffTargets)
          map.set(sessionId, target)
          return { pendingHandoffTargets: map }
        }),

      getPendingHandoffTarget: (sessionId) => get().pendingHandoffTargets.get(sessionId) ?? null,

      clearPendingHandoffTarget: (sessionId) =>
        set((s) => {
          if (!s.pendingHandoffTargets.has(sessionId)) return s
          const map = new Map(s.pendingHandoffTargets)
          map.delete(sessionId)
          return { pendingHandoffTargets: map }
        }),

      saveLastUsedTarget: (target) => {
        if (!isExecutionTarget(target)) return
        set({ lastUsedTarget: target })
      },

      getLastUsedTarget: () => get().lastUsedTarget,
    }),
    {
      name: "selection-store",
      version: 2,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => {
        // Convert Maps to arrays and slice to keep only the most recent MAX_PERSISTED_SESSIONS
        const models = Array.from(state.sessionModelSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agents = Array.from(state.sessionAgentSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agentModels = Array.from(state.sessionAgentModelSelections.entries())
          .slice(-MAX_PERSISTED_SESSIONS)
          .map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())])
        const targets = Array.from(state.sessionTargets.entries()).slice(-MAX_PERSISTED_SESSIONS)

        return {
          sessionModelSelections: models,
          sessionAgentSelections: agents,
          sessionAgentModelSelections: agentModels,
          sessionTargets: targets,
          lastUsedProvider: state.lastUsedProvider,
          lastUsedTarget: state.lastUsedTarget && isExecutionTarget(state.lastUsedTarget)
            ? state.lastUsedTarget
            : null,
        }
      },
      merge: (persistedState: unknown, currentState) => {
        const persisted = isPersistedSelectionState(persistedState) ? persistedState : undefined
        const agentModelSelections = new Map<string, Map<string, ModelSelection>>()
        if (Array.isArray(persisted?.sessionAgentModelSelections)) {
          persisted.sessionAgentModelSelections.forEach(([sessionId, agentArray]) => {
            agentModelSelections.set(sessionId, new Map(agentArray))
          })
        }

        const lastUsedTarget = persisted?.lastUsedTarget && isExecutionTarget(persisted.lastUsedTarget)
          ? persisted.lastUsedTarget
          : currentState.lastUsedTarget

        return {
          ...currentState,
          lastUsedProvider: persisted?.lastUsedProvider ?? currentState.lastUsedProvider,
          lastUsedTarget,
          sessionModelSelections: new Map(persisted?.sessionModelSelections ?? []),
          sessionAgentSelections: new Map(persisted?.sessionAgentSelections ?? []),
          sessionAgentModelSelections: agentModelSelections,
          sessionTargets: sanitizePersistedTargets(persisted?.sessionTargets),
        }
      },
      migrate: (persistedState: unknown, version) => {
        if (!isPersistedSelectionState(persistedState)) {
          return persistedState
        }
        if (version < 2) {
          return {
            ...persistedState,
            sessionTargets: Array.isArray(persistedState.sessionTargets) ? persistedState.sessionTargets : [],
            lastUsedTarget: persistedState.lastUsedTarget ?? null,
          }
        }
        return persistedState
      }
    }
  )
)
