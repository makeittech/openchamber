import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { Binary } from "./binary"
import { retry } from "./retry"
import { mergeOptimisticPage, type OptimisticItem } from "./optimistic"
import { stripMessageDiffSnapshots } from "./sanitize"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import {
  clearDirectorySessionPrefetch,
  clearRuntimeSessionPrefetch,
  clearSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch-cache"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { normalizePath } from "@/lib/pathNormalization"
import { startSessionLoadPerformanceEvent } from "./session-load-performance"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const INITIAL_MESSAGE_PAGE_SIZE = 50
const CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE = 30
const HISTORY_MESSAGE_PAGE_SIZE = 100
const INITIAL_PAGE_EXPANSION_LIMITS = [100, 150] as const
const CONSTRAINED_INITIAL_PAGE_EXPANSION_LIMITS = [50, 80, 120] as const
const cmp = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export type SessionMessageTarget = {
  directory: string
  sessionID: string
}

export type SessionMessageLoadKind = "initial" | "older" | "refresh" | "prefetch"
export type SessionMessageLoadStatus = "idle" | "loading" | "ready" | "error"

export type SessionMessageLoadState = {
  status: SessionMessageLoadStatus
  loadingKind: SessionMessageLoadKind | null
  error: Error | null
  resolved: boolean
  limit: number
  cursor: string | undefined
  complete: boolean
  generation: number
  updatedAt: number | undefined
  /**
   * An early empty [] snapshot looks renderable and would skip Claude harness
   * overlay hydration forever. Empty OpenCode sessions stay resolved after one
   * successful empty fetch, but Claude turns can appear in the harness overlay
   * shortly after that first miss — retry a bounded number of times with a
   * short cooldown (or immediately on force/navigation) until messages arrive.
   */
  emptyHydrated: boolean
  emptyHydrationAttempts: number
  emptyHydratedAt: number | undefined
}

type LoaderEntry = {
  snapshot: SessionMessageLoadState
  listeners: Set<() => void>
  inflight: Promise<void> | null
  queuedRefresh: Promise<void> | null
  queuedRefreshLimit: number
  optimistic: Map<string, OptimisticItem>
}

type FetchedPage = {
  session: Message[]
  partsByMessageID: Map<string, Part[]>
  cursor: string | undefined
  complete: boolean
}

type LoadPerformanceDetails = {
  retryCount: number
  recordCount: number
}

type LoaderConfiguration = {
  sdk: OpencodeClient
  runtimeKey: string
}

const isConstrainedRuntime = () => isVSCodeRuntime() || isMobileSurfaceRuntime()
const getInitialPageSize = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE
  : INITIAL_MESSAGE_PAGE_SIZE
const getInitialExpansionLimits = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_PAGE_EXPANSION_LIMITS
  : INITIAL_PAGE_EXPANSION_LIMITS

/** Bounded retries after an early empty [] so Claude harness overlay can catch up. */
const EMPTY_HYDRATION_MAX_ATTEMPTS = 8
const EMPTY_HYDRATION_RETRY_MS = 1_500

const needsEmptyHydrationRetry = (
  entry: LoaderEntry,
  localCount: number,
  options?: { force?: boolean; reason?: "navigation" | "reactive" | "prefetch" },
): boolean => {
  if (localCount > 0) return false
  if (options?.force || options?.reason === "navigation") return true
  if (!entry.snapshot.emptyHydrated) return true
  if (entry.snapshot.emptyHydrationAttempts >= EMPTY_HYDRATION_MAX_ATTEMPTS) return false
  const hydratedAt = entry.snapshot.emptyHydratedAt ?? 0
  return Date.now() - hydratedAt >= EMPTY_HYDRATION_RETRY_MS
}

const isUserMessage = (message: Message): boolean => {
  const candidate = message as Message & { clientRole?: unknown; role?: unknown }
  const role = typeof candidate.clientRole === "string" ? candidate.clientRole : candidate.role
  return role === "user"
}

const hasUserMessage = (messages: Message[]): boolean => messages.some(isUserMessage)

const formatSdkError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return "Session messages could not be loaded"
}

