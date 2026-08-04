# Terminal Module Documentation

## Purpose
This module provides WebSocket transport utilities for terminal input and output in the web server runtime, including message normalization, control frame parsing, rate limiting, pathname resolution, and short-lived output replay buffering for terminal WebSocket connections.

## Entrypoints and structure
- `packages/web/server/lib/terminal/`: Terminal module directory.
  - `index.js`: Stable module entrypoint that re-exports protocol helpers and replay-buffer helpers.
  - `runtime.js`: Runtime module that owns terminal session state, WS server setup, and `/api/terminal/*` route registration.
  - `terminal-ws-protocol.js`: Single-file module containing terminal WebSocket protocol utilities.
  - `output-replay-buffer.js`: Helper module for buffering recent terminal output so late subscribers can receive startup prompt data.
- `packages/web/server/lib/terminal/terminal-ws-protocol.test.js`: Test file for protocol utilities.
- `packages/web/server/lib/terminal/output-replay-buffer.test.js`: Test file for replay buffer helpers.

Public API entry point: imported by `packages/web/server/index.js` from `./lib/terminal/index.js`.

## Public exports

### Constants
- `TERMINAL_WS_PATH`: Primary WebSocket endpoint path (`/api/terminal/ws`).
- `TERMINAL_WS_CONTROL_TAG_JSON`: Control frame tag byte (`0x01`) indicating JSON payload.
- `TERMINAL_WS_MAX_PAYLOAD_BYTES`: Maximum inbound WebSocket payload size (64KB).
- `TERMINAL_OUTPUT_REPLAY_MAX_BYTES`: Maximum buffered terminal output retained for replay (64KB).

### Request Parsing
- `parseRequestPathname(requestUrl)`: Extracts pathname from request URL string. Returns empty string for invalid inputs.
- `isTerminalWsPathname(pathname)`: Returns whether a pathname matches a supported terminal WebSocket route.

### Message Normalization
- `normalizeTerminalWsMessageToBuffer(rawData)`: Normalizes various data types (Buffer, Uint8Array, ArrayBuffer, string, chunk arrays) to a single Buffer.
- `normalizeTerminalWsMessageToText(rawData)`: Normalizes data to UTF-8 text string.

### Control Frame Handling
- `readTerminalWsControlFrame(rawData)`: Parses WebSocket message as control frame. Returns parsed JSON object or null if invalid or malformed.
- `createTerminalWsControlFrame(payload)`: Creates a control frame with JSON payload and prepends the control tag byte.

### Runtime behavior
- IDs are client-provided or generated with `randomUUID()`.
- Concurrent creates for one ID are single-flight only when working directory and shell preference match. Existing IDs cannot be reused for another working directory.
- Dimensions are bounded to 1-1000 columns and 1-500 rows; input is capped at 64 KiB.
- A client may create before its renderer has mounted. It derives an initial size from the container and font metrics (falling back to 80x24 when unavailable), then sends a resize once Ghostty reports its final dimensions. This allows shell startup and renderer initialization to overlap.
- PTY children explicitly clear `NODE_CHANNEL_FD`; daemon IPC descriptors are host-private and invalid after PTY descriptor cleanup.
- PTY children also strip AppImage `ARGV0` (and other host-private shell vars such as `ELECTRON_RUN_AS_NODE`, `BASH_ENV`, `ENV`, `BASH_XTRACEFD`). An exported `ARGV0` makes zsh rewrite argv[0] for every external command, which breaks Python venv detection and other argv[0]/$0 consumers while leaving `/proc/self/exe` correct. On Linux, PTY spawn is wrapped with `env -u ARGV0` because `bun-pty` merges the native OS environ and would otherwise reintroduce `ARGV0` after a JS-only delete.
- `GET /api/terminal/shells` reports shell IDs available on the active server using the same augmented PATH provided to spawned PTYs, plus whether each executable has a supported login-mode argument. `auto` preserves environment/platform fallback order; an explicit unavailable shell fails creation instead of silently running a different shell. Login mode is opt-in and uses only built-in arguments for known shells. Preference changes affect new sessions and explicit restarts, not running PTYs.
- PTY data and exit callbacks enter one FIFO queue. Stale callbacks from replaced processes are ignored.
- Scrollback is retained on the server and capped at 512 KiB with UTF-8-safe trimming. Device-status, device-attribute, cursor-position reply, and color-query exchanges are removed from replay history with incomplete control sequences carried across PTY chunks; live output remains byte-for-byte unchanged.
- Exited sessions remain attachable until explicit close or idle cleanup.
- Restarts are serialized per terminal. Each restart spawns and wires the replacement before terminating the old process, retaining the terminal ID.
- Close uses SIGTERM with bounded SIGKILL escalation. Force-kill, idle cleanup, and runtime shutdown terminate process groups immediately where supported. Removal explicitly sends a fatal scoped closure and evicts client projections even when a PTY backend fails to emit `onExit`; attached terminals are not considered idle.

### Replay Buffer Helpers
- `createTerminalOutputReplayBuffer()`: Creates mutable state for recent terminal output replay.
- `appendTerminalOutputReplayChunk(bufferState, data, maxBytes?)`: Appends a chunk, trimming older buffered data to stay within the configured byte budget.
- `listTerminalOutputReplayChunksSince(bufferState, lastSeenId)`: Returns buffered chunks newer than the provided replay cursor.
- `getLatestTerminalOutputReplayChunkId(bufferState)`: Returns the latest chunk id in the replay buffer, or `0` when empty.

### Rate Limiting
- `pruneRebindTimestamps(timestamps, now, windowMs)`: Filters timestamps to keep only those within the active time window.
- `isRebindRateLimited(timestamps, maxPerWindow)`: Checks if rebind operations have exceeded the configured threshold.

## Usage in web server
The terminal helpers are used by `packages/web/server/index.js` for:
- WebSocket endpoint path definition and matching
- Message normalization for terminal input payloads
- Control frame parsing for session binding, keepalive, and exit signaling
- Rate limiting for session rebind operations
- Request pathname parsing for WebSocket routing
- Replaying startup output such as shell prompts when the client binds after the PTY already emitted data

The web server combines these utilities with `bun-pty` or `node-pty` to drive full-duplex PTY sessions.

## Notes for contributors
- Keep control frames backward-compatible when possible; use explicit `v` values for protocol changes.
- Always normalize incoming WebSocket messages before processing them.
- Keep replay buffering small and memory-only; it exists to cover startup races, not to implement persistent scrollback.
- Add tests for new control frame types, websocket path changes, malformed payload handling, and replay trimming semantics.
- Keep HTTP input and SSE output fallbacks functional unless the rollout explicitly removes them.

## Verification notes
### Manual verification
1. Start the web server and create a terminal session via `/api/terminal/create`.
2. Wait briefly before binding the client to ensure the shell emits its prompt first.
3. Connect to `/api/terminal/ws` WebSocket and bind to the session.
4. Verify the startup prompt and early shell output are replayed before interactive input begins.
5. Verify `/api/terminal/input-ws` is rejected with `404 Not Found` and `/api/terminal/:sessionId/stream` still works as a fallback path.

### Automated verification
- Run `bun test packages/web/server/lib/terminal/terminal-ws-protocol.test.js`
- Run `bun test packages/web/server/lib/terminal/output-replay-buffer.test.js`
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
