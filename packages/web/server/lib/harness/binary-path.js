/**
 * PATH binary lookup for harness detect / Claude executable resolution.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} binaryName
 * @param {string} [searchPath]
 * @returns {string | null}
 */
export function findBinaryOnPath(binaryName, searchPath = process.env.PATH || '') {
  const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
  if (!trimmed) return null;

  const parts = searchPath.split(path.delimiter).filter(Boolean);
  const candidateNames = [];

  if (process.platform === 'win32' && !path.extname(trimmed)) {
    const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    for (const ext of pathExt.split(';')) {
      const normalizedExt = ext.trim();
      if (!normalizedExt) continue;
      const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
      if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
        candidateNames.push(candidateName);
      }
    }
  }
  candidateNames.push(trimmed);

  for (const dir of parts) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}
