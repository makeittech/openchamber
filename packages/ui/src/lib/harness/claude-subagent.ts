/** Synthetic Claude harness child sessions created for Agent/Task tool calls. */
const CLAUDE_SUBAGENT_SESSION_PREFIX = 'ses_claude_sub_';

export function isClaudeSubagentSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(CLAUDE_SUBAGENT_SESSION_PREFIX);
}
