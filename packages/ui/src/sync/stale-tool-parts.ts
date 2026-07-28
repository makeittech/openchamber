import type { Part } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import { markDirectorySessionPartChanged, type DirectoryStore } from "./child-store"
import type { State } from "./types"

const FINAL_TOOL_STATUSES = new Set([
  "completed",
  "error",
  "aborted",
  "failed",
  "timeout",
  "cancelled",
])

/**
 * After a tool's declared `input.timeout` elapses, wait this long before
 * defensively settling. Covers OpenCode miss-settle after the tool's own
 * kill window without false-settling tools still inside their budget.
 * Long sleeps (5m–1h) stay alive when the agent sets a matching timeout.
 */
export const DECLARED_TIMEOUT_SETTLE_GRACE_MS = 30_000

const STALE_TOOL_IDLE_ERROR =
  "OpenCode did not settle this tool after the session went idle."

const STALE_TOOL_TIMEOUT_ERROR =
  "OpenCode did not settle this tool after its declared timeout elapsed."

type SettledToolRef = {
  sessionID: string
  messageID: string
  partID: string
}

const isSessionIdle = (state: State, sessionID: string): boolean => {
  const status = state.session_status[sessionID]
  if (status) return status.type === "idle"
  // OpenCode's status snapshot omits idle sessions, so absence means idle —
  // but only once that snapshot has actually landed. Before it does (attach,
  // reconnect, cold start, failed status fetch) absence means *unknown*, and
  // settling on it would kill a tool that is genuinely still running.
  return state.sessionStatusLoaded === true
}

const readToolStatus = (part: Part): string | undefined => {
  if (part.type !== "tool") return undefined
  const status = (part.state as { status?: unknown } | undefined)?.status
  return typeof status === "string" ? status : undefined
}

const readToolStartMs = (part: Part): number | undefined => {
  if (part.type !== "tool") return undefined
  const start = (part.state as { time?: { start?: unknown } } | undefined)?.time?.start
  return typeof start === "number" ? start : undefined
}

const readToolEndMs = (part: Part): number | undefined => {
  if (part.type !== "tool") return undefined
  const end = (part.state as { time?: { end?: unknown } } | undefined)?.time?.end
  return typeof end === "number" ? end : undefined
}

const readDeclaredTimeoutMs = (part: Part): number | undefined => {
  if (part.type !== "tool") return undefined
  const input = (part.state as { input?: Record<string, unknown> } | undefined)?.input
  if (!input || typeof input !== "object") return undefined
  const raw = input.timeout ?? input.timeoutMs ?? input.timeout_ms
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

const readTaskChildSessionId = (part: Part): string | undefined => {
  if (part.type !== "tool" || part.tool?.trim().toLowerCase() !== "task") return undefined
  const metadata = (part.state as { metadata?: unknown } | undefined)?.metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const record = metadata as { sessionId?: unknown; sessionID?: unknown; session_id?: unknown }
  const value = typeof record.sessionId === "string"
    ? record.sessionId
    : typeof record.sessionID === "string"
      ? record.sessionID
      : record.session_id
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const hasPendingPermission = (state: State, sessionID: string): boolean => (
  (state.permission[sessionID] ?? []).length > 0
)

const shouldSettleToolPart = (
  state: State,
  part: Part,
  now: number,
): { settle: boolean; reason: "idle" | "timeout" } | null => {
  const status = readToolStatus(part)
  if (!status || FINAL_TOOL_STATUSES.has(status)) return null
  if (status !== "running" && status !== "pending") return null
  if (typeof readToolEndMs(part) === "number") return null

  const sessionID = typeof part.sessionID === "string" ? part.sessionID : ""
  if (!sessionID) return null

  // Pending bash/permission waits are intentional while a permission card is open.
  if (status === "pending" && hasPendingPermission(state, sessionID)) return null

  if (isSessionIdle(state, sessionID)) return { settle: true, reason: "idle" }

  const childSessionID = readTaskChildSessionId(part)
  if (childSessionID && isSessionIdle(state, childSessionID)) {
    return { settle: true, reason: "idle" }
  }

  const startMs = readToolStartMs(part)
  const declaredTimeoutMs = readDeclaredTimeoutMs(part)
  if (
    typeof startMs === "number"
    && typeof declaredTimeoutMs === "number"
    && now - startMs >= declaredTimeoutMs + DECLARED_TIMEOUT_SETTLE_GRACE_MS
  ) {
    return { settle: true, reason: "timeout" }
  }

  return null
}

const settleToolPart = (part: Part, now: number, reason: "idle" | "timeout"): Part => {
  if (part.type !== "tool") return part
  const previousState = part.state as {
    input?: Record<string, unknown>
    error?: unknown
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
  const start = typeof previousState.time?.start === "number" ? previousState.time.start : now
  const error = typeof previousState.error === "string" && previousState.error.trim().length > 0
    ? previousState.error
    : reason === "timeout"
      ? STALE_TOOL_TIMEOUT_ERROR
      : STALE_TOOL_IDLE_ERROR

  return {
    ...part,
    state: {
      status: "error",
      input: previousState.input ?? {},
      error,
      ...(previousState.metadata ? { metadata: previousState.metadata } : {}),
      time: {
        start,
        end: now,
      },
    },
  }
}

/**
 * Finalize orphan running/pending tool parts after idle (or linked task-child
 * idle), and after a declared tool timeout + grace while still busy.
 * Does not invent session.idle and does not wall-clock-kill tools that omit
 * timeout — those may legitimately run for a long time (up to an hour).
 */
export function applyStaleToolPartSettlements(
  store: StoreApi<DirectoryStore>,
  now = Date.now(),
): number {
  const state = store.getState()
  let nextPart: State["part"] | undefined
  const settled: SettledToolRef[] = []

  for (const [messageID, parts] of Object.entries(state.part)) {
    if (!parts?.length) continue
    let nextParts: Part[] | undefined

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (!part) {
        if (nextParts) nextParts.push(part)
        continue
      }

      const decision = shouldSettleToolPart(state, part, now)
      if (!decision?.settle) {
        if (nextParts) nextParts.push(part)
        continue
      }

      const settledPart = settleToolPart(part, now, decision.reason)
      if (!nextParts) nextParts = parts.slice(0, index)
      nextParts.push(settledPart)
      settled.push({
        sessionID: typeof part.sessionID === "string" ? part.sessionID : "",
        messageID,
        partID: part.id,
      })
    }

    if (!nextParts) continue
    if (!nextPart) nextPart = { ...state.part }
    nextPart[messageID] = nextParts
  }

  if (!nextPart || settled.length === 0) return 0

  for (const entry of settled) {
    if (entry.sessionID && entry.messageID) {
      markDirectorySessionPartChanged(store, entry.sessionID, entry.messageID)
    }
  }

  store.setState({ part: nextPart })
  return settled.length
}