const assertSdkSuccess = (result: {
  error?: unknown
  response?: { status?: number }
}, operation: string): void => {
  if (!result.error) return
  const status = result.response?.status
  const message = `${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`
  const error = new Error(message) as Error & { status?: number }
  if (status !== undefined) error.status = status
  throw error
}

const sortParts = (parts: Part[]): Part[] => parts
  .filter((part) => Boolean(part?.id))
  .sort((left, right) => cmp(left.id, right.id))

const createDefaultState = (generation = 0): SessionMessageLoadState => ({
  status: "idle",
  loadingKind: null,
  error: null,
  resolved: false,
  limit: getInitialPageSize(),
  cursor: undefined,
  complete: false,
  generation,
  updatedAt: undefined,
  emptyHydrated: false,
  emptyHydrationAttempts: 0,
  emptyHydratedAt: undefined,
})

export const EMPTY_SESSION_MESSAGE_LOAD_STATE = createDefaultState()

export class SessionMessageLoader {
  private sdk: OpencodeClient
  private runtimeKey: string
  private sdkEpoch = 0
  private disposed = false
  private readonly entries = new Map<string, LoaderEntry>()

  constructor(
    private readonly childStores: ChildStoreManager,
    configuration: LoaderConfiguration,
  ) {
    this.sdk = configuration.sdk
    this.runtimeKey = configuration.runtimeKey
  }

  configure(configuration: LoaderConfiguration): void {
    // React Strict Mode runs effect cleanups that call dispose() while keeping
    // this same loader instance mounted. Always clear the disposed bit on
    // configure so remounted effects can hydrate again.
    this.disposed = false
    if (this.sdk === configuration.sdk && this.runtimeKey === configuration.runtimeKey) return
    const runtimeChanged = this.runtimeKey !== configuration.runtimeKey
    const previousRuntimeKey = this.runtimeKey
    this.sdk = configuration.sdk
    this.runtimeKey = configuration.runtimeKey
    this.sdkEpoch += 1
    for (const entry of this.entries.values()) {
      entry.snapshot = {
        ...entry.snapshot,
        status: entry.snapshot.resolved ? "ready" : "idle",
        loadingKind: null,
        error: null,
        generation: entry.snapshot.generation + 1,
      }
      entry.inflight = null
      this.notify(entry)
    }
    if (runtimeChanged) {
      this.entries.clear()
      clearRuntimeSessionPrefetch(previousRuntimeKey)
    }
  }

  /**
   * Re-enable a loader which was disposed by a transient React effect cleanup.
   *
   * React Strict Mode runs effect setup, cleanup, then setup again in
   * development. The provider owns one ref-stable loader across that sequence,
   * so the second setup must be able to accept new work after the first cleanup
   * invalidated its in-flight requests.
   */
  activate(): void {
    this.disposed = false
  }

