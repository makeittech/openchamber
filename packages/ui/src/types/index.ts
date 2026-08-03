export type {
  QuotaProviderId,
  UsageWindow,
  UsageWindows,
  ProviderResult
} from './quota';

export type {
  HarnessId,
  ExecutionTarget,
  ClaudePermissionMode,
  ClaudeEffort,
  CapabilityLevel,
  HarnessCapability,
  HarnessRuntimeStatus,
  HarnessAuthMode,
  HarnessDescriptor,
  HarnessCatalog,
  HarnessCatalogModel,
  HarnessCatalogSection,
} from './harness';

export {
  HARNESS_IDS,
  HARNESS_CAPABILITIES,
  CLAUDE_EFFORT_LEVELS,
  isHarnessId,
  isHarnessRuntimeStatus,
  isCapabilityLevel,
  isClaudePermissionMode,
  isClaudeEffort,
  isExecutionTarget,
} from './harness';

export interface ModelMetadata {
  id: string;
  providerId: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  /**
   * Whether the model can be constrained to a JSON schema. Tri-state on
   * purpose: `undefined` means the catalog does not say — common for
   * aggregators and proxies — and must be treated as "worth trying", never as
   * unsupported.
   */
  structured_output?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
}
