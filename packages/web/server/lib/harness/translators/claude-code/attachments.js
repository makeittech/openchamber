/**
 * Map OpenChamber attached files → Claude Agent SDK content blocks.
 * Supports data: URLs and sandboxed file:// paths under the project cwd.
 * Rejects opaque binaries; never logs attachment contents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TURN_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const TEXT_LIKE_MIME = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/ld+json',
  'image/svg+xml',
]);

const EXTENSION_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.ts', 'text/plain'],
  ['.tsx', 'text/plain'],
  ['.js', 'text/plain'],
  ['.jsx', 'text/plain'],
  ['.py', 'text/plain'],
  ['.rs', 'text/plain'],
  ['.go', 'text/plain'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.svg', 'image/svg+xml'],
  ['.sh', 'text/x-sh'],
  ['.toml', 'application/toml'],
  ['.xml', 'application/xml'],
]);

/**
 * @typedef {{ mime?: string, url?: string, filename?: string }} AttachedFile
 */

/**
 * Classify a mime type into the block kind it produces, or `null` when the
 * payload is an opaque binary this bridge refuses to forward.
 *
 * @param {string} mime
 * @returns {'image' | 'pdf' | 'text' | null}
 */
function attachmentKind(mime) {
  const normalized = String(mime || '').toLowerCase();
  if (IMAGE_MIME.has(normalized)) return 'image';
  if (normalized === 'application/pdf') return 'pdf';
  if (TEXT_LIKE_MIME.has(normalized) || normalized.startsWith('text/')) return 'text';
  return null;
}

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isSupportedAttachmentMime(mime) {
  return attachmentKind(mime) !== null;
}

/**
 * @param {string} filename
 * @returns {string}
 */
function mimeFromFilename(filename) {
  return EXTENSION_MIME.get(path.extname(String(filename || '')).toLowerCase()) || '';
}

function attachmentError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function trimmedOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * @param {string} dataUrl
 * @returns {{ mime: string, base64: string, bytes: number } | null}
 */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const parts = dataUrl.slice(5, comma).split(';');
  const data = dataUrl.slice(comma + 1);
  const mime = (parts[0] || '').toLowerCase() || 'application/octet-stream';

  if (parts.some((part) => part.trim() === 'base64')) {
    return { mime, base64: data, bytes: Math.floor((data.length * 3) / 4) };
  }
  // Percent-encoded payload — decode to utf-8 then re-encode as base64 for size.
  try {
    const decoded = decodeURIComponent(data);
    return {
      mime,
      base64: Buffer.from(decoded, 'utf8').toString('base64'),
      bytes: Buffer.byteLength(decoded, 'utf8'),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a file:// URL to an absolute filesystem path.
 * @param {string} url
 * @returns {string | null}
 */
function fileUrlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** @param {string} target @returns {string} */
function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    // Missing paths cannot escape the sandbox by symlink; readFileAttachment
    // reports the unreadable case with its own error.
    return target;
  }
}

/**
 * Ensure a resolved path stays inside cwd (project sandbox).
 *
 * Both sides are resolved through realpath first: a symlink placed inside the
 * project that points outside it must not pass the containment check.
 *
 * @param {string} absolutePath
 * @param {string} cwd
 * @returns {string}
 */
export function assertPathInsideCwd(absolutePath, cwd) {
  const resolvedPath = realpathOrSelf(path.resolve(absolutePath));
  const resolvedCwd = realpathOrSelf(path.resolve(cwd));
  const relative = path.relative(resolvedCwd, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Attachment path is outside the project directory');
    error.code = 'ATTACHMENT_PATH_OUTSIDE_CWD';
    error.statusCode = 400;
    throw error;
  }
  return resolvedPath;
}

/**
 * Read a sandboxed on-disk attachment, failing closed on unreadable, non-file,
 * or oversize input.
 *
 * @param {string} absolutePath
 * @param {{ mime?: string, filename?: string, maxBytes?: number, cwd?: string, readFileSync?: typeof fs.readFileSync, statSync?: typeof fs.statSync }} [options]
 * @returns {{ mime: string, base64: string, bytes: number, filename: string, path: string }}
 */
