import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  parseMessageQueueKey,
  useMessageQueueStore,
} from "./messageQueueStore"

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {} })
})

describe("message queue runtime ownership", () => {
  test("isolates colliding session IDs by runtime and directory", () => {
    const a = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const b = createMessageQueueTarget("session-1", "/repo", "runtime-b")!
    useMessageQueueStore.getState().addToQueue(a, { content: "from A" })
    useMessageQueueStore.getState().addToQueue(b, { content: "from B" })

    expect(useMessageQueueStore.getState().getQueueForTarget(a)[0]?.content).toBe("from A")
    expect(useMessageQueueStore.getState().getQueueForTarget(b)[0]?.content).toBe("from B")
  })

  test("round trips a composite queue key", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target)
  })

  test("quarantines legacy session-only queues instead of activating them", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "session-1": [{ id: "queued-1", content: "legacy", createdAt: 1 }],
      },
    }, 1)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages?.["session-1"]?.[0]?.content).toBe("legacy")
  })

  test("rejects overflow without evicting an accepted message", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 20; index += 1) {
      expect(useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` }).ok).toBe(true)
    }

    const result = useMessageQueueStore.getState().addToQueue(target, { content: "overflow" })

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(result).toEqual({ ok: false, reason: "queue-full" })
    expect(queue).toHaveLength(20)
    expect(queue[0]?.content).toBe("message-0")
  })

  test("rejects a 51st target and preserves every accepted target", () => {
    for (let index = 0; index < 50; index += 1) {
      const target = createMessageQueueTarget(`session-${index}`, "/repo", "runtime-a")!
      expect(useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` }).ok).toBe(true)
    }

    const overflowTarget = createMessageQueueTarget("session-overflow", "/repo", "runtime-a")!
    expect(useMessageQueueStore.getState().addToQueue(overflowTarget, { content: "overflow" }))
      .toEqual({ ok: false, reason: "queue-targets-full" })
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(50)
    expect(useMessageQueueStore.getState().getQueueForTarget(
      createMessageQueueTarget("session-0", "/repo", "runtime-a")!,
    )[0]?.content).toBe("message-0")
  })

  test("returns the generated id for an accepted enqueue", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const result = useMessageQueueStore.getState().addToQueue(target, { content: "accepted" })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.id).toBe(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.id)
    }
  })

  test("keeps reorder and delete behavior unchanged", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const first = useMessageQueueStore.getState().addToQueue(target, { content: "first" })
    const second = useMessageQueueStore.getState().addToQueue(target, { content: "second" })
    if (!first.ok || !second.ok) throw new Error("test setup enqueue failed")

    useMessageQueueStore.getState().reorderQueue(target, first.id, second.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content))
      .toEqual(["second", "first"])
    useMessageQueueStore.getState().removeFromQueue(target, second.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content))
      .toEqual(["first"])
  })

  test("keeps version-two persisted queues active during migration", () => {
    const key = getMessageQueueKey(createMessageQueueTarget("session-1", "/repo", "runtime-a")!)
    const queuedMessages = { [key]: [{ id: "queued-1", content: "persisted", createdAt: 1 }] }

    expect(migrateMessageQueueState({ queuedMessages }, 2).queuedMessages).toEqual(queuedMessages)
  })
})
