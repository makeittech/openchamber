export const HARNESS_IDS = Object.freeze(['opencode', 'claude-code']);

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

const fullCapabilities = () => Object.freeze(Object.fromEntries(
  HARNESS_CAPABILITIES.map((capability) => [capability, 'full']),
));
const OPENCODE_CAPABILITIES = fullCapabilities();
const CLAUDE_CODE_CAPABILITIES = fullCapabilities();

const CLAUDE_MODEL_LIMIT_1M = Object.freeze({ context: 1_000_000, output: 128_000 });
const CLAUDE_MODEL_LIMIT_200K = Object.freeze({ context: 200_000, output: 64_000 });
const CLAUDE_MODEL_MODALITIES = Object.freeze({
  input: Object.freeze(['text', 'image']),
  output: Object.freeze(['text']),
});

function buildClaudeModel(entry) {
  const model = {
    id: entry.id,
    name: entry.name,
    supportsImages: true,
    supportsDocuments: true,
    reasoning: true,
    toolCall: true,
    limit: entry.limit,
    modalities: CLAUDE_MODEL_MODALITIES,
  };
  if (entry.resolvedId) model.resolvedId = entry.resolvedId;
  return Object.freeze(model);
}

const CLAUDE_CODE_ALIAS_MODELS = Object.freeze([
  buildClaudeModel({ id: 'fable', name: 'Fable 5', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'opus', name: 'Opus 5', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'sonnet', name: 'Sonnet 5', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({
    id: 'haiku',
    name: 'Haiku 4.5',
    resolvedId: 'claude-haiku-4-5',
    limit: CLAUDE_MODEL_LIMIT_200K,
  }),
]);

const CLAUDE_CODE_PINNED_MODELS = Object.freeze([
  buildClaudeModel({ id: 'claude-opus-4-8', name: 'Opus 4.8', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'claude-haiku-4-5', name: 'Haiku 4.5', limit: CLAUDE_MODEL_LIMIT_200K }),
]);

function buildClaudeCodeModels() {
  const aliasResolvedIds = new Set(
    CLAUDE_CODE_ALIAS_MODELS
      .map((model) => model.resolvedId)
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const aliasNames = new Set(CLAUDE_CODE_ALIAS_MODELS.map((model) => model.name));
  const visiblePins = CLAUDE_CODE_PINNED_MODELS.filter((model) => (
    !aliasResolvedIds.has(model.id) && !aliasNames.has(model.name)
  ));

  return Object.freeze([
    ...CLAUDE_CODE_ALIAS_MODELS,
    ...visiblePins,
  ]);
}

export const CLAUDE_CODE_MODELS = buildClaudeCodeModels();

const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export function isClaudeEffort(value) {
  return typeof value === 'string' && CLAUDE_EFFORT_LEVELS.includes(value);
}

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
});

export function isKnownHarnessId(harnessId) {
  return Object.prototype.hasOwnProperty.call(DESCRIPTORS, harnessId);
}

export function getHarnessDescriptor(harnessId) {
  if (!isKnownHarnessId(harnessId)) return null;
  return DESCRIPTORS[harnessId];
}

export function listHarnessDescriptors() {
  return HARNESS_IDS.map((id) => DESCRIPTORS[id]);
}

export function getHarnessCapabilities(harnessId) {
  const descriptor = getHarnessDescriptor(harnessId);
  return descriptor ? descriptor.capabilities : null;
}