function readFileAttachment(absolutePath, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_ATTACHMENT_BYTES;
  const filename = trimmedOr(options.filename, path.basename(absolutePath));
  const cwd = trimmedOr(options.cwd, '');
  const readFileSync = options.readFileSync || ((filePath) => fs.readFileSync(filePath));
  const statSync = options.statSync || ((filePath) => fs.statSync(filePath));
  const tooLarge = () => attachmentError(`Attachment "${filename}" exceeds max size of ${maxBytes} bytes`, 'ATTACHMENT_TOO_LARGE');

  const resolved = cwd ? assertPathInsideCwd(absolutePath, cwd) : path.resolve(absolutePath);

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw attachmentError(`Attachment "${filename}" could not be read`, 'ATTACHMENT_UNREADABLE');
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw attachmentError(`Attachment "${filename}" is not a file`, 'ATTACHMENT_INVALID');
  }
  if (Number.isFinite(stat.size) && stat.size > maxBytes) throw tooLarge();

  let buffer;
  try {
    buffer = readFileSync(resolved);
  } catch {
    throw attachmentError(`Attachment "${filename}" could not be read`, 'ATTACHMENT_UNREADABLE');
  }
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.byteLength > maxBytes) throw tooLarge();

  return {
    mime: trimmedOr(options.mime, '').toLowerCase() || mimeFromFilename(filename) || 'application/octet-stream',
    base64: buffer.toString('base64'),
    bytes: buffer.byteLength,
    filename,
    path: resolved,
  };
}

/**
 * @param {{ mime: string, base64: string, bytes: number, filename: string }} parsed
 * @returns {{ block: Record<string, unknown>, bytes: number, filename: string }}
 */
function contentBlockFromParsed({ mime, base64, bytes, filename }) {
  const kind = attachmentKind(mime);
  if (!kind) {
    throw attachmentError(`Attachment "${filename}" type "${mime}" is not supported`, 'ATTACHMENT_UNSUPPORTED_TYPE');
  }

  if (kind !== 'text') {
    const mediaType = kind === 'pdf' ? 'application/pdf' : (mime === 'image/jpg' ? 'image/jpeg' : mime);
    return {
      filename,
      bytes,
      block: {
        type: kind === 'pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 },
      },
    };
  }

  // Text-like: decode and send as labeled text (never log contents).
  let text;
  try {
    text = Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    throw attachmentError(`Attachment "${filename}" could not be decoded as text`, 'ATTACHMENT_INVALID');
  }

  return {
    filename,
    bytes,
    block: { type: 'text', text: `Attached file: ${filename}\n\n${text}` },
  };
}

/**
 * @param {AttachedFile} file
 * @param {{ maxBytes?: number, cwd?: string, readFileSync?: typeof fs.readFileSync, statSync?: typeof fs.statSync }} [options]
 * @returns {{ block: Record<string, unknown>, bytes: number, filename: string }}
 */
export function mapAttachmentToContentBlock(file, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_ATTACHMENT_BYTES;
  const filename = trimmedOr(file?.filename, 'attachment');
  const declaredMime = typeof file?.mime === 'string' ? file.mime.toLowerCase() : '';
  const url = typeof file?.url === 'string' ? file.url : '';

  if (!url) {
    throw attachmentError(`Attachment "${filename}" has no url`, 'ATTACHMENT_INVALID');
  }

  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url);
    if (!parsed) {
      throw attachmentError(`Attachment "${filename}" could not be parsed`, 'ATTACHMENT_INVALID');
    }
    if (parsed.bytes > maxBytes) {
      throw attachmentError(`Attachment "${filename}" exceeds max size of ${maxBytes} bytes`, 'ATTACHMENT_TOO_LARGE');
    }
    return contentBlockFromParsed({
      mime: declaredMime || parsed.mime,
      base64: parsed.base64,
      bytes: parsed.bytes,
      filename,
    });
  }

  // file:// URLs, plus bare absolute/relative paths (VS Code and server file
  // pickers sometimes omit the scheme). Both are sandboxed under cwd.
  const isFileUrl = url.startsWith('file:');
  if (isFileUrl || path.isAbsolute(url) || url.startsWith('.')) {
    let absolutePath = null;
    if (isFileUrl) {
      absolutePath = fileUrlToPath(url);
      if (!absolutePath) {
        throw attachmentError(`Attachment "${filename}" file URL could not be parsed`, 'ATTACHMENT_INVALID');
      }
    }
    if (!options.cwd) {
      throw attachmentError(
        `Attachment "${filename}" ${isFileUrl ? 'file URL' : 'path'} requires a project directory`,
        'ATTACHMENT_PATH_REQUIRES_CWD',
      );
    }
    if (!absolutePath) {
      absolutePath = path.isAbsolute(url) ? url : path.resolve(options.cwd, url);
    }
    return contentBlockFromParsed(readFileAttachment(absolutePath, {
      mime: declaredMime,
      filename,
      maxBytes,
      cwd: options.cwd,
      readFileSync: options.readFileSync,
      statSync: options.statSync,
    }));
  }

  throw attachmentError(`Attachment "${filename}" must be a data URL or project file path`, 'ATTACHMENT_UNSUPPORTED_URL');
}

