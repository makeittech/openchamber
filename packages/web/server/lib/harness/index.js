/**
 * Harness (engines) public exports.
 */

export {
  HARNESS_IDS,
  HARNESS_CAPABILITIES,
  CLAUDE_CODE_MODELS,
  CURSOR_FALLBACK_MODEL_IDS,
  isKnownHarnessId,
  getHarnessDescriptor,
  listHarnessDescriptors,
  getHarnessCapabilities,
} from './registry.js';

export {
  findBinaryOnPath,
  probeClaudeLogin,
  detectClaudeCode,
  detectCursor,
  detectOpenCode,
  detectHarness,
  detectAllHarnesses,
} from './detect.js';

export {
  getSessionBinding,
  bindSession,
  updateSessionBinding,
  setForeignSessionId,
  setBindingError,
  clearSessionBinding,
  resetSessionBindings,
  listSessionBindings,
  configureSessionBindings,
  initSessionBindings,
  flushSessionBindings,
  sanitizeSessionBinding,
  resolveSessionBindingsPath,
} from './session-bindings.js';

export {
  createCanUseTool,
  replyPermission,
  rejectPendingForSession,
  resetPendingPermissions,
  getPendingPermissionCount,
  DEFAULT_PERMISSION_TIMEOUT_MS,
} from './translators/claude-code/permissions.js';

export { createHarnessRouter } from './router.js';
export { registerHarnessRoutes } from './routes.js';
export { createClaudeCodeTranslator, buildClaudePrompt } from './translators/claude-code/index.js';
export { createCursorTranslator } from './translators/cursor/index.js';
export {
  generateCursorAuthParams,
  pollCursorAuth,
  pollCursorAuthOnce,
  refreshCursorToken,
  getTokenExpiry,
  looksLikeJwt,
  RefreshTokenInvalidError,
} from './translators/cursor/auth.js';
export {
  hasCursorCredentials,
  resolveCursorAccessToken,
  persistCursorCredentials,
} from './translators/cursor/credentials.js';
export { startLogin as startCursorLogin, pollLogin as pollCursorLogin } from './translators/cursor/login.js';
export { FALLBACK_MODELS as CURSOR_FALLBACK_MODELS } from './translators/cursor/models.js';
export { buildClaudeCodeChildEnv, API_PRIORITY_ENV_KEYS } from './translators/claude-code/auth-env.js';
export {
  mapAttachmentToContentBlock,
  mapAttachmentsToContentBlocks,
  isSupportedAttachmentMime,
} from './translators/claude-code/attachments.js';
export {
  loadClaudeAgentSdk,
  probeClaudeAgentSdk,
  startClaudeQuery,
  killProcessTree,
  resetClaudeAgentSdkCache,
} from './translators/claude-code/query.js';
export {
  mapClaudeMessageToEvents,
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
} from './events/from-claude.js';
export {
  mapCursorEventToEvents,
  buildCursorUserMessageEvents,
  createCursorMapperContext,
} from './events/from-cursor.js';
export { emitHarnessEvent, emitHarnessEvents } from './events/emit.js';
