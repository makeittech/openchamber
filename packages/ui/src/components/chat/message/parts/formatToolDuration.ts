/**
 * Format a live or completed tool duration for the chat tool header.
 * Unbounded — long shell tasks (5m–1h+) must keep counting so the UI does not
 * look frozen at a 5-minute cap.
 */
export function formatToolDurationMs(durationMs: number): string {
  const ms = Math.max(0, durationMs)
  const totalSeconds = ms / 1000

  if (totalSeconds < 60) {
    const displaySeconds = totalSeconds < 0.05 ? 0.1 : totalSeconds
    return `${displaySeconds.toFixed(1)}s`
  }

  const wholeSeconds = Math.floor(totalSeconds)
  if (wholeSeconds < 3600) {
    const minutes = Math.floor(wholeSeconds / 60)
    const seconds = wholeSeconds % 60
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }

  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}
