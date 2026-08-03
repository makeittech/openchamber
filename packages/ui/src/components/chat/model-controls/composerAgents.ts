/**
 * Which agent set the composer picker offers, and how the selection is labelled.
 *
 * A Claude Code session whose "Agents to use" setting is `claude` picks from
 * Claude's own agents (`.claude/agents` + built-ins); every other session picks
 * from OpenCode primary agents. Both render from the same narrow shape, so the
 * branch lives here as pure functions rather than inline in `ModelControls`.
 */

import type { Agent } from '@opencode-ai/sdk/v2';
import type { ClaudeAgent } from '@/lib/harness/client';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';

/** The only fields the agent picker renders. */
export type ComposerAgentOption = {
  name: string;
  description?: string;
};

/**
 * Agents the picker lists.
 *
 * OpenCode agents are filtered to primary mode (subagents are spawned by the
 * model, not chosen in the composer). Claude's list arrives already filtered by
 * the discovery route.
 */
export function resolveComposerAgents(params: {
  claudeNativeAgentsActive: boolean;
  claudeAgents: readonly ClaudeAgent[];
  openCodeAgents: readonly Agent[];
}): ComposerAgentOption[] {
  if (params.claudeNativeAgentsActive) {
    return params.claudeAgents.map((agent) => ({
      name: agent.name,
      description: agent.description || undefined,
    }));
  }
  return params.openCodeAgents
    .filter((agent) => isPrimaryMode(agent.mode))
    .map((agent) => ({
      name: agent.name,
      description: agent.description || undefined,
    }));
}

/**
 * Name the "Reset to default" row selects.
 *
 * Claude's default main-thread agent has no name — resetting clears the
 * selection so the SDK runs its own default, which is why this returns
 * `undefined` in that mode rather than picking a list entry.
 */
export function resolveComposerDefaultAgentName(params: {
  claudeNativeAgentsActive: boolean;
  agents: readonly ComposerAgentOption[];
  settingsDefaultAgent?: string | null;
}): string | undefined {
  if (params.claudeNativeAgentsActive) return undefined;

  const configured = params.settingsDefaultAgent?.trim();
  if (configured) {
    const found = params.agents.find((agent) => agent.name === configured);
    if (found) return found.name;
  }
  const build = params.agents.find((agent) => agent.name === 'build');
  if (build) return build.name;
  return params.agents[0]?.name;
}

/**
 * Name shown on the composer agent chip and marked selected in the list.
 *
 * In Claude mode an empty selection is meaningful (Claude's own default), so it
 * is returned as-is; the caller renders the localized default label for it.
 */
export function resolveActiveComposerAgentName(params: {
  claudeNativeAgentsActive: boolean;
  claudeSelectedAgentName: string;
  openCodeAgentName?: string | null;
}): string {
  if (params.claudeNativeAgentsActive) {
    return params.claudeSelectedAgentName;
  }
  return params.openCodeAgentName ?? '';
}

/**
 * OpenCode agent name the send / queue paths must forward.
 *
 * The composer chip prefers the per-session selection over the directory-scoped
 * `currentAgentName`. Send and queue used to read only `currentAgentName`, so a
 * directory reload (or any other global reset to `build`) could keep the chip on
 * e.g. `perm-smoke` while Claude harness turns still inherited `build` —
 * wrong prompt append, wrong `permissionMode`, and OpenCode permission rules
 * that never matched what the user selected.
 */
export function resolveComposerSendAgentName(params: {
  sessionAgentName?: string | null;
  currentAgentName?: string | null;
}): string | undefined {
  const session = params.sessionAgentName?.trim();
  if (session) return session;
  const current = params.currentAgentName?.trim();
  return current || undefined;
}

/**
 * Filter + order the picker list for a search query.
 *
 * Sorting is applied before filtering so the visible order does not shuffle as
 * the user types.
 */
export function filterComposerAgents(
  agents: readonly ComposerAgentOption[],
  query: string,
  matches: (value: string, query: string) => boolean,
): ComposerAgentOption[] {
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const trimmed = query.trim();
  if (!trimmed) return sorted;
  return sorted.filter((agent) => (
    matches(agent.name, trimmed)
    || (agent.description ? matches(agent.description, trimmed) : false)
  ));
}