  ensure(
    target: SessionMessageTarget,
    options?: { force?: boolean; reason?: "navigation" | "reactive" | "prefetch" },
  ): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const materialization = getSessionMaterializationStatus(store.getState(), normalized.sessionID)
    const localCount = store.getState().message[normalized.sessionID]?.length ?? 0
    // Claude turns are served via the harness message overlay. An early empty
    // [] snapshot looks "renderable" and would skip hydration forever — force
    // one fetch when the local transcript is still empty, then retry briefly.
    const needsEmptyHydration = needsEmptyHydrationRetry(entry, localCount, options)
    if (!options?.force && materialization.renderable && !needsEmptyHydration) {
      if (!entry.snapshot.resolved) {
        this.patchEntry(entry, {
          status: "ready",
          error: null,
          resolved: true,
          limit: Math.max(entry.snapshot.limit, localCount),
        })
      }
      return entry.inflight ?? Promise.resolve()
    }
    if (entry.inflight) {
      if (options?.reason !== "prefetch" && entry.snapshot.loadingKind === "prefetch") {
        this.patchEntry(entry, { loadingKind: "initial" })
      }
      return entry.inflight
    }
    if (options?.force) this.bumpGeneration(entry)
    const kind: SessionMessageLoadKind = options?.reason === "prefetch" ? "prefetch" : "initial"
    return this.startLoad(normalized, entry, store, kind, async (isCurrent, resolveStore, performance) => {
      await this.loadInitial(normalized, entry, resolveStore(), isCurrent, performance)
      if (!isCurrent()) return
      const hydratedCount = resolveStore().getState().message[normalized.sessionID]?.length ?? 0
      if (hydratedCount > 0) {
        this.patchEntry(entry, {
          emptyHydrated: false,
          emptyHydrationAttempts: 0,
          emptyHydratedAt: undefined,
        })
      } else {
        const attempts = entry.snapshot.emptyHydrationAttempts + 1
        this.patchEntry(entry, {
          emptyHydrated: true,
          emptyHydrationAttempts: attempts,
          emptyHydratedAt: Date.now(),
        })
        // Claude harness overlay can populate after the first empty OpenCode
        // snapshot. Self-schedule bounded retries so chat does not stay blank
        // waiting for a later navigation/force.
        if (attempts < EMPTY_HYDRATION_MAX_ATTEMPTS) {
          const entryKey = this.keyFor(normalized)
          const generation = entry.snapshot.generation
          setTimeout(() => {
            if (this.disposed) return
            const current = this.entries.get(entryKey)
            if (!current || current.snapshot.generation !== generation) return
            const count = resolveStore().getState().message[normalized.sessionID]?.length ?? 0
            if (count > 0) return
            void this.ensure(normalized, { reason: "reactive" })
          }, EMPTY_HYDRATION_RETRY_MS)
        }
      }
      if (!isMobileSurfaceRuntime() && isCurrent()) {
        queueMicrotask(() => {
          if (isCurrent() && entry.snapshot.cursor && !entry.snapshot.complete) {
            void this.loadOlder(normalized)
          }
        })
      }
    })
  }

  prefetch(target: SessionMessageTarget): Promise<void> {
    return this.ensure(target, { reason: "prefetch" })
  }

  loadOlder(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) return entry.inflight.then(() => this.loadOlder(normalized))
    if (entry.snapshot.complete || !entry.snapshot.cursor) return Promise.resolve()
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const cursor = entry.snapshot.cursor
    return this.startLoad(normalized, entry, store, "older", async (isCurrent, resolveStore, performance) => {
      const page = await this.fetchPage(normalized, HISTORY_MESSAGE_PAGE_SIZE, cursor, "older", performance)
      if (!isCurrent()) return
      const committed = this.commitPage(normalized, entry, resolveStore(), page, "prepend", isCurrent)
      if (!committed || !isCurrent()) return
      this.patchEntry(entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: Math.max(entry.snapshot.limit, committed.messages.length),
        cursor: page.cursor,
        complete: page.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  async loadComplete(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) throw new Error("Session message loader is unavailable")
    const initial = this.getSnapshot(normalized)
    await this.ensure(normalized, { force: !initial.resolved })

    const visitedCursors = new Set<string>()
    while (true) {
      const snapshot = this.getSnapshot(normalized)
      if (snapshot.status === "error") throw snapshot.error ?? new Error("Session history could not be loaded")
      if (snapshot.complete) return
      if (!snapshot.cursor) throw new Error("Session history coverage is unresolved")
      if (visitedCursors.has(snapshot.cursor)) {
        throw new Error("Session history pagination made no progress")
      }
      visitedCursors.add(snapshot.cursor)

      await this.loadOlder(normalized)
    }
  }

  refreshTail(target: SessionMessageTarget, limit: number): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) {
      entry.queuedRefreshLimit = Math.max(entry.queuedRefreshLimit, limit)
      if (entry.queuedRefresh) return entry.queuedRefresh
      const inflight = entry.inflight
      const entryKey = this.keyFor(normalized)
      const generation = entry.snapshot.generation
      const sdkEpoch = this.sdkEpoch
      const clearQueuedRefresh = () => {
        if (entry.queuedRefresh !== queuedRefresh) return
        entry.queuedRefresh = null
        entry.queuedRefreshLimit = 0
      }
      const queuedRefresh = inflight.then(() => {
        if (
          this.disposed
          || this.sdkEpoch !== sdkEpoch
          || entry.snapshot.generation !== generation
          || this.entries.get(entryKey) !== entry
        ) {
          clearQueuedRefresh()
          return
        }
        const refreshLimit = entry.queuedRefreshLimit
        clearQueuedRefresh()
        return this.refreshTail(normalized, refreshLimit)
      })
      entry.queuedRefresh = queuedRefresh
      return queuedRefresh
    }
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    this.bumpGeneration(entry)
    return this.startLoad(normalized, entry, store, "refresh", async (isCurrent, resolveStore, performance) => {
      const previousCoverage = entry.snapshot.resolved
        ? { cursor: entry.snapshot.cursor, complete: entry.snapshot.complete }
        : null
      const page = await this.fetchPage(normalized, Math.max(1, limit), undefined, "refresh", performance)
      if (!isCurrent()) return
      const committed = this.commitPage(normalized, entry, resolveStore(), page, "merge", isCurrent)
      if (!committed || !isCurrent()) return
      const coverage = previousCoverage ?? page
      this.patchEntry(entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: Math.max(entry.snapshot.limit, committed.messages.length),
        // A tail refresh uses a deliberately small window. Its cursor only
        // describes that window, so it must not replace the established
        // history coverage and spuriously expose "load older".
        cursor: coverage.cursor,
        complete: coverage.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  getSnapshot(target: SessionMessageTarget): SessionMessageLoadState {
    const normalized = this.normalizeTarget(target)
    return normalized ? this.getEntry(normalized).snapshot : EMPTY_SESSION_MESSAGE_LOAD_STATE
  }

  subscribe(target: SessionMessageTarget, listener: () => void): () => void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return () => undefined
    const entry = this.getEntry(normalized)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  optimisticAdd(input: SessionMessageTarget & { message: Message; parts: Part[] }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    const entry = this.getEntry(target)
    entry.optimistic.set(input.message.id, { message: input.message, parts: sortParts(input.parts) })
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const messages = current.message[target.sessionID] ? [...current.message[target.sessionID]] : []
    const result = Binary.search(messages, input.message.id, (message) => message.id)
    if (!result.found) messages.splice(result.index, 0, input.message)
    store.setState({
      message: { ...current.message, [target.sessionID]: messages },
      part: { ...current.part, [input.message.id]: sortParts(input.parts) },
    })
  }

  optimisticRemove(input: SessionMessageTarget & { messageID: string }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    const entry = this.getEntry(target)
    entry.optimistic.delete(input.messageID)
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const existing = current.message[target.sessionID]
    const messages = existing ? existing.filter((message) => message.id !== input.messageID) : undefined
    const part = { ...current.part }
    delete part[input.messageID]
    store.setState({
      ...(messages ? { message: { ...current.message, [target.sessionID]: messages } } : {}),
      part,
    })
  }

  optimisticConfirm(input: SessionMessageTarget & { messageID: string }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    this.getEntry(target).optimistic.delete(input.messageID)
  }

  invalidateSession(target: SessionMessageTarget): void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return
    const entry = this.entries.get(this.keyFor(normalized))
    if (!entry) return
    this.bumpGeneration(entry)
    entry.inflight = null
    entry.optimistic.clear()
    entry.snapshot = createDefaultState(entry.snapshot.generation)
    clearSessionPrefetch(normalized.directory, [normalized.sessionID], this.runtimeKey)
    this.notify(entry)
  }

  invalidateDirectory(directory: string): void {
    const normalizedDirectory = normalizePath(directory)
    if (!normalizedDirectory) return
    const prefix = `${this.runtimeKey}\n${normalizedDirectory}\n`
    clearDirectorySessionPrefetch(normalizedDirectory, this.runtimeKey)
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue
      this.bumpGeneration(entry)
      entry.inflight = null
      entry.optimistic.clear()
      this.entries.delete(key)
      this.notify(entry)
    }
  }

  dispose(): void {
    this.disposed = true
    this.sdkEpoch += 1
    for (const entry of this.entries.values()) {
      this.bumpGeneration(entry)
      entry.inflight = null
      entry.optimistic.clear()
      this.notify(entry)
    }
    this.entries.clear()
    clearRuntimeSessionPrefetch(this.runtimeKey)
  }

  private normalizeTarget(target: SessionMessageTarget): SessionMessageTarget | null {
    const directory = normalizePath(target.directory)
    if (!directory || !target.sessionID) return null
    return { directory, sessionID: target.sessionID }
  }

  private keyFor(target: SessionMessageTarget): string {
    return `${this.runtimeKey}\n${target.directory}\n${target.sessionID}`
  }

  private getEntry(target: SessionMessageTarget): LoaderEntry {
    const key = this.keyFor(target)
    const existing = this.entries.get(key)
    if (existing) return existing
    const prefetched = getSessionPrefetch(target.directory, target.sessionID, this.runtimeKey)
    const entry: LoaderEntry = {
      snapshot: prefetched
        ? {
            ...createDefaultState(),
            status: "ready",
            resolved: true,
            limit: prefetched.limit,
            cursor: prefetched.cursor,
            complete: prefetched.complete,
            updatedAt: prefetched.at,
          }
        : createDefaultState(),
      listeners: new Set(),
      inflight: null,
      queuedRefresh: null,
      queuedRefreshLimit: 0,
      optimistic: new Map(),
    }
    this.entries.set(key, entry)
    return entry
  }

  private patchEntry(entry: LoaderEntry, patch: Partial<SessionMessageLoadState>): void {
    entry.snapshot = { ...entry.snapshot, ...patch }
    this.notify(entry)
  }

  private bumpGeneration(entry: LoaderEntry): number {
    const generation = entry.snapshot.generation + 1
    entry.snapshot = { ...entry.snapshot, generation }
    return generation
  }

  private notify(entry: LoaderEntry): void {
    for (const listener of entry.listeners) listener()
  }

  private startLoad(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    kind: SessionMessageLoadKind,
    run: (
      isCurrent: () => boolean,
      resolveStore: () => { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
      performance: LoadPerformanceDetails,
    ) => Promise<void>,
  ): Promise<void> {
    const generation = entry.snapshot.generation
    const sdkEpoch = this.sdkEpoch
    const finishPerformanceEvent = startSessionLoadPerformanceEvent({
      operation: kind === "prefetch" ? "session-prefetch" : `session-messages.${kind}`,
      caller: kind,
    })
    // Do not pin isCurrent() to the store object identity captured at start.
    // Directory bootstrap can replace the child store while a message fetch is
    // in flight; discarding that response left Claude harness sessions blank
    // (outcome "stale") with no automatic retry. Generation + sdkEpoch still
    // reject forced refreshes, eviction, and runtime switches.
    const isCurrent = () => (
      !this.disposed
      && this.sdkEpoch === sdkEpoch
      && entry.snapshot.generation === generation
      && Boolean(this.childStores.getChild(target.directory))
    )
    const resolveStore = () => this.childStores.ensureChild(target.directory, { bootstrap: false })
    const performance = { retryCount: 0, recordCount: 0 }
    this.patchEntry(entry, { status: "loading", loadingKind: kind, error: null })
    let loadPromise: Promise<void>
    try {
      loadPromise = run(isCurrent, resolveStore, performance)
    } catch (error) {
      loadPromise = Promise.reject(error)
    }
    const promise = loadPromise
      .then(() => {
        const completed = isCurrent()
        finishPerformanceEvent(completed ? "complete" : "stale", performance)
        if (completed) return
        // Stale empty loads must retry — otherwise Claude overlay data fetched
        // during bootstrap store replacement / directory invalidation never
        // lands in the live store. Do not require the same entry object:
        // invalidateDirectory deletes entries, and requiring identity silently
        // dropped the only recovery path (ChatContainer deps also stay unchanged
        // when a stale load commits nothing).
        if (this.disposed) return
        const liveCount = () => (
          this.childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length ?? 0
        )
        if (liveCount() > 0) return
        const scheduleStaleRetry = (attempt: number) => {
          setTimeout(() => {
            if (this.disposed) return
            try {
              this.childStores.ensureChild(target.directory, { bootstrap: false })
            } catch {
              if (attempt < 4) scheduleStaleRetry(attempt + 1)
              return
            }
            if (liveCount() > 0) return
            void this.ensure(target, { force: true, reason: "navigation" }).then(() => {
              if (this.disposed) return
              if (liveCount() > 0) return
              if (attempt < 4) scheduleStaleRetry(attempt + 1)
            })
          }, EMPTY_HYDRATION_RETRY_MS)
        }
        scheduleStaleRetry(0)
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          finishPerformanceEvent("stale", performance)
          return
        }
        finishPerformanceEvent("error", performance)
        this.patchEntry(entry, {
          status: "error",
          loadingKind: null,
          error: error instanceof Error ? error : new Error(formatSdkError(error)),
        })
      })
      .finally(() => {
        if (entry.inflight === promise) entry.inflight = null
      })
    entry.inflight = promise
    return promise
  }

  private async loadInitial(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    isCurrent: () => boolean,
    performance?: LoadPerformanceDetails,
  ): Promise<void> {
    const storeMessageCount = store.getState().message[target.sessionID]?.length ?? 0
    const firstLimit = Math.max(entry.snapshot.limit, storeMessageCount, getInitialPageSize())
    const firstPage = await this.fetchPage(target, firstLimit, undefined, "initial-page", performance)
    if (!isCurrent()) return
    // Re-resolve after await — directory bootstrap may have replaced the child store.
    const liveStore = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const deferFirstCommit = !firstPage.complete && !hasUserMessage(firstPage.session)
    let committed = deferFirstCommit
      ? { messages: firstPage.session }
      : this.commitPage(target, entry, liveStore, firstPage, "merge", isCurrent)
    let acceptedPage = firstPage

    if (deferFirstCommit) {
      for (const limit of getInitialExpansionLimits()) {
        if (limit <= firstLimit || !isCurrent()) continue
        const expandedPage = await this.fetchPage(target, limit, undefined, "initial-page", performance)
        if (!isCurrent()) return
        acceptedPage = expandedPage
        const boundaryFound = hasUserMessage(expandedPage.session)
        const isLast = limit === getInitialExpansionLimits()[getInitialExpansionLimits().length - 1]
        const commitStore = this.childStores.ensureChild(target.directory, { bootstrap: false })
        if (expandedPage.complete || boundaryFound || isLast) {
          committed = this.commitPage(target, entry, commitStore, expandedPage, "merge", isCurrent)
        } else {
          committed = { messages: expandedPage.session }
        }
        if (expandedPage.complete || boundaryFound) break
      }
    }

    if (!committed || !isCurrent()) return
    this.patchEntry(entry, {
      status: "ready",
      loadingKind: null,
      error: null,
      resolved: true,
      limit: committed.messages.length,
      cursor: acceptedPage.cursor,
      complete: acceptedPage.complete,
      updatedAt: Date.now(),
    })
    this.persistCoverage(target, entry.snapshot)
  }

  private async fetchPage(
    target: SessionMessageTarget,
    limit: number,
    before?: string,
    caller: "initial-page" | "older" | "refresh" = "initial-page",
    performance?: LoadPerformanceDetails,
  ): Promise<FetchedPage> {
    const finishPagePerformance = startSessionLoadPerformanceEvent({
      operation: "session-messages.page",
      caller,
      requestLimit: limit,
      cursorPresent: before !== undefined,
    })
    let attempts = 0
    let recordCount = 0
    try {
      const result = await retry(async () => {
        attempts += 1
        const response = await this.sdk.session.messages({
          sessionID: target.sessionID,
          directory: target.directory,
          limit,
          before,
        })
        assertSdkSuccess(response, "session.messages")
        const data = response.data
        if (!Array.isArray(data)) {
          const error = new Error("session.messages returned no data") as Error & { status?: number }
          error.status = 503
          throw error
        }
        return { data, response: response.response }
      })
      const records = result.data.filter((record: { info?: { id?: string } }) => Boolean(record?.info?.id))
      recordCount = records.length
      if (performance) performance.recordCount += recordCount
      const session = records
        .map((record: { info: Message }) => stripMessageDiffSnapshots(record.info))
        .sort((left: Message, right: Message) => cmp(left.id, right.id))
      const partsByMessageID = new Map<string, Part[]>()
      for (const record of records as Array<{ info: { id: string }; parts?: Part[] }>) {
        partsByMessageID.set(record.info.id, sortParts(record.parts ?? []))
      }
      const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
      finishPagePerformance("complete", { retryCount: Math.max(0, attempts - 1), recordCount })
      return { session, partsByMessageID, cursor, complete: !cursor }
    } catch (error) {
      finishPagePerformance("error", { retryCount: Math.max(0, attempts - 1), recordCount })
      throw error
    } finally {
      if (performance) performance.retryCount += Math.max(0, attempts - 1)
    }
  }

  private commitPage(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    page: FetchedPage,
    mode: "merge" | "prepend",
    isCurrent: () => boolean,
  ): { messages: Message[] } | null {
    if (!isCurrent()) return null
    const merged = mergeOptimisticPage({
      session: page.session,
      part: [...page.partsByMessageID].map(([id, part]) => ({ id, part })),
      cursor: page.cursor,
      complete: page.complete,
    }, [...entry.optimistic.values()])
    for (const messageID of merged.confirmed) entry.optimistic.delete(messageID)
    const mergedPartsByMessageID = new Map(merged.part.map((candidate) => [candidate.id, candidate.part] as const))
    const materialized = materializeSessionSnapshots(
      store.getState(),
      target.sessionID,
      merged.session.map((info) => ({
        info,
        parts: page.partsByMessageID.get(info.id)
          ?? mergedPartsByMessageID.get(info.id)
          ?? [],
      })),
      { skipPartTypes: SKIP_PARTS, mode },
    )
    if (!isCurrent()) return null
    if (materialized.messagesChanged || materialized.partsChanged) {
      store.setState({
        ...(materialized.messagesChanged ? { message: materialized.message } : {}),
        ...(materialized.partsChanged ? { part: materialized.part } : {}),
      })
    }
    return { messages: materialized.messages }
  }

  private persistCoverage(target: SessionMessageTarget, state: SessionMessageLoadState): void {
    setSessionPrefetch({
      directory: target.directory,
      sessionID: target.sessionID,
      limit: state.limit,
      cursor: state.cursor,
      complete: state.complete,
      at: state.updatedAt,
      runtimeKey: this.runtimeKey,
    })
  }
}

type DirectoryStoreSetter = (
  partial: Partial<DirectoryStore> | ((state: DirectoryStore) => Partial<DirectoryStore> | DirectoryStore),
) => void

let imperativeLoader: SessionMessageLoader | null = null

export function setImperativeSessionMessageLoader(loader: SessionMessageLoader | null): void {
  imperativeLoader = loader
}

export function getImperativeSessionMessageLoader(): SessionMessageLoader | null {
  return imperativeLoader
}
