import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSoulMd, getSoulPath, getDefaultSoulPath } from './soul.js';

describe('Soul Module', () => {
  let tempDir;
  let originalCwd;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-test-'));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getDefaultSoulPath', () => {
    it('should return default soul.md path', () => {
      const soulPath = getDefaultSoulPath();
      assert.strictEqual(soulPath, 'soul.md');
    });
  });

  describe('getSoulPath', () => {
    it('should return default path when no config provided', () => {
      const soulPath = getSoulPath(null);
      assert.strictEqual(soulPath, 'soul.md');
    });

    it('should return default path when config has no soulPath', () => {
      const soulPath = getSoulPath({});
      assert.strictEqual(soulPath, 'soul.md');
    });

    it('should return configured soulPath from agents.defaults', () => {
      const config = {
        agents: {
          defaults: {
            soulPath: 'custom-soul.md'
          }
        }
      };
      const soulPath = getSoulPath(config);
      assert.strictEqual(soulPath, 'custom-soul.md');
    });

    it('should handle nested paths', () => {
      const config = {
        agents: {
          defaults: {
            soulPath: 'docs/soul.md'
          }
        }
      };
      const soulPath = getSoulPath(config);
      assert.strictEqual(soulPath, 'docs/soul.md');
    });
  });

  describe('loadSoulMd', () => {
    it('should return null when soul.md does not exist', () => {
      const result = loadSoulMd(tempDir);
      assert.strictEqual(result, null);
    });

    it('should load soul.md from workspace root', () => {
      const soulContent = '# Agent Soul\n\nThis defines the agent\'s core values.';
      fs.writeFileSync(path.join(tempDir, 'soul.md'), soulContent);

      const result = loadSoulMd(tempDir);
      assert.ok(result !== null);
      assert.strictEqual(result.content, soulContent);
      assert.strictEqual(result.path, path.join(tempDir, 'soul.md'));
    });

    it('should load soul.md from custom path', () => {
      const customPath = 'custom/soul.md';
      const soulContent = '# Custom Soul\n\nCustom instructions.';
      const customDir = path.join(tempDir, 'custom');
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, customPath), soulContent);

      const config = {
        agents: {
          defaults: {
            soulPath: customPath
          }
        }
      };

      const result = loadSoulMd(tempDir, config);
      assert.ok(result !== null);
      assert.strictEqual(result.content, soulContent);
      assert.strictEqual(result.path, path.join(tempDir, customPath));
    });

    it('should return null for non-existent custom path', () => {
      const config = {
        agents: {
          defaults: {
            soulPath: 'non-existent.md'
          }
        }
      };

      const result = loadSoulMd(tempDir, config);
      assert.strictEqual(result, null);
    });

    it('should handle empty soul.md file', () => {
      fs.writeFileSync(path.join(tempDir, 'soul.md'), '');

      const result = loadSoulMd(tempDir);
      assert.ok(result !== null);
      assert.strictEqual(result.content, '');
    });

    it('should handle soul.md with whitespace only', () => {
      fs.writeFileSync(path.join(tempDir, 'soul.md'), '   \n\n   ');

      const result = loadSoulMd(tempDir);
      assert.ok(result !== null);
      assert.strictEqual(result.content, '   \n\n   ');
    });

    it('should work without working directory', () => {
      process.chdir(tempDir);
      const soulContent = '# Soul\n\nContent.';
      fs.writeFileSync(path.join(tempDir, 'soul.md'), soulContent);

      const result = loadSoulMd();
      assert.ok(result !== null);
      assert.strictEqual(result.content, soulContent);
    });
  });
});
