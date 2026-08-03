import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseModelRef } from '../small-model/resolve.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const CURSOR_API_VERSIONS = new Set(['v0', 'v1']);
const DEFAULT_CURSOR_API_VERSION = 'v0';

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

function readSettingsFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
  } catch {
    // ignore
  }
  return {};
}

function writeSettingsFile(settings) {
  ensureStorageDir();
  const tmpFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, SETTINGS_FILE);
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch {
    // best-effort
  }
}

function getEnvCursorApiVersion() {
  const value = typeof process.env.OPENCHAMBER_CURSOR_API_VERSION === 'string'
    ? process.env.OPENCHAMBER_CURSOR_API_VERSION.trim()
    : '';
  if (!value) return null;
  return CURSOR_API_VERSIONS.has(value) ? value : DEFAULT_CURSOR_API_VERSION;
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function getTrackedRepos() {
  const settings = readSettingsFile();
  const repos = Array.isArray(settings.workqueueRepos) ? settings.workqueueRepos : [];
  return repos.filter((repo) => typeof repo === 'string' && REPO_PATTERN.test(repo));
}

export function setTrackedRepos(repos) {
  const next = Array.isArray(repos)
    ? Array.from(new Set(repos.filter((repo) => typeof repo === 'string' && REPO_PATTERN.test(repo))))
    : [];
  const settings = readSettingsFile();
  settings.workqueueRepos = next;
  writeSettingsFile(settings);
  return next;
}

export function getCursorApiVersion() {
  const envVersion = getEnvCursorApiVersion();
  if (envVersion) return envVersion;

  const settings = readSettingsFile();
  return CURSOR_API_VERSIONS.has(settings.cursorApiVersion)
    ? settings.cursorApiVersion
    : DEFAULT_CURSOR_API_VERSION;
}

export function isCursorApiVersionConfiguredViaEnv() {
  return Boolean(getEnvCursorApiVersion());
}

export function setCursorApiVersion(version) {
  if (!CURSOR_API_VERSIONS.has(version)) {
    throw new Error('cursorApiVersion must be v0 or v1');
  }

  const settings = readSettingsFile();
  settings.cursorApiVersion = version;
  writeSettingsFile(settings);
  return version;
}

// User-authored text (Settings > AI Workflow) that is always appended to the
// hardcoded prompts in analysis.js/routes.js, never a replacement for them.
export function getWorkQueuePromptSettings() {
  const settings = readSettingsFile();
  return {
    analysisPromptExtra: typeof settings.workqueueAnalysisPromptExtra === 'string' ? settings.workqueueAnalysisPromptExtra : '',
    alreadySolvedPromptExtra: typeof settings.workqueueAlreadySolvedPromptExtra === 'string' ? settings.workqueueAlreadySolvedPromptExtra : '',
    remoteAgentPromptSuffix: typeof settings.workqueueRemoteAgentPromptSuffix === 'string' ? settings.workqueueRemoteAgentPromptSuffix : '',
  };
}

export function setWorkQueuePromptSettings(patch) {
  const settings = readSettingsFile();
  if (typeof patch?.analysisPromptExtra === 'string') settings.workqueueAnalysisPromptExtra = patch.analysisPromptExtra;
  if (typeof patch?.alreadySolvedPromptExtra === 'string') settings.workqueueAlreadySolvedPromptExtra = patch.alreadySolvedPromptExtra;
  if (typeof patch?.remoteAgentPromptSuffix === 'string') settings.workqueueRemoteAgentPromptSuffix = patch.remoteAgentPromptSuffix;
  writeSettingsFile(settings);
  return getWorkQueuePromptSettings();
}

export function getAnalysisPromptExtra() {
  return getWorkQueuePromptSettings().analysisPromptExtra;
}

export function getAlreadySolvedPromptExtra() {
  return getWorkQueuePromptSettings().alreadySolvedPromptExtra;
}

export function getRemoteAgentPromptSuffix() {
  return getWorkQueuePromptSettings().remoteAgentPromptSuffix;
}

// The default model used for AI analysis (Settings > AI Workflow, and the
// "set as default" action in the issue detail panel). Empty means analysis
// stays on the small-model module's normal auto-resolution chain — it is
// never hardcoded to one provider — rather than a required override.
export function getWorkQueueAnalysisModel() {
  const settings = readSettingsFile();
  return typeof settings.workqueueAnalysisModel === 'string' ? settings.workqueueAnalysisModel : '';
}

export function setWorkQueueAnalysisModel(model) {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  const settings = readSettingsFile();
  if (trimmed && parseModelRef(trimmed)) {
    settings.workqueueAnalysisModel = trimmed;
  } else {
    delete settings.workqueueAnalysisModel;
  }
  writeSettingsFile(settings);
  return getWorkQueueAnalysisModel();
}
