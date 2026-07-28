import type {
  CapabilityLevel,
  HarnessCatalog,
  HarnessCatalogModel,
  HarnessCatalogSection,
  HarnessAuthMode,
  HarnessCapability,
  HarnessDescriptor,
  HarnessId,
  HarnessRuntimeStatus,
} from '@/types/harness';
import {
  HARNESS_CAPABILITIES,
  isCapabilityLevel,
  isHarnessId,
  isHarnessRuntimeStatus,
} from '@/types/harness';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseAuthMode = (value: unknown): HarnessAuthMode | null => {
  if (value === 'subscription-cli' || value === 'opencode-providers') {
    return value;
  }
  return null;
};

const parseCapabilities = (value: unknown): Record<HarnessCapability, CapabilityLevel> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const result = {} as Record<HarnessCapability, CapabilityLevel>;
  for (const capability of HARNESS_CAPABILITIES) {
    const level = value[capability];
    if (!isCapabilityLevel(level)) {
      return null;
    }
    result[capability] = level;
  }
  return result;
};

const parseDescriptor = (value: unknown): HarnessDescriptor | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (!isHarnessId(value.id)) {
    return null;
  }
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
    return null;
  }
  if (typeof value.shortName !== 'string' || value.shortName.trim().length === 0) {
    return null;
  }
  const auth = isRecord(value.auth) ? parseAuthMode(value.auth.mode) : null;
  if (!auth) {
    return null;
  }
  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities) {
    return null;
  }
  if (!isRecord(value.install)) {
    return null;
  }
  const binaryNames = Array.isArray(value.install.binaryNames)
    ? value.install.binaryNames.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  if (typeof value.install.docsUrl !== 'string' || value.install.docsUrl.trim().length === 0) {
    return null;
  }
  const minVersion = typeof value.install.minVersion === 'string' ? value.install.minVersion : undefined;

  return {
    id: value.id,
    displayName: value.displayName.trim(),
    shortName: value.shortName.trim(),
    auth: { mode: auth },
    capabilities,
    install: {
      binaryNames,
      docsUrl: value.install.docsUrl.trim(),
      ...(minVersion ? { minVersion } : {}),
    },
  };
};

const parsePositiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const parseStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return items.length > 0 ? items : undefined;
};

const parseModel = (value: unknown): HarnessCatalogModel | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    return null;
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return null;
  }

  const limitRecord = isRecord(value.limit) ? value.limit : null;
  const context = limitRecord ? parsePositiveNumber(limitRecord.context) : undefined;
  const output = limitRecord ? parsePositiveNumber(limitRecord.output) : undefined;
  const modalitiesRecord = isRecord(value.modalities) ? value.modalities : null;
  const inputModalities = modalitiesRecord ? parseStringList(modalitiesRecord.input) : undefined;
  const outputModalities = modalitiesRecord ? parseStringList(modalitiesRecord.output) : undefined;

  return {
    id: value.id.trim(),
    name: value.name.trim(),
    ...(typeof value.supportsImages === 'boolean' ? { supportsImages: value.supportsImages } : {}),
    ...(typeof value.supportsDocuments === 'boolean' ? { supportsDocuments: value.supportsDocuments } : {}),
    ...(typeof value.reasoning === 'boolean' ? { reasoning: value.reasoning } : {}),
    ...(typeof value.toolCall === 'boolean' ? { toolCall: value.toolCall } : {}),
    ...((context !== undefined || output !== undefined)
      ? { limit: { ...(context !== undefined ? { context } : {}), ...(output !== undefined ? { output } : {}) } }
      : {}),
    ...((inputModalities || outputModalities)
      ? {
        modalities: {
          ...(inputModalities ? { input: inputModalities } : {}),
          ...(outputModalities ? { output: outputModalities } : {}),
        },
      }
      : {}),
  };
};

const parseSection = (value: unknown): HarnessCatalogSection | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    return null;
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return null;
  }
  if (value.kind !== 'provider' && value.kind !== 'profile' && value.kind !== 'models') {
    return null;
  }
  if (!Array.isArray(value.models)) {
    return null;
  }
  const models = value.models
    .map((entry) => parseModel(entry))
    .filter((entry): entry is HarnessCatalogModel => Boolean(entry));
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    kind: value.kind,
    models,
  };
};

/** Parse one harness catalog object from server JSON. Returns null on malformed payload. */
export function parseHarnessCatalog(value: unknown): HarnessCatalog | null {
  if (!isRecord(value)) {
    return null;
  }
  const descriptor = parseDescriptor(value.descriptor);
  if (!descriptor) {
    return null;
  }
  if (!isHarnessRuntimeStatus(value.status)) {
    return null;
  }
  const sections = Array.isArray(value.sections)
    ? value.sections
      .map((entry) => parseSection(entry))
      .filter((entry): entry is HarnessCatalogSection => Boolean(entry))
    : [];

  return {
    descriptor,
    status: value.status as HarnessRuntimeStatus,
    ...(typeof value.statusDetail === 'string' && value.statusDetail.trim().length > 0
      ? { statusDetail: value.statusDetail.trim() }
      : {}),
    ...(typeof value.version === 'string' && value.version.trim().length > 0
      ? { version: value.version.trim() }
      : {}),
    sections,
  };
}

const parseCatalogArray = (list: unknown[]): HarnessCatalog[] | null => {
  if (list.length === 0) {
    return [];
  }
  const catalogs = list
    .map((entry) => parseHarnessCatalog(entry))
    .filter((entry): entry is HarnessCatalog => Boolean(entry));
  // Every entry malformed ⇒ treat as parse failure, not authoritative empty.
  if (catalogs.length === 0) {
    return null;
  }
  return catalogs;
};

/** Parse GET /api/harness list payload. Returns null exclusively on fetch/parse failure shapes. */
export function parseHarnessCatalogList(payload: unknown): HarnessCatalog[] | null {
  if (Array.isArray(payload)) {
    return parseCatalogArray(payload);
  }
  if (!isRecord(payload)) {
    return null;
  }
  const list = Array.isArray(payload.catalogs)
    ? payload.catalogs
    : Array.isArray(payload.engines)
      ? payload.engines
      : null;
  if (!list) {
    return null;
  }
  return parseCatalogArray(list);
}

export function indexCatalogsById(catalogs: HarnessCatalog[]): Record<HarnessId, HarnessCatalog | undefined> {
  const result: Partial<Record<HarnessId, HarnessCatalog>> = {};
  for (const catalog of catalogs) {
    result[catalog.descriptor.id] = catalog;
  }
  return result as Record<HarnessId, HarnessCatalog | undefined>;
}
