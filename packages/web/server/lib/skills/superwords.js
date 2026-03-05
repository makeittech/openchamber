/**
 * Superwords parser and skill injection module.
 * Superwords are trigger phrases that enable skills when they appear at the start of a message.
 */

/**
 * Parse a message for superword triggers.
 * Only matches triggers at the START of the message (after optional whitespace).
 * 
 * @param {string} message - The user message to parse
 * @param {Object} config - SuperwordsConfig mapping triggers to skill IDs
 * @returns {{ trigger: string, skillId: string, remainingMessage: string } | null}
 */
export function parseSuperwords(message, config) {
  if (typeof message !== 'string' || !message.trim()) {
    return null;
  }

  if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
    return null;
  }

  const trimmedMessage = message.trim();
  
  // Sort triggers by length (longest first) to match longer triggers first
  // e.g., "/plan-mode" should match before "/plan"
  const sortedTriggers = Object.keys(config).sort((a, b) => b.length - a.length);

  for (const trigger of sortedTriggers) {
    if (typeof trigger !== 'string' || !trigger.trim()) {
      continue;
    }

    const normalizedTrigger = trigger.trim();
    
    // Check if message starts with this trigger
    if (trimmedMessage.startsWith(normalizedTrigger)) {
      // Ensure the trigger is followed by whitespace or end of message
      // This prevents "/plan" from matching "/planning"
      const afterTrigger = trimmedMessage.slice(normalizedTrigger.length);
      const isValidBoundary = afterTrigger.length === 0 || /^\s/.test(afterTrigger);
      
      if (isValidBoundary) {
        const skillId = config[trigger];
        if (typeof skillId === 'string' && skillId.trim()) {
          const remainingMessage = afterTrigger.trim();
          return {
            trigger: normalizedTrigger,
            skillId: skillId.trim(),
            remainingMessage,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Get the skill ID for a specific superword trigger.
 * 
 * @param {string} trigger - The trigger to look up
 * @param {Object} config - SuperwordsConfig mapping
 * @returns {string | null} The skill ID or null if not found
 */
export function getSkillForSuperword(trigger, config) {
  if (typeof trigger !== 'string' || !trigger.trim()) {
    return null;
  }

  if (!config || typeof config !== 'object') {
    return null;
  }

  const normalizedTrigger = trigger.trim();
  const skillId = config[normalizedTrigger];
  
  if (typeof skillId === 'string' && skillId.trim()) {
    return skillId.trim();
  }

  return null;
}

/**
 * Inject skill context into a request body.
 * Modifies the request body to include skill activation information.
 * 
 * @param {Object} requestBody - The request body to modify
 * @param {string} skillId - The skill ID to inject
 * @param {string} [remainingMessage] - Optional remaining message after trigger
 * @returns {Object} The modified request body
 */
export function injectSuperwordSkill(requestBody, skillId, remainingMessage) {
  if (!requestBody || typeof requestBody !== 'object') {
    return requestBody;
  }

  if (typeof skillId !== 'string' || !skillId.trim()) {
    return requestBody;
  }

  // Create a shallow copy to avoid mutating the original
  const modified = { ...requestBody };

  // Add skill activation context
  modified._superword = {
    skillId: skillId.trim(),
    activated: true,
  };

  // If we have a remaining message (after removing the trigger), use it
  if (typeof remainingMessage === 'string') {
    modified.message = remainingMessage;
  }

  return modified;
}
