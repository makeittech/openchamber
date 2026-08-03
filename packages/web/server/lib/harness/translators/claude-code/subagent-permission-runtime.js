/**
 * Correlate Claude subagent runtime ids with OpenCode agent permission policy
 * and synthetic child session ids so PermissionCards can show "From subagent"
 * and enforce the spawned agent's ruleset (OpenCode parity).
 *
 * Lifecycle for one turn:
 * 1. Agent/Task tool_use (stream or canUseTool) → noteAgentTool(toolUseId, type)
 * 2. SubagentStart hook → bindAgentId(agentId, agentType)
 * 3. Nested canUseTool({ agentID }) → resolve(agentID)
 */

/**
 * @typedef {object} SubagentBinding
 * @property {string} toolUseId
 * @property {string} agentType
 * @property {string} childSessionId
 * @property {string} [agentId]
 */

/**
 * @param {object} params
 * @param {string} params.parentSessionId
 * @param {(toolUseId: string) => string} params.childSessionIdFor
 * @param {Record<string, (toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask'>} [params.policiesByAgentType]
 * @returns {{
 *   noteAgentTool: (toolUseId: string, agentType?: string) => void,
 *   bindAgentId: (agentId: string, agentType?: string) => void,
 *   resolve: (agentId: string) => null | {
 *     agentType: string,
 *     childSessionId: string,
 *     toolUseId: string,
 *     resolveToolPolicy: ((toolName: string, input?: Record<string, unknown>) => 'allow' | 'deny' | 'ask') | null,
 *   },
 *   parentSessionId: string,
 * }}
 */
export function createSubagentPermissionRuntime(params) {
  const parentSessionId = typeof params?.parentSessionId === 'string' ? params.parentSessionId : '';
  const childSessionIdFor = typeof params?.childSessionIdFor === 'function'
    ? params.childSessionIdFor
    : null;
  const policiesByAgentType = params?.policiesByAgentType && typeof params.policiesByAgentType === 'object'
    ? params.policiesByAgentType
    : {};

  /** @type {Map<string, SubagentBinding>} toolUseId → binding */
  const byToolUseId = new Map();
  /** @type {Map<string, string>} agentId → toolUseId */
  const toolUseIdByAgentId = new Map();
  /** Unbound Agent tools waiting for SubagentStart, newest last. */
  /** @type {string[]} */
  const unboundToolUseIds = [];

  /**
   * @param {string} toolUseId
   * @param {string} [agentType]
   */
  function noteAgentTool(toolUseId, agentType) {
    const id = typeof toolUseId === 'string' ? toolUseId.trim() : '';
    if (!id || !childSessionIdFor) return;
    const type = typeof agentType === 'string' ? agentType.trim() : '';
    const existing = byToolUseId.get(id);
    if (existing) {
      if (type && !existing.agentType) existing.agentType = type;
      return;
    }
    byToolUseId.set(id, {
      toolUseId: id,
      agentType: type,
      childSessionId: childSessionIdFor(id),
    });
    unboundToolUseIds.push(id);
  }

  /**
   * @param {string} agentId
   * @param {string} [agentType]
   */
  function bindAgentId(agentId, agentType) {
    const id = typeof agentId === 'string' ? agentId.trim() : '';
    if (!id) return;
    if (toolUseIdByAgentId.has(id)) return;

    const type = typeof agentType === 'string' ? agentType.trim() : '';

    // Prefer an unbound Agent tool whose subagent_type matches.
    let toolUseId = '';
    if (type) {
      const matchIndex = unboundToolUseIds.findIndex((candidate) => {
        const binding = byToolUseId.get(candidate);
        return binding && !binding.agentId && binding.agentType.toLowerCase() === type.toLowerCase();
      });
      if (matchIndex >= 0) {
        toolUseId = unboundToolUseIds.splice(matchIndex, 1)[0];
      }
    }
    // Otherwise take the most recently noted unbound Agent tool.
    if (!toolUseId && unboundToolUseIds.length > 0) {
      toolUseId = unboundToolUseIds.pop() || '';
    }
    if (!toolUseId) {
      // SubagentStart arrived before tool_use was noted — synthesize a binding
      // keyed by agentId so policy still applies (child session id may differ
      // from the stream mapper until noteAgentTool correlates later).
      if (!childSessionIdFor) return;
      const syntheticToolUseId = `agentid_${id}`;
      byToolUseId.set(syntheticToolUseId, {
        toolUseId: syntheticToolUseId,
        agentType: type,
        childSessionId: childSessionIdFor(syntheticToolUseId),
        agentId: id,
      });
      toolUseIdByAgentId.set(id, syntheticToolUseId);
      return;
    }

    const binding = byToolUseId.get(toolUseId);
    if (!binding) return;
    binding.agentId = id;
    if (type && !binding.agentType) binding.agentType = type;
    toolUseIdByAgentId.set(id, toolUseId);
  }

  /**
   * @param {string} agentId
   */
  function resolve(agentId) {
    const id = typeof agentId === 'string' ? agentId.trim() : '';
    if (!id) return null;
    const toolUseId = toolUseIdByAgentId.get(id);
    if (!toolUseId) return null;
    const binding = byToolUseId.get(toolUseId);
    if (!binding) return null;
    const agentType = binding.agentType || '';
    const policyKey = agentType.toLowerCase();
    const resolveToolPolicy = policyKey && typeof policiesByAgentType[policyKey] === 'function'
      ? policiesByAgentType[policyKey]
      : (typeof policiesByAgentType[agentType] === 'function' ? policiesByAgentType[agentType] : null);
    return {
      agentType,
      childSessionId: binding.childSessionId,
      toolUseId: binding.toolUseId,
      resolveToolPolicy,
    };
  }

  return {
    noteAgentTool,
    bindAgentId,
    resolve,
    parentSessionId,
  };
}
