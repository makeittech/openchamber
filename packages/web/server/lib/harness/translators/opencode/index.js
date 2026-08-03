/**
 * OpenCode harness translator is intentionally a no-op identity stub.
 * OpenCode prompt/abort continue to use the official SDK path from the UI
 * (`opencodeClient`); this module exists only for registry symmetry.
 */

export function createOpenCodeTranslator() {
  return {
    async prompt() {
      const error = new Error('OpenCode prompts use the OpenCode SDK path, not /api/harness/prompt');
      error.code = 'OPENCODE_SDK_PATH';
      error.statusCode = 400;
      throw error;
    },
    async abort() {
      const error = new Error('OpenCode abort uses the OpenCode SDK path, not /api/harness/abort');
      error.code = 'OPENCODE_SDK_PATH';
      error.statusCode = 400;
      throw error;
    },
  };
}
