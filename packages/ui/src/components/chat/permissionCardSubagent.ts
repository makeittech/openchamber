import type { PermissionRequest } from '@/types/permission';

type SessionLike = { id: string; parentID?: string | null };

/**
 * Whether a permission ask originates from a subagent of the current session.
 *
 * Two sources are authoritative:
 * - the ask's own metadata (`fromSubagent: true`), used by harness bridges
 *   that stamp synthetic child session ids (`ses_claude_sub_*`) which may not
 *   be linked in the visible session list the same way;
 * - a session record whose `parentID` is the current session (OpenCode task
 *   sessions).
 */
export function isPermissionFromSubagent(
  permission: PermissionRequest,
  currentSessionId?: string | null,
  sessions: SessionLike[] = [],
): boolean {
  if (permission.metadata.fromSubagent === true) return true;
  if (!currentSessionId || permission.sessionID === currentSessionId) return false;
  const sourceSession = sessions.find((session) => session.id === permission.sessionID);
  return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
}
