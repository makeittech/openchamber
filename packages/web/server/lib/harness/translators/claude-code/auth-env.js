/**
 * Subscription-only child env policy for Claude Code engine.
 * Never log env values — this module only returns sanitized copies.
 */

/** Vars that prefer API billing over Claude Code OAuth/subscription login. */
export const API_PRIORITY_ENV_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

/**
 * Build a child-process env for Claude Code subscription mode.
 * Starts from process.env (or provided base), spreads so PATH is preserved,
 * then deletes API-priority credentials.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [baseEnv]
 * @returns {Record<string, string | undefined>}
 */
export function buildClaudeCodeChildEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of API_PRIORITY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}
