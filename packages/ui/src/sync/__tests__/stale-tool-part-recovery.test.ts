import { describe, expect, test } from "bun:test"
import type { Part, PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { createStore } from "zustand"
import { type DirectoryStore } from "../child-store"
import {
  applyStaleToolPartSettlements,
  DECLARED_TIMEOUT_SETTLE_GRACE_MS,
} from "../stale-tool-parts"
import { INITIAL_STATE, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return { ...INITIAL_STATE, ...overrides }
}

function runningBash(overrides: {
  timeout?: number
  start?: number
  tool?: string
} = {}): Part {
  const input: Record<string, unknown> = { command: "sleep 999" }
  if (typeof overrides.timeout === "number") input.timeout = overrides.timeout
  return {
    id: "prt_bash",
    messageID: "msg_a",
    sessionID: "ses_1",
    type: "tool",
    tool: overrides.tool ?? "Bash",
    callID: "call_1",
    state: {
      status: "running",
      time: { start: overrides.start ?? 1_000 },
      input,
      output: "",
    },
  } as Part
}

function runningTask(childSessionId: string): Part {
  return {
    id: "prt_task",
    messageID: "msg_parent",
    sessionID: "ses_parent",
    type: "tool",
    tool: "task",
    callID: "call_task",
    state: {
      status: "running",
      time: { start: 1_000 },
      input: { description: "build" },
      metadata: { sessionId: childSessionId },
      output: "",
    },
  } as Part
}

function storeOf(overrides: Partial<State>) {
  return createStore<DirectoryStore>(() => ({
    ...state(overrides),
    patch: () => undefined,
    replace: () => undefined,
  }))
}

describe("applyStaleToolPartSettlements", () => {
  test("settles running tools when the session is idle", () => {
    const store = storeOf({
      session_status: { ses_1: { type: "idle" } },
      part: { msg_a: [runningBash()] },
    })

    expect(applyStaleToolPartSettlements(store, 5_000)).toBe(1)
    const part = store.getState().part.msg_a![0]
    expect(part.type).toBe("tool")
    if (part.type !== "tool") return
    expect(part.state.status).toBe("error")
    expect(part.state.status === "error" ? part.state.time.end : undefined).toBe(5_000)
  })

  test("settles a task tool when its child session is idle while parent stays busy", () => {
    const store = storeOf({
      session_status: {
        ses_parent: { type: "busy" },
        ses_child: { type: "idle" },
      },
      part: { msg_parent: [runningTask("ses_child")] },
    })

    expect(applyStaleToolPartSettlements(store, 5_000)).toBe(1)
    const part = store.getState().part.msg_parent![0]
    expect(part.type).toBe("tool")
    if (part.type !== "tool") return
    expect(part.state.status).toBe("error")
  })

  test("settles busy tools only after declared timeout + grace", () => {
    const timeout = 120_000
    const start = 1_000
    const store = storeOf({
      session_status: { ses_1: { type: "busy" } },
      part: { msg_a: [runningBash({ timeout, start })] },
    })

    // Still inside the timeout budget — leave alone (long tasks must keep running).
    expect(applyStaleToolPartSettlements(store, start + timeout)).toBe(0)

    // Past timeout but inside grace — leave alone.
    expect(applyStaleToolPartSettlements(
      store,
      start + timeout + DECLARED_TIMEOUT_SETTLE_GRACE_MS - 1,
    )).toBe(0)

    // Past timeout + grace — defensive settle for miss-settle after kill.
    const settleAt = start + timeout + DECLARED_TIMEOUT_SETTLE_GRACE_MS
    expect(applyStaleToolPartSettlements(store, settleAt)).toBe(1)
    const part = store.getState().part.msg_a![0]
    expect(part.type).toBe("tool")
    if (part.type !== "tool") return
    expect(part.state.status).toBe("error")
    expect(part.state.status === "error" ? part.state.error : undefined).toContain("declared timeout")
  })

  test("does not wall-clock-kill busy tools without a declared timeout", () => {
    const store = storeOf({
      session_status: { ses_1: { type: "busy" } },
      part: { msg_a: [runningBash({ start: 1_000 })] },
    })

    // One hour later — still running is legitimate for long shell work.
    expect(applyStaleToolPartSettlements(store, 1_000 + 60 * 60 * 1000)).toBe(0)
  })

  test("leaves permission waits alone even when idle", () => {
    const pending = {
      ...runningBash(),
      state: {
        status: "pending" as const,
        input: { command: "sleep 999" },
        raw: "",
      },
    } as Part
    const store = storeOf({
      session_status: { ses_1: { type: "idle" } },
      permission: {
        ses_1: [{
          id: "perm_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        } as PermissionRequest],
      },
      part: { msg_a: [pending] },
    })
    expect(applyStaleToolPartSettlements(store, 5_000)).toBe(0)
  })
})
