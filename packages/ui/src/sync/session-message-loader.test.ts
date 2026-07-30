import { describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"

const createRecord = (sessionID: string, id = "msg_1") => ({
  info: { id, sessionID, role: "user", time: { created: 1 } } as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "hello" }] as Part[],
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const response = (data: ReturnType<typeof createRecord>[], cursor?: string) => ({
  data,
  response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor ?? null : null } },
})

const createLoader = (messages: (input: {
  sessionID: string
  directory?: string
  limit?: number
  before?: string
}) => Promise<unknown>) => {
  const childStores = new ChildStoreManager()
  const sdk = { session: { messages } } as unknown as OpencodeClient
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" })
  return { childStores, loader }
}

describe("SessionMessageLoader", () => {
  test("deduplicates navigation and reactive loading for the same target", async () => {
    const pending = deferred<ReturnType<typeof response>>()
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return pending.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const navigation = loader.ensure(target, { reason: "navigation" })
    const reactive = loader.ensure(target, { reason: "reactive" })
    expect(calls).toBe(1)

    pending.resolve(response([createRecord(target.sessionID)]))
    await Promise.all([navigation, reactive])

    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("runs a requested tail refresh after an older in-flight load", async () => {
    const initial = deferred<ReturnType<typeof response>>()
    const refresh = deferred<ReturnType<typeof response>>()
    let calls = 0
    const limits: number[] = []
    const { childStores, loader } = createLoader(async ({ limit }) => {
      calls += 1
      limits.push(limit ?? 0)
      return calls === 1 ? initial.promise : refresh.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target, { reason: "navigation" })
    const refreshing = loader.refreshTail(target, 30)
    const duplicateRefresh = loader.refreshTail(target, 80)
    expect(calls).toBe(1)
    expect(duplicateRefresh).toBe(refreshing)

    initial.resolve(response([createRecord(target.sessionID, "msg_1")]))
    await loading
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(limits).toEqual([50, 80])

    refresh.resolve(response([createRecord(target.sessionID, "msg_2")]))
    await Promise.all([refreshing, duplicateRefresh])

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_1", "msg_2"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("preserves complete history coverage across a tail refresh", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1
        ? response([createRecord(sessionID, "msg_1")])
        : response([createRecord(sessionID, "msg_2")], "stale-tail-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)

    await loader.refreshTail(target, 2)

    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not deduplicate identical session IDs across directories", async () => {
    const calls: string[] = []
    const { childStores, loader } = createLoader(async ({ directory, sessionID }) => {
      calls.push(directory ?? "")
      return response([createRecord(sessionID)])
    })

    await Promise.all([
      loader.ensure({ directory: "/repo-a", sessionID: "shared" }),
      loader.ensure({ directory: "/repo-b", sessionID: "shared" }),
    ])

    expect(calls.sort()).toEqual(["/repo-a", "/repo-b"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("exposes a retryable error without clearing an existing snapshot", async () => {
    let fail = true
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      if (fail) return { error: { message: "rejected" }, response: { status: 400 } }
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({ message: { [target.sessionID]: [{ id: "cached", sessionID: target.sessionID, role: "user", time: { created: 0 } } as Message] } })

    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("error")
    expect(store.getState().message[target.sessionID]?.[0]?.id).toBe("cached")

    fail = false
    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("ready")
    loader.dispose()
    childStores.disposeAll()
  })

  test("prevents an evicted in-flight request from repopulating the store", async () => {
    const pending = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async () => pending.promise)
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target)
    loader.invalidateSession(target)
    pending.resolve(response([createRecord(target.sessionID)]))
    await loading

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toBe(undefined)
    expect(loader.getSnapshot(target).status).toBe("idle")
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries when an in-flight load goes stale before commit", async () => {
    const first = deferred<ReturnType<typeof response>>()
    const second = deferred<ReturnType<typeof response>>()
    let calls = 0
    const childStores = new ChildStoreManager()
    const sdkA = { session: { messages: async () => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    } } } as unknown as OpencodeClient
    const loader = new SessionMessageLoader(childStores, { sdk: sdkA, runtimeKey: "runtime-a" })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target, { reason: "navigation" })
    // Recreate the SDK client mid-flight (SyncProvider configure) — previously
    // marked the fetch stale and left Claude sessions with zero messages.
    loader.configure({
      sdk: { session: { messages: async () => {
        calls += 1
        return second.promise
      } } } as unknown as OpencodeClient,
      runtimeKey: "runtime-a",
    })
    first.resolve(response([createRecord(target.sessionID, "msg_stale")]))
    await loading
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length ?? 0).toBe(0)

    // Auto-retry must land without a manual ensure — ChatContainer deps do not
    // change when a stale load commits nothing.
    second.resolve(response([createRecord(target.sessionID, "msg_live")]))
    await new Promise((resolve) => setTimeout(resolve, 1600))

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_live"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries after invalidateDirectory deletes the loader entry mid-flight", async () => {
    const first = deferred<ReturnType<typeof response>>()
    const second = deferred<ReturnType<typeof response>>()
    let calls = 0
    const childStores = new ChildStoreManager()
    const sdk = { session: { messages: async () => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    } } } as unknown as OpencodeClient
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" })
    const target = { directory: "/repo", sessionID: "session-b" }

    const loading = loader.ensure(target, { reason: "navigation" })
    // Directory disposal deletes the entry; the previous identity check aborted retry.
    loader.invalidateDirectory(target.directory)
    childStores.disposeDirectory(target.directory)
    first.resolve(response([createRecord(target.sessionID, "msg_stale")]))
    await loading
    expect(calls).toBe(1)

    second.resolve(response([createRecord(target.sessionID, "msg_live")]))
    await new Promise((resolve) => setTimeout(resolve, 1600))

    expect(calls).toBeGreaterThan(1)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_live"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries early empty snapshots so Claude harness overlay can catch up", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      if (calls === 1) return response([])
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "claude-empty-race" }

    await loader.ensure(target, { reason: "reactive" })
    expect(loader.getSnapshot(target).emptyHydrated).toBe(true)
    expect(loader.getSnapshot(target).emptyHydrationAttempts).toBe(1)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([])

    // Cooldown still active — reactive ensure must not storm.
    await loader.ensure(target, { reason: "reactive" })
    expect(calls).toBe(1)

    // Navigation ignores the empty-hydration sticky bit and refetches.
    await loader.ensure(target, { reason: "navigation" })
    expect(calls).toBe(2)
    expect(loader.getSnapshot(target).emptyHydrated).toBe(false)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)

    loader.dispose()
    childStores.disposeAll()
  })

  test("treats an empty successful response as resolved authoritative state", async () => {
    const { childStores, loader } = createLoader(async () => response([]))
    const target = { directory: "/repo", sessionID: "empty" }

    await loader.ensure(target)

    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries a missing message payload instead of treating it as an empty snapshot", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1 ? {} : response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)

    expect(calls).toBe(2)
    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("configure revives a disposed loader so Strict Mode cleanup cannot stick", async () => {
    const { childStores, loader } = createLoader(async ({ sessionID }) => response([createRecord(sessionID, "msg_live")]))
    const target = { directory: "/repo", sessionID: "session-revive" }

    loader.dispose()
    expect(loader.getSnapshot(target).status).toBe("idle")

    loader.configure({
      sdk: { session: { messages: async ({ sessionID }: { sessionID: string }) => response([createRecord(sessionID, "msg_live")]) } } as unknown as OpencodeClient,
      runtimeKey: "runtime-a",
    })
    await loader.ensure(target, { force: true, reason: "navigation" })

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_live"])
    loader.dispose()
    childStores.disposeAll()
  })
})
