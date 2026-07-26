/**
 * Harness (engine) descriptors and capability matrix.
 * User-facing copy uses "Engine"; internal IDs use harnessId.
 */

/** @typedef {'opencode' | 'claude-code' | 'cursor'} HarnessId */
/** @typedef {'full' | 'partial' | 'none'} CapabilityLevel */
/** @typedef {'ready' | 'needs-login' | 'missing-cli' | 'unsupported-host' | 'error'} HarnessRuntimeStatus */
/** @typedef {'opencode-providers' | 'subscription-cli' | 'subscription-oauth'} HarnessAuthMode */

/** @type {readonly HarnessId[]} */
export const HARNESS_IDS = Object.freeze(['opencode', 'claude-code', 'cursor']);

/** @type {readonly string[]} */
export const HARNESS_CAPABILITIES = Object.freeze([
  'prompt',
  'abort',
  'resume',
  'streaming-text',
  'streaming-tools',
  'permissions',
  'images',
  'file-attachments',
  'shell',
  'slash-commands',
  'mcp',
  'subagents',
  'multirun',
  'goal',
  'openchamber-tool',
]);

const OPENCODE_CAPABILITIES = Object.freeze({
  prompt: 'full',
  abort: 'full',
  resume: 'full',
  'streaming-text': 'full',
  'streaming-tools': 'full',
  permissions: 'full',
  images: 'full',
  'file-attachments': 'full',
  shell: 'full',
  'slash-commands': 'full',
  mcp: 'full',
  subagents: 'full',
  multirun: 'full',
  goal: 'full',
  'openchamber-tool': 'full',
});

const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  prompt: 'full',
  abort: 'full',
  resume: 'full',
  'streaming-text': 'full',
  'streaming-tools': 'full',
  permissions: 'partial',
  images: 'full',
  'file-attachments': 'partial',
  shell: 'full',
  'slash-commands': 'partial',
  mcp: 'partial',
  subagents: 'partial',
  multirun: 'none',
  goal: 'none',
  'openchamber-tool': 'none',
});

const CURSOR_CAPABILITIES = Object.freeze({
  prompt: 'full',
  abort: 'full',
  resume: 'partial',
  'streaming-text': 'full',
  'streaming-tools': 'full',
  permissions: 'none',
  images: 'none',
  'file-attachments': 'none',
  shell: 'full',
  'slash-commands': 'none',
  mcp: 'partial',
  subagents: 'none',
  multirun: 'none',
  goal: 'none',
  'openchamber-tool': 'none',
});

/** Static Claude Code model catalog for v1 (no provider nesting). */
export const CLAUDE_CODE_MODELS = Object.freeze([
  { id: 'sonnet', name: 'Sonnet', supportsImages: true, supportsDocuments: true },
  { id: 'opus', name: 'Opus', supportsImages: true, supportsDocuments: true },
  { id: 'haiku', name: 'Haiku', supportsImages: true, supportsDocuments: true },
]);

/** Static Cursor fallback catalog ids (full list lives in translators/cursor/models.js). */
export const CURSOR_FALLBACK_MODEL_IDS = Object.freeze([
  'composer-1.5',
  'claude-4.6-sonnet-medium',
  'gpt-5.2',
]);

const DESCRIPTORS = Object.freeze({
  opencode: Object.freeze({
    id: 'opencode',
    displayName: 'OpenCode',
    shortName: 'OpenCode',
    auth: Object.freeze({ mode: 'opencode-providers' }),
    capabilities: OPENCODE_CAPABILITIES,
    install: Object.freeze({
      binaryNames: Object.freeze([]),
      docsUrl: 'https://opencode.ai/docs',
    }),
  }),
  'claude-code': Object.freeze({
    id: 'claude-code',
    displayName: 'Claude Code',
    shortName: 'Claude',
    auth: Object.freeze({ mode: 'subscription-cli' }),
    capabilities: CLAUDE_CODE_CAPABILITIES,
    install: Object.freeze({
      binaryNames: Object.freeze(['claude']),
      docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    }),
  }),
  cursor: Object.freeze({
    id: 'cursor',
    displayName: 'Cursor',
    shortName: 'Cursor',
    auth: Object.freeze({ mode: 'subscription-oauth' }),
    capabilities: CURSOR_CAPABILITIES,
    install: Object.freeze({
      binaryNames: Object.freeze([]),
      docsUrl: 'https://cursor.com/docs',
    }),
  }),
});

/**
 * @param {string} harnessId
 * @returns {boolean}
 */
export function isKnownHarnessId(harnessId) {
  return Object.prototype.hasOwnProperty.call(DESCRIPTORS, harnessId);
}

/**
 * @param {string} harnessId
 * @returns {typeof DESCRIPTORS[keyof typeof DESCRIPTORS] | null}
 */
export function getHarnessDescriptor(harnessId) {
  if (!isKnownHarnessId(harnessId)) return null;
  return DESCRIPTORS[harnessId];
}

/**
 * @returns {Array<typeof DESCRIPTORS[keyof typeof DESCRIPTORS]>}
 */
export function listHarnessDescriptors() {
  return HARNESS_IDS.map((id) => DESCRIPTORS[id]);
}

/**
 * @param {string} harnessId
 * @returns {typeof CLAUDE_CODE_CAPABILITIES | typeof OPENCODE_CAPABILITIES | null}
 */
export function getHarnessCapabilities(harnessId) {
  const descriptor = getHarnessDescriptor(harnessId);
  return descriptor ? descriptor.capabilities : null;
}
