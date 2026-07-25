import type {
  CapabilityLevel,
  EngineCatalog,
  EngineCatalogModel,
  EngineCatalogSection,
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
  if (
    value === 'subscription-cli'
    || value === 'opencode-providers'
    || value === 'subscription-oauth'
  ) {
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

const parseModel = (value: unknown): EngineCatalogModel | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    return null;
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return null;
  }
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    ...(typeof value.supportsImages === 'boolean' ? { supportsImages: value.supportsImages } : {}),
    ...(typeof value.supportsDocuments === 'boolean' ? { supportsDocuments: value.supportsDocuments } : {}),
  };
};

const parseSection = (value: unknown): EngineCatalogSection | null => {
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
    .filter((entry): entry is EngineCatalogModel => Boolean(entry));
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    kind: value.kind,
    models,
  };
};

/** Parse one engine catalog object from server JSON. Returns null on malformed payload. */
export function parseEngineCatalog(value: unknown): EngineCatalog | null {
  if (!isRecord(value)) {
    return null;
  }
  const engine = parseDescriptor(value.engine);
  if (!engine) {
    return null;
  }
  if (!isHarnessRuntimeStatus(value.status)) {
    return null;
  }
  const sections = Array.isArray(value.sections)
    ? value.sections
      .map((entry) => parseSection(entry))
      .filter((entry): entry is EngineCatalogSection => Boolean(entry))
    : [];

  return {
    engine,
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

const parseCatalogArray = (list: unknown[]): EngineCatalog[] | null => {
  if (list.length === 0) {
    return [];
  }
  const catalogs = list
    .map((entry) => parseEngineCatalog(entry))
    .filter((entry): entry is EngineCatalog => Boolean(entry));
  // Every entry malformed ⇒ treat as parse failure, not authoritative empty.
  if (catalogs.length === 0) {
    return null;
  }
  return catalogs;
};

/** Parse GET /api/harness list payload. Returns null exclusively on fetch/parse failure shapes. */
export function parseEngineCatalogList(payload: unknown): EngineCatalog[] | null {
  if (Array.isArray(payload)) {
    return parseCatalogArray(payload);
  }
  if (!isRecord(payload)) {
    return null;
  }
  const list = Array.isArray(payload.engines)
    ? payload.engines
    : Array.isArray(payload.catalogs)
      ? payload.catalogs
      : null;
  if (!list) {
    return null;
  }
  return parseCatalogArray(list);
}

export function indexCatalogsById(catalogs: EngineCatalog[]): Record<HarnessId, EngineCatalog | undefined> {
  const result: Partial<Record<HarnessId, EngineCatalog>> = {};
  for (const catalog of catalogs) {
    result[catalog.engine.id] = catalog;
  }
  return result as Record<HarnessId, EngineCatalog | undefined>;
}
