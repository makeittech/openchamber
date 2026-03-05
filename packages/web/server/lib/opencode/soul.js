import fs from 'fs';
import path from 'path';

/**
 * Get the default soul.md path
 * @returns {string} Default path: 'soul.md'
 */
export function getDefaultSoulPath() {
  return 'soul.md';
}

/**
 * Get the configured soul.md path from config
 * @param {Object|null} config - OpenCode configuration object
 * @returns {string} Configured soul path or default
 */
export function getSoulPath(config) {
  if (!config || typeof config !== 'object') {
    return getDefaultSoulPath();
  }

  const soulPath = config?.agents?.defaults?.soulPath;
  
  if (typeof soulPath === 'string' && soulPath.trim().length > 0) {
    return soulPath.trim();
  }

  return getDefaultSoulPath();
}

/**
 * Load soul.md content from workspace
 * @param {string|null} workingDirectory - Working directory path (defaults to current directory)
 * @param {Object|null} config - Optional OpenCode configuration object
 * @returns {{ content: string, path: string }|null} Soul content and path, or null if not found
 */
export function loadSoulMd(workingDirectory = null, config = null) {
  const basePath = workingDirectory || process.cwd();
  const soulRelativePath = getSoulPath(config);
  const soulFullPath = path.resolve(basePath, soulRelativePath);

  if (!fs.existsSync(soulFullPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(soulFullPath, 'utf8');
    return {
      content,
      path: soulFullPath
    };
  } catch (error) {
    console.warn(`Failed to read soul.md at ${soulFullPath}:`, error.message);
    return null;
  }
}