/**
 * Prefer path references for project-local files (spec §11.4) when the
 * attachment is already on disk under cwd — Claude can Read it natively.
 * Clipboard/data URLs remain embedded content blocks.
 *
 * @param {AttachedFile} file
 * @param {string} cwd
 * @returns {string | null} relative path for text reference, or null to embed
 */
function projectPathReference(file, cwd) {
  const url = typeof file?.url === 'string' ? file.url : '';
  let absolute = null;
  if (url.startsWith('file:')) absolute = fileUrlToPath(url);
  else if (path.isAbsolute(url)) absolute = url;
  if (!absolute) return null;
  try {
    const resolved = assertPathInsideCwd(absolute, cwd);
    return path.relative(path.resolve(cwd), resolved) || path.basename(resolved);
  } catch {
    return null;
  }
}

/**
 * @param {AttachedFile[] | undefined | null} files
 * @param {{ maxFileBytes?: number, maxTurnBytes?: number, cwd?: string, preferPathReferences?: boolean, readFileSync?: typeof fs.readFileSync, statSync?: typeof fs.statSync }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function mapAttachmentsToContentBlocks(files, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const maxFileBytes = options.maxFileBytes ?? MAX_ATTACHMENT_BYTES;
  const maxTurnBytes = options.maxTurnBytes ?? MAX_TURN_ATTACHMENT_BYTES;
  const cwd = typeof options.cwd === 'string' ? options.cwd : '';
  const usePathReferences = options.preferPathReferences !== false && Boolean(cwd);
  const blocks = [];
  let total = 0;

  for (const file of files) {
    const relative = usePathReferences ? projectPathReference(file, cwd) : null;
    if (relative) {
      const filename = trimmedOr(file?.filename, path.basename(relative));
      const declaredMime = typeof file?.mime === 'string' ? file.mime.toLowerCase() : '';
      const mime = declaredMime || mimeFromFilename(filename) || mimeFromFilename(relative);
      if (!isSupportedAttachmentMime(mime)) {
        throw attachmentError(`Attachment "${filename}" type "${mime || 'unknown'}" is not supported`, 'ATTACHMENT_UNSUPPORTED_TYPE');
      }
      // Validate readability + size so we fail closed on missing/oversize files.
      readFileAttachment(path.resolve(cwd, relative), {
        mime,
        filename,
        maxBytes: maxFileBytes,
        cwd,
        readFileSync: options.readFileSync,
        statSync: options.statSync,
      });
      blocks.push({ type: 'text', text: `Attached project file: ${relative}` });
      continue;
    }

    const mapped = mapAttachmentToContentBlock(file, {
      maxBytes: maxFileBytes,
      cwd: options.cwd,
      readFileSync: options.readFileSync,
      statSync: options.statSync,
    });
    total += mapped.bytes;
    if (total > maxTurnBytes) {
      throw attachmentError(`Attachments exceed max turn size of ${maxTurnBytes} bytes`, 'ATTACHMENTS_TOO_LARGE');
    }
    blocks.push(mapped.block);
  }
  return blocks;
}
