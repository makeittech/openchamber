import type {
  CapabilityLevel,
  HarnessCatalog,
  HarnessCatalogModel,
  HarnessCatalogSection,
  HarnessAuthMode,
  HarnessCapability,
  HarnessDescriptor,
  HarnessId,
} from '@/types/harness';
import {
  HARNESS_CAPABILITIES,
  isCapabilityLevel,
  isHarnessId,
  isHarnessRuntimeStatus,
} from '@/types/harness';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const isPresent = <T>(entry: T | null): entry is T => entry !== null;

const parseAuthMode = (value: unknown): HarnessAuthMode | null =>
  (value === 'subscription-cli' || value === 'opencode-providers' ? value : null);

const parseCapabilities = (value: unknown): Record<HarnessCapability, CapabilityLevel> | null => {
  if (!isRecord(value)) return null;
  const result = {} as Record<HarnessCapability, CapabilityLevel>;
  for (const capability of HARNESS_CAPABILITIES) {
    const level = value[capability];
    if (!isCapabilityLevel(level)) return null;
    result[capability] = level;
  }
  return result;
};

const parseDescriptor = (value: unknown): HarnessDescriptor | null => {
  if (!isRecord(value)) return null;
  if (!isHarnessId(value.id)) return null;
  const displayName = nonEmptyString(value.displayName);
  const shortName = nonEmptyString(value.shortName);
  if (!displayName || !shortName) return null;
  const auth = isRecord(value.auth) ? parseAuthMode(value.auth.mode) : null;
  if (!auth) return null;
  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities) return null;
  if (!isRecord(value.install)) return null;
  const binaryNames = Array.isArray(value.install.binaryNames)
    ? value.install.binaryNames.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  const docsUrl = nonEmptyString(value.install.docsUrl);
  if (!docsUrl) return null;
  const minVersion = typeof value.install.minVersion === 'string' ? value.install.minVersion : undefined;

  return {
    id: value.id,
    displayName,
    shortName,
    auth: { mode: auth },
    capabilities,
    install: {
      binaryNames,
      docsUrl,
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
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  if (!id || !name) return null;

  const limitRecord = isRecord(value.limit) ? value.limit : null;
  const context = limitRecord ? parsePositiveNumber(limitRecord.context) : undefined;
  const output = limitRecord ? parsePositiveNumber(limitRecord.output) : undefined;
  const modalitiesRecord = isRecord(value.modalities) ? value.modalities : null;
  const inputModalities = modalitiesRecord ? parseStringList(modalitiesRecord.input) : undefined;
  const outputModalities = modalitiesRecord ? parseStringList(modalitiesRecord.output) : undefined;

  return {
    id,
    name,
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
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  if (!id || !name) return null;
  if (value.kind !== 'provider' && value.kind !== 'profile' && value.kind !== 'models') return null;
  if (!Array.isArray(value.models)) return null;
  return {
    id,
    name,
    kind: value.kind,
    models: value.models.map((entry) => parseModel(entry)).filter(isPresent),
  };
};

export function parseHarnessCatalog(value: unknown): HarnessCatalog | null {
  if (!isRecord(value)) return null;
  const descriptor = parseDescriptor(value.descriptor);
  if (!descriptor) return null;
  if (!isHarnessRuntimeStatus(value.status)) return null;
  const sections = Array.isArray(value.sections)
    ? value.sections.map((entry) => parseSection(entry)).filter(isPresent)
    : [];
  const statusDetail = nonEmptyString(value.statusDetail);
  const version = nonEmptyString(value.version);

  return {
    descriptor,
    status: value.status,
    ...(statusDetail ? { statusDetail } : {}),
    ...(version ? { version } : {}),
    sections,
  };
}

/** An empty list is authoritative; a non-empty list that parses to nothing is a failure. */
const parseCatalogArray = (list: unknown[]): HarnessCatalog[] | null => {
  if (list.length === 0) return [];
  const catalogs = list.map((entry) => parseHarnessCatalog(entry)).filter(isPresent);
  return catalogs.length > 0 ? catalogs : null;
};

export function parseHarnessCatalogList(payload: unknown): HarnessCatalog[] | null {
  if (Array.isArray(payload)) return parseCatalogArray(payload);
  if (!isRecord(payload)) return null;
  if (Array.isArray(payload.catalogs)) return parseCatalogArray(payload.catalogs);
  if (Array.isArray(payload.engines)) return parseCatalogArray(payload.engines);
  return null;
}

export function indexCatalogsById(catalogs: HarnessCatalog[]): Record<HarnessId, HarnessCatalog | undefined> {
  const result: Partial<Record<HarnessId, HarnessCatalog>> = {};
  for (const catalog of catalogs) {
    result[catalog.descriptor.id] = catalog;
  }
  return result as Record<HarnessId, HarnessCatalog | undefined>;
}
